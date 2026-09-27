import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenvConfig({ path: resolve(__dirname, '../.env'), quiet: true });

function getEnv(key, defaultValue = undefined, required = false) {
  const value = process.env[key];
  if (value === undefined || value === '') {
    if (required) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return defaultValue;
  }
  return value;
}

function getBool(key, defaultValue = false) {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

function getInt(key, defaultValue) {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function getFloat(key, defaultValue) {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

export const config = {
  // Server
  port: getInt('PORT', 3000),
  nodeEnv: getEnv('NODE_ENV', 'development'),

  // AI local (LM Studio) — OpenAI-compatible REST server on port 1234.
  // No auth: it binds localhost only, so LMSTUDIO_API_KEY is just the non-empty
  // placeholder the OpenAI request contract still asks for.
  lmStudioBaseUrl: getEnv('LMSTUDIO_BASE_URL', 'http://localhost:1234/v1'),
  lmStudioApiKey: getEnv('LMSTUDIO_API_KEY', 'lm-studio'),
  // Pinned chat model (AGENTS.md §3.1). Overridable for future use, but no UI
  // may offer a model picker — a wrong id is the #1 cause of empty replies.
  lmStudioChatModel: getEnv('LMSTUDIO_CHAT_MODEL', 'google/gemma-3-1b'),
  // Embedding model served at /v1/embeddings. LEAVE EMPTY to disable RAG
  // gracefully: the bot still chats, just without knowledge-base context. The
  // pinned chat model above is not an embedding model, so empty is the default.
  lmStudioEmbeddingModel: getEnv('LMSTUDIO_EMBEDDING_MODEL', ''),
  // Vector width for kb_vectors. Must match the embedding model actually loaded.
  // Changing it requires dropping kb_vectors/kb_chunks and reindexing.
  embeddingDim: getInt('EMBEDDING_DIM', 768),
  llmTimeoutMs: getInt('LMSTUDIO_TIMEOUT_MS', 180000),
  llmMaxTokens: getInt('LMSTUDIO_MAX_TOKENS', 2048),
  llmTemperature: getFloat('LMSTUDIO_TEMPERATURE', 0.3),
  llmThink: getBool('LMSTUDIO_THINK', false),

  // System prompt
  activeSystemPrompt: getEnv('ACTIVE_SYSTEM_PROMPT', 'default.md'),

  // Web search
  enableWebSearch: getBool('ENABLE_WEB_SEARCH', false),
  webSearchProvider: getEnv('WEB_SEARCH_PROVIDER', 'tavily'),
  webSearchApiKey: getEnv('WEB_SEARCH_API_KEY', ''),

  // Messenger (MESSENGER_ENABLED=false to disable temporarily)
  messengerEnabled: getEnv('MESSENGER_ENABLED', 'true').toLowerCase() !== 'false',
  messengerVerifyToken: getEnv('MESSENGER_VERIFY_TOKEN', ''),
  messengerAppSecret: getEnv('MESSENGER_APP_SECRET', ''),
  messengerPageAccessToken: getEnv('MESSENGER_PAGE_ACCESS_TOKEN', ''),
  messengerPageId: getEnv('MESSENGER_PAGE_ID', ''),

  // Telegram
  telegramEnabled: getBool('TELEGRAM_ENABLED', false),
  telegramBotToken: getEnv('TELEGRAM_BOT_TOKEN', ''),

  // Admin
  adminUsername: getEnv('ADMIN_USERNAME', 'admin'),
  adminPassword: getEnv('ADMIN_PASSWORD', 'doi-mat-khau-nay'),

  // Bot behavior
  botDisclosureMessage: getEnv('BOT_DISCLOSURE_MESSAGE', 'Đây là trợ lý ảo tự động của shop, mình sẽ hỗ trợ bạn nhé!'),
  fallbackErrorMessage: getEnv('FALLBACK_ERROR_MESSAGE', 'Xin lỗi, hệ thống đang gặp sự cố, bạn vui lòng thử lại sau ít phút nhé.'),

  // Limits
  maxHistoryMessages: getInt('MAX_HISTORY_MESSAGES', 12),
  ragTopK: getInt('RAG_TOP_K', 4),

  // Rate limiting
  rateLimitWindowMs: getInt('RATE_LIMIT_WINDOW_MS', 10000),
  rateLimitMaxMessages: getInt('RATE_LIMIT_MAX_MESSAGES', 10),
};

export function validateRequiredConfig() {
  const missing = [];

  // Messenger credentials REQUIRED only when the channel is enabled.
  if (config.messengerEnabled) {
    if (!config.messengerVerifyToken) missing.push('MESSENGER_VERIFY_TOKEN');
    if (!config.messengerAppSecret) missing.push('MESSENGER_APP_SECRET');
    if (!config.messengerPageAccessToken) missing.push('MESSENGER_PAGE_ACCESS_TOKEN');
    if (!config.messengerPageId) missing.push('MESSENGER_PAGE_ID');
  }

  if (config.telegramEnabled && !config.telegramBotToken) {
    missing.push('TELEGRAM_BOT_TOKEN (required when TELEGRAM_ENABLED=true)');
  }

  if (missing.length > 0) {
    if (config.nodeEnv === 'production') {
      throw new Error(
        `Missing required environment variables (production): ${missing.join(', ')}. ` +
        'Never run a production Messenger chatbot without Meta credentials.'
      );
    }
    console.warn('⚠️  Missing config (some features may not work):', missing.join(', '));
  }

  if (config.enableWebSearch && !config.webSearchApiKey) {
    throw new Error('WEB_SEARCH_API_KEY is required when ENABLE_WEB_SEARCH=true');
  }

  return missing.length === 0;
}