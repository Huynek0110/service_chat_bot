import { getDb } from '../db/migrate.js';

function ensureCustomersTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      display_name TEXT,
      first_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
      lead_status TEXT DEFAULT 'new',
      human_handoff INTEGER NOT NULL DEFAULT 0,
      notes TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_identity
    ON customers(channel, external_user_id);
  `);
}

function rowToCustomer(row) {
  if (!row) return null;
  return row;
}

export function getCustomer(channel, userId) {
  const db = getDb();
  ensureCustomersTable(db);
  const stmt = db.prepare(
    'SELECT * FROM customers WHERE channel = ? AND external_user_id = ?'
  );
  const row = stmt.get(channel, String(userId));
  return rowToCustomer(row || null);
}

export function getOrCreateCustomer(channel, externalUserId, displayName) {
  const db = getDb();
  ensureCustomersTable(db);
  const extId = String(externalUserId);

  let row = db
    .prepare('SELECT * FROM customers WHERE channel = ? AND external_user_id = ?')
    .get(channel, extId);

  if (!row) {
    db.prepare(
      `INSERT INTO customers (channel, external_user_id, display_name)
       VALUES (?, ?, ?)`
    ).run(channel, extId, displayName ?? null);
    row = db
      .prepare('SELECT * FROM customers WHERE channel = ? AND external_user_id = ?')
      .get(channel, extId);
  } else {
    // Update display_name if a new one is provided and differs.
    if (displayName !== undefined && displayName !== null && row.display_name !== displayName) {
      db.prepare(
        'UPDATE customers SET display_name = ? WHERE channel = ? AND external_user_id = ?'
      ).run(displayName, channel, extId);
    }
  }

  // Always bump last_seen_at.
  db.prepare(
    'UPDATE customers SET last_seen_at = CURRENT_TIMESTAMP WHERE channel = ? AND external_user_id = ?'
  ).run(channel, extId);

  row = db
    .prepare('SELECT * FROM customers WHERE channel = ? AND external_user_id = ?')
    .get(channel, extId);
  return rowToCustomer(row);
}

export function setHandoff(channel, userId, on, reason) {
  const db = getDb();
  ensureCustomersTable(db);
  const extId = String(userId);

  // Ensure the customer row exists.
  getOrCreateCustomer(channel, extId);

  if (reason !== undefined && reason !== null) {
    db.prepare(
      `UPDATE customers
       SET human_handoff = ?, notes = ?, last_seen_at = CURRENT_TIMESTAMP
       WHERE channel = ? AND external_user_id = ?`
    ).run(on ? 1 : 0, reason, channel, extId);
  } else {
    db.prepare(
      `UPDATE customers
       SET human_handoff = ?, last_seen_at = CURRENT_TIMESTAMP
       WHERE channel = ? AND external_user_id = ?`
    ).run(on ? 1 : 0, channel, extId);
  }

  return getCustomer(channel, extId);
}

export function updateLead(channel, userId, status, notes) {
  const db = getDb();
  ensureCustomersTable(db);
  const extId = String(userId);

  // Ensure the customer row exists.
  getOrCreateCustomer(channel, extId);

  if (notes !== undefined && notes !== null) {
    db.prepare(
      `UPDATE customers
       SET lead_status = ?, notes = ?, last_seen_at = CURRENT_TIMESTAMP
       WHERE channel = ? AND external_user_id = ?`
    ).run(status, notes, channel, extId);
  } else {
    db.prepare(
      `UPDATE customers
       SET lead_status = ?, last_seen_at = CURRENT_TIMESTAMP
       WHERE channel = ? AND external_user_id = ?`
    ).run(status, channel, extId);
  }

  return getCustomer(channel, extId);
}
