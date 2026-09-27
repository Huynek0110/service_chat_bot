import { Telegraf, Markup } from 'telegraf';
import { readFileSync, existsSync } from 'fs';
import { config } from '../config.js';
import { logger, logError } from '../services/logger.js';
import { getOrCreateCustomer } from '../core/customer.js';
import { isProcessed, markProcessed } from '../core/dedup.js';
import { isHandoffActive } from '../core/handoff.js';
import { saveMessage } from '../core/history.js';
import { allow } from '../services/rateLimiter.js';
import { getUnannouncedOrder, markAnnounced, claimPaid } from '../orders/orders.js';
import { getSetting } from '../orders/stock.js';
import { getDb } from '../db/migrate.js';

const SLOW_DOWN_TEXT = 'Bạn đang gửi tin nhắn quá nhanh. Vui lòng chờ một chút rồi thử lại nhé.';
const NON_TEXT_TEXT = 'Mình hiện chỉ hỗ trợ tin nhắn văn bản. Bạn gõ câu hỏi giúp mình nhé.';

let bot = null;

// Channel status for /health (plain data, safe to expose).
const tgStatus = { enabled: false, connected: false, username: null, error: null };

export function getTelegramStatus() {
  return { ...tgStatus };
}

async function handleTextMessage(ctx, text) {
  const chatId = String(ctx.chat.id);
  const updateId = ctx.update?.update_id;

  // Display name for customer record ONLY (never fed to the LLM: profile
  // names are user-controlled and must not become trusted prompt content).
  const rawName =
    [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') ||
    (ctx.from?.username ? `@${ctx.from.username}` : undefined);
  const displayName =
    typeof rawName === 'string' ? rawName.replace(/[\r\n]/g, ' ').slice(0, 200) : undefined;

  // Dedup on Telegram update_id (retries/redeliveries happen).
  const eventId = typeof updateId === 'number' ? `tg:${updateId}` : null;
  if (eventId) {
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

  try {
    getOrCreateCustomer('telegram', chatId, displayName);
  } catch (err) {
    logError('telegram getOrCreateCustomer failed', err);
  }

  let allowed = true;
  try {
    allowed = allow(`tg:${chatId}`);
  } catch {
    allowed = true;
  }
  if (!allowed) {
    try {
      await ctx.reply(SLOW_DOWN_TEXT);
    } catch (err) {
      logError('telegram slow-down reply failed', err);
    }
    return;
  }

  try {
    await ctx.sendChatAction('typing');
  } catch {
    // Best effort; continue even if typing indicator fails.
  }

  try {
    let handoff = false;
    try {
      handoff = isHandoffActive('telegram', chatId);
    } catch {
      handoff = false;
    }

    if (handoff) {
      // Human agent is handling this user: persist the message, skip AI reply.
      try {
        saveMessage('telegram', chatId, 'user', text);
      } catch (err) {
        logError('telegram handoff saveMessage failed', err);
      }
      return;
    }

    // Dynamic import to avoid require cycles with chatEngine.
    const { handleIncomingMessage } = await import('../core/chatEngine.js');
    const reply = await handleIncomingMessage({
      channel: 'telegram',
      userId: chatId,
      text,
      eventId: eventId || `tg:${chatId}:${Date.now()}`,
      metadata: { chatId, updateId },
    });
    if (reply) {
      await sendLongReply(chatId, String(reply));
    }

    // Buyer order flow: if the agent just created an order, send the QR bundle.
    // Never crashes the main flow — all wrapped in try/catch.
    try {
      const pending = getUnannouncedOrder('telegram', chatId);
      if (pending) {
        let productRow = null;
        try {
          productRow = getDb()
            .prepare('SELECT qr_image_path, acc_file, name FROM products WHERE id = ?')
            .get(pending.product_id);
        } catch {
          productRow = null;
        }
        let qrPath = '';
        try {
          qrPath = productRow?.qr_image_path || getSetting('payment_qr_path', '');
        } catch {
          qrPath = productRow?.qr_image_path || '';
        }
        let qrBytes = null;
        try {
          if (qrPath && existsSync(qrPath)) {
            qrBytes = readFileSync(qrPath);
          }
        } catch (err) {
          logError('telegram order QR read failed', err);
        }
        const priceText = Number(pending.price).toLocaleString('vi-VN');
        const productName = productRow?.name || pending.sku || '';
        if (qrBytes) {
          try {
            await ctx.replyWithPhoto(
              { source: qrBytes },
              { caption: `Quét mã để thanh toán ${priceText}đ\nNội dung: ${pending.order_code}\nSản phẩm: ${productName}` }
            );
          } catch (err) {
            logError('telegram order QR photo failed', err);
          }
        } else {
          try {
            await ctx.reply(
              'Shop chưa cấu hình mã QR thanh toán, bạn vui lòng chờ admin gửi QR nhé. Đơn của bạn vẫn được giữ lại.'
            );
          } catch (err) {
            logError('telegram order QR missing notice failed', err);
          }
        }
        try {
          await ctx.reply(
            `Đơn ${pending.order_code}: ${productName} — ${priceText}đ\nVui lòng chuyển khoản đúng số tiền với nội dung: ${pending.order_code}\nSau khi chuyển xong, bấm nút "Đã giao dịch" bên dưới nhé.`,
            Markup.inlineKeyboard([Markup.button.callback('Đã giao dịch', `order_paid:${pending.id}`)])
          );
        } catch (err) {
          logError('telegram order code reply failed', err);
        }
        try {
          markAnnounced(pending.id);
        } catch (err) {
          logError('telegram markAnnounced failed', err);
        }
      }
    } catch (err) {
      logError('telegram order bundle failed', err);
    }
  } catch (err) {
    logError('telegram event handling failed', err);
    try {
      await sendLongReply(chatId, config.fallbackErrorMessage);
    } catch (sendErr) {
      logError('telegram fallback reply failed', sendErr);
    }
  }
}

export function getTelegramBot() {
  return bot;
}

// The model writes Markdown by habit (`**bold**`, `_italic_`, ```code```), but
// Telegram only renders a small HTML subset and silently prints anything else
// verbatim — which is how customers ended up seeing literal `**Tồn kho:**`.
// Translate the handful of markers the model actually emits, and HTML-escape
// everything else first so a stray `<` in a product name cannot break the parse.
//
// Markdown tables are not supported by Telegram at all. They get flattened into
// aligned monospace lines, which is far more readable than raw pipes.
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderTableRow(line) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c !== '')
    .join('  ·  ');
}

function mdToTelegramHtml(text) {
  const lines = String(text).split('\n');
  const out = [];
  let inCode = false;
  let inTable = false;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const fence = line.match(/^\s*```/);

    if (fence) {
      out.push(inCode ? '</code>' : '<code>');
      inCode = !inCode;
      inTable = false;
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(line));
      continue;
    }

    // A table row is a line that is mostly pipes; the separator row (|---|---|
    // or |:--:|) is dropped because it carries no information.
    const isPipeHeavy = (line.match(/\|/g) || []).length >= 2;
    if (isPipeHeavy) {
      if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line)) continue; // separator
      out.push(renderTableRow(line));
      inTable = true;
      continue;
    }
    if (inTable && line.trim() === '') {
      inTable = false;
    }

    let html = escapeHtml(line);

    // Inline code first so ** inside a code span is left alone.
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold, then italic. Handles the ***bold italic*** overlap by processing
    // bold first and letting the leftover asterisks fall through to italic.
    html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, '$1<i>$2</i>');
    html = html.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1<i>$2</i>');
    // Bullets: the model prefers • and -, Telegram renders a real list only for
    // a leading emoji, so normalise to a bullet char.
    html = html.replace(/^(\s*)[-*]\s+/, '$1• ');

    out.push(html);
  }

  if (inCode) out.push('</code>');
  return out.join('\n');
}

// Sends via bot.telegram directly (not ctx.reply) so the reply still goes
// out even if the Telegraf handler already timed out on a slow model.
// Telegram message limit is 4096 chars; Array.from chunks by code point
// so emoji/surrogate pairs survive the split.
async function sendLongReply(chatId, text) {
  if (!bot) throw new Error('Telegram bot not started');
  const html = mdToTelegramHtml(text);
  const out = Array.from(html);
  for (let i = 0; i < out.length; i += 4000) {
    const chunk = out.slice(i, i + 4000).join('');
    try {
      await bot.telegram.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
    } catch (err) {
      // Telegram rejects the whole message on unbalanced tags. Rather than lose
      // the reply, fall back to escaped plain text — ugly but never silent.
      logger.error('telegram HTML send failed, falling back to plain text', {
        error: err && err.message,
      });
      await bot.telegram.sendMessage(chatId, String(text));
    }
  }
}

export async function startTelegram() {
  if (!config.telegramEnabled) {
    logger.info('Telegram channel disabled (TELEGRAM_ENABLED=false), skipping');
    return null;
  }
  if (!config.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required when TELEGRAM_ENABLED=true');
  }
  if (bot) return bot;

  // handlerTimeout: model local có thể suy nghĩ >90s (mặc định của Telegraf),
  // nhất là khi GPU bận. Nâng lên 5 phút; reply AI gửi qua bot.telegram
  // trực tiếp nên sống sót kể cả khi handler bị timeout.
  bot = new Telegraf(config.telegramBotToken, { handlerTimeout: 300_000 });

  bot.start(async (ctx) => {
    // /start: clean static greeting through the normal AI pipeline so the
    // first-message disclosure applies. Display name stays in the DB record
    // only (see handleTextMessage) — never interpolated into LLM input.
    await handleTextMessage(ctx, 'Xin chào');
  });

  bot.on('text', async (ctx) => {
    const text = ctx.message?.text;
    if (typeof text !== 'string' || text.trim().length === 0) return;
    // /start (incl. /start@BotName and /start <deep-link>) is owned by the
    // bot.start handler above; other /commands flow to the AI as plain text.
    const t = text.trim();
    if (t === '/start' || t.startsWith('/start@') || t.startsWith('/start ')) return;
    await handleTextMessage(ctx, text);
  });

  // Non-text content: polite guidance, no AI. Dedup + rate-limit apply here
  // too so redelivered attachments can't spam.
  bot.on(
    ['photo', 'document', 'sticker', 'voice', 'video', 'audio', 'video_note', 'animation', 'location', 'contact'],
    async (ctx) => {
      const updateId = ctx.update?.update_id;
      const eventId = typeof updateId === 'number' ? `tg:${updateId}:media` : null;
      if (eventId) {
        try {
          if (isProcessed(eventId)) return;
          markProcessed(eventId);
        } catch {
          return;
        }
      }
      let allowed = true;
      try {
        allowed = allow(`tg:${String(ctx.chat.id)}:media`);
      } catch {
        allowed = true;
      }
      if (!allowed) return;
      try {
        await ctx.reply(NON_TEXT_TEXT);
      } catch (err) {
        logError('telegram non-text reply failed', err);
      }
    }
  );

  bot.action(/^order_paid:(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
    } catch {
      // Best effort; continue even if dismissing the loading state fails.
    }
    try {
      // Callback queries carry their own update_id — the text-path dedup
      // does not cover bot.action, so dedup here with a :cb key.
      const updateId = ctx.update?.update_id;
      const cbKey = typeof updateId === 'number' ? `tg:${updateId}:cb` : null;
      if (cbKey) {
        try {
          if (isProcessed(cbKey)) return;
        } catch {
          return;
        }
        try {
          markProcessed(cbKey);
        } catch {
          // markProcessed never throws; ignore defensively.
        }
      }
      const orderId = Number(ctx.match?.[1]);
      const cbChatId = String(ctx.chat.id);
      const res = claimPaid(orderId, cbChatId);
      if (res?.ok) {
        await ctx.reply(
          `Đã ghi nhận đơn ${res.order.order_code}! Shop sẽ kiểm tra và giao acc cho bạn ngay sau khi xác minh.`
        );
      } else if (res?.reason === 'not_owner') {
        await ctx.reply('Nút này không thuộc về bạn, bạn vui lòng tạo đơn của riêng mình nhé.');
      } else {
        await ctx.reply('Đơn này không còn hiệu lực.');
      }
    } catch (err) {
      logError('telegram order_paid action failed', err);
      try {
        await ctx.reply('Đơn này không còn hiệu lực.');
      } catch {
        // Best effort.
      }
    }
  });

  bot.catch((err) => {
    logError('telegram bot error', err instanceof Error ? err : new Error(String(err)));
  });

  // Long polling: no public HTTPS/webhook needed.
  tgStatus.enabled = true;
  try {
    await bot.launch();
  } catch (err) {
    tgStatus.error = err instanceof Error ? err.message : String(err);
    throw err;
  }
  // Telegraf launch() already fetched bot info internally — reuse it instead
  // of a second getMe roundtrip on every boot.
  tgStatus.connected = true;
  tgStatus.username = bot.botInfo?.username || null;
  if (tgStatus.username) {
    logger.info(`Telegram bot connected as @${tgStatus.username} (long-polling)`);
  } else {
    logger.info('Telegram bot launched (long-polling)');
  }
  return bot;
}

export async function stopTelegram() {
  if (bot) {
    try {
      bot.stop('shutdown');
    } catch {
      // Best effort.
    }
    bot = null;
  }
  tgStatus.connected = false;
}
