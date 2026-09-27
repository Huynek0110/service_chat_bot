import { config } from '../config.js';

const GRAPH_BASE = 'https://graph.facebook.com/v20.0';
const VALID_SENDER_ACTIONS = ['typing_on', 'typing_off', 'mark_seen'];
const MAX_TEXT_LENGTH = 2000;

function getEndpoint() {
  const token = config.messengerPageAccessToken;
  if (!token) {
    throw new Error('Messenger Page Access Token is not configured');
  }
  // Standard Send API endpoint: the page is resolved from the access token,
  // so no Page ID is embedded in the URL.
  // Token stays only in the request URL; never include it in logs or errors.
  return `${GRAPH_BASE}/me/messages?access_token=${encodeURIComponent(token)}`;
}

async function postToGraph(payload) {
  const url = getEndpoint();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch {
      bodyText = '';
    }
    throw new Error(
      `Messenger API error ${response.status}: ${String(bodyText).slice(0, 500)}`
    );
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export const HUMAN_AGENT_TAG = 'HUMAN_AGENT';

export async function sendMessage(recipientId, text, tag) {
  const truncated = String(text ?? '').slice(0, MAX_TEXT_LENGTH);
  const payload = {
    recipient: { id: String(recipientId) },
    message: { text: truncated },
  };
  if (tag) {
    payload.messaging_type = 'MESSAGE_TAG';
    payload.messaging_tag = tag;
  } else {
    payload.messaging_type = 'RESPONSE';
  }
  return postToGraph(payload);
}

export async function senderAction(recipientId, action) {
  if (!VALID_SENDER_ACTIONS.includes(action)) {
    throw new Error(
      `Invalid sender_action: ${String(action)}. Expected one of ${VALID_SENDER_ACTIONS.join(', ')}`
    );
  }
  return postToGraph({
    recipient: { id: String(recipientId) },
    messaging_type: 'RESPONSE',
    sender_action: action,
  });
}
