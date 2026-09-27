// src/llm/client.js — the ONLY module allowed to open a socket to the local AI.
//
// Speaks the OpenAI-compatible REST contract that LM Studio exposes on
// http://localhost:1234/v1 through Node's global fetch (Node >= 20) — no SDK,
// no new dependency. Everything else in the project goes through this file.
//
// The whole app is non-streaming on purpose: the frontend renders one bubble at
// a time, so every request here sets `stream: false` and there is deliberately
// no SSE / WebSocket path.
//
// Tool calling follows the OpenAI shape exactly (see AGENTS.md §3.5):
//   assistant turn -> { role:'assistant', content, tool_calls:[{ id, type,
//                      function:{ name, arguments:'<JSON string>' } }] }
//   tool result    -> { role:'tool', tool_call_id:'<the id>', content:'<text>' }
// Getting this wrong silently breaks the agent loops, so both loops consume
// `toolCalls` (id + parsed object) and rebuild the history turns themselves.

import { config } from '../config.js';
import { logger } from '../services/logger.js';

// "Thinking" hint. The OpenAI-compatible API has no `think` parameter, so when
// LMSTUDIO_THINK is on we inject a short system hint instead of a dedicated flag.
// The pinned model (google/gemma-3-1b) is a plain chat model with no reasoning
// mode, so this is off by default — it stays useful if a reasoning model is ever
// dropped in via LMSTUDIO_CHAT_MODEL.
const THINK_HINT = 'Hãy suy nghĩ kỹ từng bước trước khi trả lời, rồi mới đưa ra câu trả lời cuối cùng cho người dùng.';

// LM Studio ignores the key (it binds localhost with no auth) but the
// OpenAI-compatible contract requires a non-empty Authorization header.
function authHeader() {
  return `Bearer ${config.lmStudioApiKey || 'lm-studio'}`;
}

// The base URL comes from .env and may or may not already carry the /v1 suffix.
// Trim trailing slashes so we never emit a double slash before the endpoint.
function endpoint(path) {
  const base = String(config.lmStudioBaseUrl || '').replace(/\/+$/, '');
  return `${base}${path}`;
}

function jsonHeaders() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: authHeader(),
  };
}

// Runtimes and proxies disagree on where the human-readable part lives; pull
// whichever is present so the operator sees LM Studio's own wording.
function extractErrorText(body) {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 300);
  if (body.error) {
    if (typeof body.error === 'string') return body.error.slice(0, 300);
    if (body.error.message) return String(body.error.message).slice(0, 300);
  }
  if (body.message) return String(body.message).slice(0, 300);
  return '';
}

// Translate a transport/HTTP failure into something the operator can act on.
// Vietnamese copy: the audience is the shop owner reading a log or a chat reply.
function toActionableError(err, { model, endpointLabel }) {
  const host = config.lmStudioBaseUrl;

  if (err && err.name === 'TimeoutError') {
    return new Error(
      `LM Studio không phản hồi trong ${config.llmTimeoutMs}ms (${endpointLabel}). ` +
      `Tăng LMSTUDIO_TIMEOUT_MS trong file .env, hoặc dùng model nhỏ hơn.${model ? ` Model: ${model}.` : ''}`
    );
  }
  if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
    return new Error(`Yêu cầu tới LM Studio bị hủy sau ${config.llmTimeoutMs}ms (${endpointLabel}).`);
  }
  if (err && (err.code === 'ECONNREFUSED' || (err.cause && err.cause.code === 'ECONNREFUSED'))) {
    return new Error(
      `Không kết nối được tới LM Studio tại ${host}. ` +
      'Hãy mở LM Studio và bật "Local Server" trên port 1234.'
    );
  }
  if (err && (err.code === 'ENOTFOUND' || (err.cause && err.cause.code === 'ENOTFOUND'))) {
    return new Error(
      `Không phân giải được địa chỉ LM Studio "${host}". ` +
      'Kiểm tra lại dòng LMSTUDIO_BASE_URL trong file .env.'
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

function httpError(status, body, { model, endpointLabel }) {
  const detail = extractErrorText(body);
  const suffix = detail ? ` Chi tiết: ${detail}` : '';

  if (status === 404) {
    return new Error(
      `LM Studio không phục vụ model${model ? ` "${model}"` : ''} (HTTP 404${endpointLabel}). ` +
      `Hãy tải/load model đó trong LM Studio rồi thử lại.${suffix}`
    );
  }
  if (status === 401 || status === 403) {
    return new Error(`LM Studio từ chối request (HTTP ${status}). Kiểm tra lại LMSTUDIO_API_KEY.${suffix}`);
  }
  if (status === 400) {
    return new Error(
      `LM Studio từ chối request (HTTP 400${endpointLabel}) — thường do model hoặc tham số không hợp lệ.${suffix}`
    );
  }
  if (status === 413) {
    return new Error(
      `Nội dung quá lớn so với LM Studio (HTTP 413${endpointLabel}). ` +
      'Giảm LMSTUDIO_MAX_TOKENS hoặc rút gọn lịch sử chat.'
    );
  }
  if (status >= 500) {
    return new Error(
      `LM Studio bị lỗi nội bộ (HTTP ${status}${endpointLabel}). Khởi động lại LM Studio rồi thử lại.${suffix}`
    );
  }
  return new Error(`LM Studio trả về lỗi HTTP ${status}${endpointLabel}.${suffix}`);
}

// One request/response round trip. Everything the public helpers need — timeout,
// abort, JSON decode, actionable error mapping — happens here so no caller ever
// has to think about transport.
async function requestJson(path, { method = 'GET', body, model, endpointLabel = '' } = {}) {
  const url = endpoint(path);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: jsonHeaders(),
      // Non-streaming by contract (AGENTS.md §3.3).
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.llmTimeoutMs),
    });
  } catch (err) {
    throw toActionableError(err, { model, endpointLabel });
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    logger.error('LM Studio request failed', {
      url,
      status: response.status,
      model,
      error: extractErrorText(data),
    });
    throw httpError(response.status, data, { model, endpointLabel });
  }

  if (data === null) {
    throw new Error(
      `LM Studio trả về phản hồi rỗng không đúng chuẩn OpenAI (${method} ${path}). ` +
      'Kiểm tra xem máy có đang trỏ tới một proxy/port khác không.'
    );
  }

  return data;
}

// LM Studio's `arguments` is a JSON string per the OpenAI contract, but some
// runtimes hand back an already-parsed object. Normalize to an object here (what
// every tool implementation wants) and let the loops re-stringify for history.
function normalizeToolCalls(raw) {
  if (!Array.isArray(raw)) return [];

  const calls = [];
  for (let i = 0; i < raw.length; i++) {
    const call = raw[i] || {};
    const fn = call.function || {};
    const name = typeof fn.name === 'string' ? fn.name : '';
    // A nameless call cannot be dispatched; dropping it beats throwing out of
    // the agent loop.
    if (!name) continue;

    let args = fn.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        // Malformed JSON from a small model: hand the tool an empty object and
        // let it report its own validation error back to the model.
        args = {};
      }
    } else if (!args || typeof args !== 'object') {
      args = {};
    }

    calls.push({
      // tool_call_id is mandatory on the following tool message, so synthesize a
      // stable id when the runtime omits one.
      id: typeof call.id === 'string' && call.id ? call.id : `call_${i + 1}`,
      name,
      arguments: args,
    });
  }
  return calls;
}

// Inject the reasoning hint without mutating the caller's array: the agent loops
// replay `messages` across iterations and the hint must appear exactly once.
function applyThinkHint(messages, think) {
  const list = Array.isArray(messages) ? messages : [];
  if (!think) return list;

  const alreadyPresent = list.some((m) => m && m.role === 'system' && m.content === THINK_HINT);
  if (alreadyPresent) return list;

  // Chat providers expect the leading system message first, so slot the hint
  // right behind it instead of appending after the user turn.
  if (list.length > 0) return [list[0], { role: 'system', content: THINK_HINT }, ...list.slice(1)];
  return [{ role: 'system', content: THINK_HINT }];
}

// Gemma-family chat templates hard-fail on anything but strict user/assistant
// alternation: the template itself calls raise_exception("Conversation roles
// must alternate...") and the server answers HTTP 400. That is not hypothetical
// here — duplicate consecutive rows in `conversations` (a retried or
// double-saved inbound message) are enough to brick the bot, because
// getHistory() replays them verbatim.
//
// So the wire format is normalised here, in the adapter, rather than in each
// agent loop: everything that reaches the model has already been made legal.
// This is also the single place that knows about template quirks, so a future
// model swap does not require touching the agent loops again.
function normalizeMessages(messages) {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [];

  const out = [];
  for (const m of list) {
    const role = m.role;
    const content = typeof m.content === 'string' ? m.content : m.content == null ? '' : String(m.content);

    // Drop empties: a blank turn breaks alternation just as badly as a duplicate.
    if (content.trim() === '' && !Array.isArray(m.tool_calls)) continue;

    // Leading assistant turn (or a system message after the first turn) has no
    // user question to belong to — strict templates reject it.
    if (role === 'assistant' && !out.some((x) => x.role === 'user')) continue;

    const prev = out[out.length - 1];
    if (prev && prev.role === role && role !== 'tool') {
      // Merge consecutive same-role turns rather than dropping either half: the
      // model needs to see both, the template just cannot see them separately.
      prev.content = `${prev.content}\n\n${content}`;
      continue;
    }
    out.push({ ...m, content });
  }

  // Consecutive tool results are a legal OpenAI shape but still illegal for a
  // strict template, which only knows user/assistant. Collapse the run.
  for (let i = out.length - 1; i > 0; i--) {
    if (out[i].role === 'tool' && out[i - 1].role === 'tool') {
      out[i - 1].content = `${out[i - 1].content}\n\n${out[i].content}`;
      out.splice(i, 1);
    }
  }

  return out;
}

/**
 * One chat round trip against the pinned local chat model.
 * @returns {Promise<{content: string, toolCalls: Array<{id: string, name: string, arguments: object}>, raw: object}>}
 */
export async function chatCompletion({ messages, tools, temperature, maxTokens, think } = {}) {
  const body = {
    model: config.lmStudioChatModel,
    messages: normalizeMessages(applyThinkHint(messages, think)),
    stream: false,
  };

  if (typeof temperature === 'number' && !Number.isNaN(temperature)) {
    body.temperature = temperature;
  }
  if (typeof maxTokens === 'number' && !Number.isNaN(maxTokens)) {
    body.max_tokens = maxTokens;
  }
  // Tool definitions are already in OpenAI `function` schema shape — pass them
  // through untouched. Omitted when empty so pure-chat models are not confused.
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
  }

  const data = await requestJson('/chat/completions', {
    method: 'POST',
    body,
    model: config.lmStudioChatModel,
    endpointLabel: ' khi gọi chat',
  });

  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const message = choice && choice.message ? choice.message : null;
  if (!message) {
    throw new Error(
      'LM Studio trả về phản hồi không đúng chuẩn OpenAI (thiếu choices[0].message). ' +
      `Model đang dùng: ${config.lmStudioChatModel}.`
    );
  }

  return {
    // Plain text where tools were expected is a valid answer: the loops fall
    // back to it instead of erroring.
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: normalizeToolCalls(message.tool_calls),
    raw: data,
  };
}

function assertEmbeddingModel() {
  const model = String(config.lmStudioEmbeddingModel || '').trim();
  if (!model) {
    throw new Error(
      'Chưa cấu hình model embedding (LMSTUDIO_EMBEDDING_MODEL để trống trong file .env). ' +
      'Hãy nạp một model embedding vào LM Studio (ví dụ text-embedding-nomic-embed-text-v1.5) ' +
      'rồi điền tên model vào dòng đó nếu muốn dùng RAG.'
    );
  }
  return model;
}

function toFloat32Array(embedding) {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('LM Studio trả về vector rỗng hoặc sai định dạng.');
  }
  return Float32Array.from(embedding);
}

/**
 * Embed one string. Throws a descriptive Error when no embedding model is
 * configured or LM Studio is unreachable — callers degrade to "no RAG context".
 * @returns {Promise<Float32Array>}
 */
export async function embedText(text) {
  const model = assertEmbeddingModel();
  const data = await requestJson('/embeddings', {
    method: 'POST',
    body: { model, input: text },
    model,
    endpointLabel: ' khi tạo embedding',
  });

  const first = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!first || !first.embedding) {
    throw new Error('LM Studio trả về phản hồi embeddings không đúng chuẩn OpenAI (thiếu data[0].embedding).');
  }
  return toFloat32Array(first.embedding);
}

/**
 * Embed many strings in a single round trip. Same throw-on-missing-model
 * contract as embedText.
 * @returns {Promise<Float32Array[]>}
 */
export async function embedTexts(texts) {
  const model = assertEmbeddingModel();
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const data = await requestJson('/embeddings', {
    method: 'POST',
    body: { model, input: texts },
    model,
    endpointLabel: ' khi tạo embedding',
  });

  if (!data || !Array.isArray(data.data) || data.data.length !== texts.length) {
    const got = data && Array.isArray(data.data) ? data.data.length : 0;
    throw new Error(
      `LM Studio trả về ${got}/${texts.length} vector. Embedding batch không khớp — hãy thử nho số lượng chunk.`
    );
  }
  // The API documents `index` but never guarantees order; sort on it so the
  // caller can zip inputs to vectors positionally.
  const ordered = data.data
    .map((item, fallbackIndex) => ({
      item,
      position: Number.isInteger(item && item.index) ? item.index : fallbackIndex,
    }))
    .sort((a, b) => a.position - b.position);

  return ordered.map((entry) => toFloat32Array(entry.item.embedding));
}

/** Configured embedding model id, or '' when RAG is intentionally disabled. */
export function getEmbeddingModel() {
  return String(config.lmStudioEmbeddingModel || '').trim();
}

/**
 * Model ids currently served by LM Studio. Diagnostics only (the admin UI has
 * no model picker — the chat model is pinned).
 * @returns {Promise<string[]>}
 */
export async function listModels() {
  const data = await requestJson('/models', { method: 'GET' });
  if (!data || !Array.isArray(data.data)) return [];
  return data.data.map((m) => m && m.id).filter((id) => typeof id === 'string');
}

/**
 * Cheap reachability probe. Never throws — the result itself is the answer.
 * @returns {Promise<{ok: boolean, error: string|null, model: string, embeddingModel: string, models: string[]}>}
 */
export async function healthCheck() {
  try {
    const models = await listModels();
    return {
      ok: true,
      error: null,
      model: config.lmStudioChatModel,
      embeddingModel: getEmbeddingModel(),
      models,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      model: config.lmStudioChatModel,
      embeddingModel: getEmbeddingModel(),
      models: [],
    };
  }
}
