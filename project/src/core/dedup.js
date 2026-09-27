import { getDb } from '../db/migrate.js';

function ensureProcessedEventsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id TEXT PRIMARY KEY,
      processed_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// Returns true if eventId was already seen. Fail-closed (true) on DB error
// so callers skip processing rather than double-processing.
export function isProcessed(eventId) {
  if (!eventId || typeof eventId !== 'string') return false;
  try {
    const db = getDb();
    ensureProcessedEventsTable(db);
    const row = db
      .prepare('SELECT event_id FROM processed_events WHERE event_id = ?')
      .get(eventId);
    return !!row;
  } catch {
    return true;
  }
}

// Marks eventId as processed via INSERT OR IGNORE.
// Returns true on success (newly inserted or already present),
// false on invalid input or DB error.
export function markProcessed(eventId) {
  if (!eventId || typeof eventId !== 'string') return false;
  try {
    const db = getDb();
    ensureProcessedEventsTable(db);
    db.prepare('INSERT OR IGNORE INTO processed_events (event_id) VALUES (?)').run(
      eventId
    );
    return true;
  } catch {
    return false;
  }
}

// Deletes entries older than maxAgeDays. Returns removed count, 0 on error.
// Called once at server boot so the table doesn't grow forever.
export function pruneProcessedEvents(maxAgeDays = 7) {
  try {
    const db = getDb();
    ensureProcessedEventsTable(db);
    const r = db
      .prepare(`DELETE FROM processed_events WHERE processed_at < datetime('now', ?)`)
      .run(`-${maxAgeDays} days`);
    return Number(r.changes) || 0;
  } catch {
    return 0;
  }
}
