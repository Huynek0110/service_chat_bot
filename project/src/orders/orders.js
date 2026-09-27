import { getDb } from '../db/migrate.js';
import { popAccLine, countAccLines } from './stock.js';
import { logger } from '../services/logger.js';

function nextOrderCode(db) {
  const row = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'orders'`).get();
  const n = (row?.seq || 0) + 1;
  return 'DH' + String(n).padStart(6, '0');
}

// Creates an order in status 'awaiting_payment' (QR not sent yet).
// Returns the row. Throws when product missing/inactive.
export function createOrder({ channel, userId, productId }) {
  const db = getDb();
  const product = db.prepare('SELECT * FROM products WHERE id = ? AND is_active = 1').get(productId);
  if (!product) throw new Error('Sản phẩm không tồn tại hoặc đã ngừng bán');
  const code = nextOrderCode(db);
  const r = db
    .prepare(
      `INSERT INTO orders (order_code, channel, external_user_id, product_id, sku, price)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(code, channel, String(userId), product.id, product.sku, product.price);
  logger.info('ORDER_CREATED', { code, channel, userId, productId });
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(r.lastInsertRowid));
}

// Latest order of this buyer whose QR bundle hasn't been sent yet.
export function getUnannouncedOrder(channel, userId) {
  const db = getDb();
  return (
    db
      .prepare(
        `SELECT * FROM orders WHERE channel = ? AND external_user_id = ?
         AND status = 'awaiting_payment' AND announced = 0
         ORDER BY id DESC LIMIT 1`
      )
      .get(channel, String(userId)) || null
  );
}

export function markAnnounced(orderId) {
  getDb().prepare(`UPDATE orders SET announced = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(orderId);
}

// Buyer pressed "Đã giao dịch" (callback). Only the owning buyer can claim,
// only from awaiting_payment. -> status 'pending_verify' (admin must verify).
export function claimPaid(orderId, chatId) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return { ok: false, reason: 'not_found' };
  if (String(order.external_user_id) !== String(chatId)) return { ok: false, reason: 'not_owner' };
  if (order.status !== 'awaiting_payment') return { ok: false, reason: 'bad_status' };
  db.prepare(
    `UPDATE orders SET status = 'pending_verify', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(orderId);
  logger.info('ORDER_CLAIMED', { code: order.order_code, chatId });
  return { ok: true, order };
}

// Admin pressed "Xác minh & giao hàng": pops 1 acc line, archives it,
// sets stock_quantity to remaining lines, marks delivered.
// SENDING the line to the buyer is the caller's job (needs Telegram bot).
// Returns { ok:true, line, remaining, order } or { ok:false, error }.
export function deliverOrder(orderId) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return { ok: false, error: 'Không tìm thấy đơn' };
  if (order.status === 'delivered') return { ok: false, error: 'Đơn đã giao rồi' };
  if (order.status === 'cancelled') return { ok: false, error: 'Đơn đã hủy' };
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(order.product_id);
  if (!product) return { ok: false, error: 'Sản phẩm không còn tồn tại' };
  if (!product.acc_file) return { ok: false, error: 'Sản phẩm chưa gắn file acc (.txt)' };
  let popped;
  try {
    popped = popAccLine(product.acc_file);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  // Authoritative stock = remaining acc lines.
  db.prepare(`UPDATE products SET stock_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(
    popped.remaining,
    product.id
  );
  db.prepare(
    `UPDATE orders SET status = 'delivered', delivered_line = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(popped.line, orderId);
  logger.info('ORDER_DELIVERED', { code: order.order_code, remaining: popped.remaining });
  return {
    ok: true,
    line: popped.line,
    remaining: popped.remaining,
    order: db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId),
  };
}

export function cancelOrder(orderId) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return { ok: false, error: 'Không tìm thấy đơn' };
  if (order.status === 'delivered') return { ok: false, error: 'Đơn đã giao, không hủy được' };
  db.prepare(`UPDATE orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(orderId);
  return { ok: true };
}

export function listOrders({ status = '', limit = 50 } = {}) {
  const db = getDb();
  if (status) {
    return db
      .prepare(`SELECT o.*, p.name AS product_name FROM orders o LEFT JOIN products p ON p.id = o.product_id WHERE o.status = ? ORDER BY o.id DESC LIMIT ?`)
      .all(status, limit);
  }
  return db
    .prepare(`SELECT o.*, p.name AS product_name FROM orders o LEFT JOIN products p ON p.id = o.product_id ORDER BY o.id DESC LIMIT ?`)
    .all(limit);
}

export function countPendingVerify() {
  const db = getDb();
  return db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE status = 'pending_verify'`).get().c;
}
