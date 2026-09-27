import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, extname, sep } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { config } from '../config.js';
import { logger } from '../services/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROMPTS_DIR = resolve(__dirname, '../../system-prompts');
const ACTIVE_OVERRIDE_FILE = resolve(PROMPTS_DIR, '.active-override');

function safePromptPath(filename) {
  if (typeof filename !== 'string' || !/^[a-zA-Z0-9_-]+\.md$/.test(filename)) {
    throw new Error('Invalid filename');
  }
  const filePath = resolve(PROMPTS_DIR, filename);
  if (!filePath.startsWith(PROMPTS_DIR + sep)) {
    throw new Error('Invalid filename');
  }
  return filePath;
}

let cachedPrompt = null;
let cachedPromptFile = null;
let cachedPromptMtime = 0;

export function getActivePromptFile() {
  try {
    if (existsSync(ACTIVE_OVERRIDE_FILE)) {
      const override = readFileSync(ACTIVE_OVERRIDE_FILE, 'utf-8').trim();
      if (override) {
        // Validate (throws on invalid); fall through to config on failure
        safePromptPath(override);
        return override;
      }
    }
  } catch {
    // Ignore invalid override and fall back to config
  }
  return config.activeSystemPrompt;
}

export function setActivePromptOverride(filename) {
  if (filename === null || filename === undefined || filename === '') {
    if (existsSync(ACTIVE_OVERRIDE_FILE)) {
      unlinkSync(ACTIVE_OVERRIDE_FILE);
    }
    cachedPrompt = null;
    cachedPromptFile = null;
    cachedPromptMtime = 0;
    return;
  }
  const filePath = safePromptPath(filename);
  if (!existsSync(filePath)) {
    throw new Error(`System prompt file not found: ${filename}`);
  }
  writeFileSync(ACTIVE_OVERRIDE_FILE, filename, 'utf-8');
  cachedPrompt = null;
  cachedPromptFile = null;
  cachedPromptMtime = 0;
}

export function listPromptFiles() {
  if (!existsSync(PROMPTS_DIR)) {
    return [];
  }
  return readdirSync(PROMPTS_DIR)
    .filter(f => extname(f) === '.md')
    .map(f => ({
      filename: f,
      isActive: f === config.activeSystemPrompt
    }));
}

export function readPromptFile(filename) {
  const filePath = safePromptPath(filename);
  if (!existsSync(filePath)) {
    throw new Error(`System prompt file not found: ${filename}`);
  }
  return readFileSync(filePath, 'utf-8');
}

export function writePromptFile(filename, content) {
  const filePath = safePromptPath(filename);
  if (!existsSync(PROMPTS_DIR)) {
    throw new Error(`Prompts directory not found: ${PROMPTS_DIR}`);
  }
  return import('fs').then(fs => fs.writeFileSync(filePath, content, 'utf-8'));
}

export function loadSystemPrompt(forceReload = false) {
  const filename = getActivePromptFile();
  let filePath;
  try {
    filePath = safePromptPath(filename);
  } catch {
    logger.warn(`Invalid system prompt filename: ${filename}, using default`);
    return getDefaultPrompt();
  }
  
  if (!existsSync(filePath)) {
    logger.warn(`System prompt file not found: ${filename}, using default`);
    return getDefaultPrompt();
  }
  
  const stats = existsSync(filePath) ? statSync(filePath) : null;
  const mtime = stats ? stats.mtimeMs : 0;
  
  if (!forceReload && cachedPrompt && cachedPromptFile === filename && cachedPromptMtime === mtime) {
    return cachedPrompt;
  }
  
  try {
    const content = readFileSync(filePath, 'utf-8');
    cachedPrompt = content.trim();
    cachedPromptFile = filename;
    cachedPromptMtime = mtime;
    logger.debug('System prompt loaded', { filename, length: cachedPrompt.length });
    return cachedPrompt;
  } catch (error) {
    logger.error('Failed to load system prompt', { filename, error: error.message });
    return getDefaultPrompt();
  }
}

function getDefaultPrompt() {
  return `Bạn là một nhân viên tư vấn bán hàng chuyên nghiệp, thân thiện của cửa hàng. Bạn nói tiếng Việt tự nhiên, gần gũi.

## Nguyên tắc cốt lõi

1. **Chỉ dùng dữ liệu được cung cấp**: Thông tin sản phẩm, giá, tồn kho, chính sách chỉ lấy từ "THÔNG TIN THAM KHẢO TỪ CƠ SỞ DỮ LIỆU CỬA HÀNG" và kết quả tool calling. Tuyệt đối không tự bịa, đoán, suy diễn.

2. **Không có thông tin → Nói rõ**: Nếu dữ liệu không có, hãy nói: "Thông tin này hiện mình chưa có trong dữ liệu của shop." hoặc "Mình cần kiểm tra thêm, bạn cho mình chút thời gian nhé."

3. **Giọng văn**: Thân thiện, dùng "mình/bạn", thêm từ ngữ mềm mại (nhé, ạ, chúc bạn...). Tránh nói như robot.

4. **Tư vấn chủ động**: Hỏi nhu cầu, gợi ý phù hợp, hướng dẫn quy trình mua hàng.`;
}