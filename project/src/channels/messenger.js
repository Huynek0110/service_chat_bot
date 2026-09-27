import express from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger, logError } from '../services/logger.js';
import { isProcessed, markProcessed } from '../core/dedup.js';
import { isHandoffActive } from '../core/handoff.js';
import { getOrCreateCustomer } from '../core/customer.js';
import { saveMessage } from '../core/history.js';
import { allow } from '../services/rateLimiter.js';
import { sendMessage, senderAction } from '../services/messengerApi.js';

export const messengerRouter = express.Router();

const SLOW_DOWN_TEXT =
  'Bạn nhắn hơi nhanh, vui lòng chờ vài giây rồi thử lại nhé.';
const NON_TEXT_GUIDANCE_TEXT =
  'Mình hiện hỗ trợ tin nhắn văn bản. Bạn vui lòng nhập nội dung cần hỗ trợ nhé.';

// Webhook verification (Meta GET handshake).
messengerRouter.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.messengerVerifyToken) {
    return res.status(200).send(challenge ?? '');
  }
  return res.sendStatus(403);
});

function verifySignature(rawBody, signature) {
  if (!signature || typeof signature !== 'string') return false;
  const secret = config.messengerAppSecret || '';
  const expected =
    'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

let skipDedupCounter = 0;

async function handleMessagingEvent(event) {
  const senderId = event?.sender?.id;
  if (senderId === undefined || senderId === null || senderId === '') return;
  const senderIdStr = String(senderId);

  // Ignore our own echoes to avoid reply loops.
  if (event?.message?.is_echo) return;

  // Ignore non-actionable events BEFORE dedup/reply: silent, no sendMessage.
  if (event?.delivery || event?.read || event?.optin || event?.referral) return;

  // Only message-with-text, postback, quick_reply, attachment proceed.
  // Anything else (unknown/unsupported events) is ignored silently.
  const text = event?.message?.text;
  const hasText = typeof text === 'string' && text.trim().length > 0;
  const hasAttachment = Boolean(event?.message?.attachments);
  const hasQuickReply = Boolean(event?.message?.quick_reply);
  const hasPostback = Boolean(event?.postback);
  if (!hasText && !hasAttachment && !hasQuickReply && !hasPostback) return;

  const timestamp = event?.timestamp;
  const mid = event?.message?.mid || event?.postback?.mid || null;
  const tsUsable =
    (typeof timestamp === 'number' && Number.isFinite(timestamp)) ||
    (typeof timestamp === 'string' && timestamp.trim() !== '');
  let eventId;
  let skipDedup = false;
  if (mid) {
    eventId = mid;
  } else if (tsUsable) {
    eventId = `${senderIdStr}:${String(timestamp)}`;
  } else {
    // No usable mid/timestamp: process once, SKIP dedup entirely (don't store).
    skipDedup = true;
    eventId = `skip-dedup-${senderIdStr}-${skipDedupCounter++}-${Date.now()}`;
  }

  // Dedup: skip already-processed events.
  if (!skipDedup) {
    try {
      if (isProcessed(eventId)) return;
    } catch {
      return;
    }
    try {
      markProcessed(eventId);
    } catch {
      // markProcessed never throws; ignore defensively.
    }
  }

  // Ensure customer row exists.
  try {
    getOrCreateCustomer('messenger', senderIdStr);
  } catch (err) {
    logError('messenger getOrCreateCustomer failed', err);
  }

  // Rate limit: polite slow-down and skip AI on overflow.
  let allowed = true;
  try {
    allowed = allow(senderIdStr);
  } catch {
    allowed = true;
  }
  if (!allowed) {
    try {
      await sendMessage(senderIdStr, SLOW_DOWN_TEXT);
    } catch (err) {
      logError('messenger slow-down reply failed', err);
    }
    return;
  }

  try {
    await senderAction(senderIdStr, 'typing_on');
  } catch {
    // Best effort; continue even if typing indicator fails.
  }

  try {
    const isTextMessage =
      hasText && !hasAttachment && !hasQuickReply && !hasPostback;

    if (isTextMessage) {
      let handoff = false;
      try {
        handoff = isHandoffActive('messenger', senderIdStr);
      } catch {
        handoff = false;
      }

      if (handoff) {
        // Human agent is handling this user: persist the message, skip AI reply.
        try {
          saveMessage('messenger', senderIdStr, 'user', text);
        } catch (err) {
          logError('messenger handoff saveMessage failed', err);
        }
        return;
      }

      // Dynamic import to avoid require cycles with chatEngine.
      const { handleIncomingMessage } = await import('../core/chatEngine.js');
      const reply = await handleIncomingMessage({
        channel: 'messenger',
        userId: senderIdStr,
        text,
        eventId,
        metadata: { senderId: senderIdStr, timestamp },
      });
      if (reply) {
        await sendMessage(senderIdStr, String(reply));
      }
    } else {
      // Postback / attachments / quick_reply / other non-text events: no AI.
      await sendMessage(senderIdStr, NON_TEXT_GUIDANCE_TEXT);
    }
  } catch (err) {
    logError('messenger event handling failed', err);
    try {
      await sendMessage(senderIdStr, config.fallbackErrorMessage);
    } catch (sendErr) {
      logError('messenger fallback reply failed', sendErr);
    }
  } finally {
    try {
      await senderAction(senderIdStr, 'typing_off');
    } catch {
      // Best effort.
    }
  }
}

async function processWebhookPayload(payload) {
  try {
    const entries = Array.isArray(payload?.entry) ? payload.entry : [];
    for (const entry of entries) {
      const messagings = Array.isArray(entry?.messaging) ? entry.messaging : [];
      for (const event of messagings) {
        try {
          await handleMessagingEvent(event);
        } catch (err) {
          logError('messenger per-event failure', err);
        }
      }
    }
  } catch (err) {
    logError('messenger payload processing failed', err);
  }
}

// Incoming webhook events. Raw body is required for signature verification,
// so this route applies express.raw internally.
messengerRouter.post(
  '/',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    // server.js mounts express.raw() for /webhook/messenger BEFORE express.json(),
    // so the body must still be a Buffer here. Never re-encode parsed JSON via
    // JSON.stringify — different bytes would break HMAC verification.
    if (!Buffer.isBuffer(req.body)) {
      return res.sendStatus(400);
    }
    const rawBody = req.body;

    const signature =
      req.get('X-Hub-Signature-256') ?? req.headers['x-hub-signature-256'];
    if (!verifySignature(rawBody, Array.isArray(signature) ? signature[0] : signature)) {
      return res.sendStatus(401);
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.sendStatus(400);
    }

    if (!payload || payload.object !== 'page') {
      return res.sendStatus(200);
    }

    // ACK immediately; process asynchronously so Meta never times out.
    res.status(200).send('EVENT_RECEIVED');
    setImmediate(() => {
      processWebhookPayload(payload).catch((err) => {
        try {
          logger.error('messenger async processing failed', {
            error: err?.message,
          });
        } catch {
          // Never throw out of the async boundary.
        }
      });
    });
  }
);
