import { getDb } from '../db/migrate.js';
import { config } from '../config.js';
import { logger } from '../services/logger.js';

export { getDb };

export function initHistoryTables() {
  const db = getDb();
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE INDEX IF NOT EXISTS idx_conv_user 
    ON conversations(channel, external_user_id, created_at);
  `);
}

export function saveMessage(channel, externalUserId, role, content) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO conversations (channel, external_user_id, role, content)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(channel, externalUserId, role, content);
}

export function getHistory(channel, externalUserId, limit = config.maxHistoryMessages) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT role, content, created_at
    FROM conversations
    WHERE channel = ? AND external_user_id = ?
    ORDER BY id DESC
    LIMIT ?
  `);
  const rows = stmt.all(channel, externalUserId, limit);
  return rows.reverse().map(r => ({ role: r.role, content: r.content }));
}

export function clearHistory(channel, externalUserId) {
  const db = getDb();
  const stmt = db.prepare(`
    DELETE FROM conversations WHERE channel = ? AND external_user_id = ?
  `);
  stmt.run(channel, externalUserId);
}

export function getMessageCount(channel, externalUserId) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM conversations
    WHERE channel = ? AND external_user_id = ?
  `);
  const row = stmt.get(channel, externalUserId);
  return row ? row.count : 0;
}

export function closeDb() {
  // No-op: the shared connection is owned by src/db/migrate.js.
}