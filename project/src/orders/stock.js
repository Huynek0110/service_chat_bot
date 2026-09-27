import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { resolve, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../db/migrate.js';
import { logger } from '../services/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Project-root folders (per owner spec: Chatbot_\project\products).
export const ACC_DIR = resolve(__dirname, '../../products');
export const UPLOAD_DIR = resolve(__dirname, '../../data/uploads');

export function ensureStorage() {
  mkdirSync(ACC_DIR, { recursive: true });
  mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Guard: filename must be a plain .txt name, no paths. Returns absolute path.
export function safeAccPath(filename) {
  if (!filename || typeof filename !== 'string') throw new Error('Missing acc file');
  const base = basename(filename);
  if (base !== filename || extname(base).toLowerCase() !== '.txt') {
    throw new Error(`Invalid acc file: ${filename}`);
  }
  if (filename.includes('..')) throw new Error(`Invalid acc file: ${filename}`);
  return resolve(ACC_DIR, base);
}

function readLines(absPath) {
  if (!existsSync(absPath)) return [];
  return readFileSync(absPath, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// List acc files with remaining line counts. Sold archives (*+đã bán.txt) excluded.
export function listAccFiles() {
  ensureStorage();
  return readdirSync(ACC_DIR)
    .filter((f) => extname(f).toLowerCase() === '.txt' && !f.includes('+đã bán'))
    .sort()
    .map((f) => ({ file: f, lines: readLines(resolve(ACC_DIR, f)).length }));
}

export function countAccLines(filename) {
  ensureStorage();
  return readLines(safeAccPath(filename)).length;
}

// Pops the FIRST line (FIFO). The sold line is appended to
// `<base>+đã bán.txt` (e.g. ACC-VIP.txt -> ACC-VIP+đã bán.txt).
// Returns { line, remaining }. Throws when empty/missing.
export function popAccLine(filename) {
  ensureStorage();
  const abs = safeAccPath(filename);
  const lines = readLines(abs);
  if (lines.length === 0) {
    throw new Error(`Kho acc đã hết (file ${basename(filename)} không còn dòng nào)`);
  }
  const [sold, ...rest] = lines;
  writeFileSync(abs, rest.join('\n') + (rest.length ? '\n' : ''), 'utf-8');
  const base = basename(filename, '.txt');
  appendFileSync(resolve(ACC_DIR, `${base}+đã bán.txt`), sold + '\n', 'utf-8');
  logger.info('ACC_SOLD', { file: basename(filename), remaining: rest.length });
  return { line: sold, remaining: rest.length };
}

// --- settings (key/value, editable from admin, no restart) ---
export function getSetting(key, defaultValue = '') {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function setSetting(key, value) {
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  ).run(key, value ?? '');
}
