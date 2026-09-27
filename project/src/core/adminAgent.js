// src/core/adminAgent.js — Admin AI agent (AGENT-B owned).
//
// chatWithAdmin({ sessionId, message, useWebSearch, useThinking }) talks to
// LM Studio with admin tool-calling (products / stock / acc files / orders /
// prompts / faqs / customers / settings / stats).
// - Persisted per-session history in admin_sessions/admin_messages
//   (via getDb from ../db/migrate.js). No module-level shared history.
// - History fed to LLM = persisted messages of that session (cap last 30)
//   + system prompt.
// - Agent loop: max 5 iterations, think = useThinking.
// - NO auth here: the /admin/agent/* routes sit behind adminAuth in server.js.
// - Data-changing tools execute directly (no confirmation step) but the agent
//   is instructed to report exactly what changed. Deletes allowed ONLY for
//   FAQ (admin_delete_faq) and order cancel (admin_cancel_order); product rows
//   are toggled (admin_toggle_product), never deleted; acc files never deleted.
//
// Importing this module must NOT touch the network (no LM Studio/DB calls at
// top level); all I/O happens inside the exported functions / tool impls.

import { config } from '../config.js';
import { chatCompletion, healthCheck } from '../llm/client.js';
import { logger } from '../services/logger.js';
import { getDb } from '../db/migrate.js';

const SESSION_HISTORY_CAP = 30;
const MAX_ITERATIONS = 5;
const DEFAULT_SESSION_TITLE = 'Cuộc trò chuyện mới';

const ADMIN_SYSTEM_PROMPT = `Bạn là trợ lý vận hành shop (operator) trong trang quản trị.
Trả lời bằng tiếng Việt, ngắn gọn, đúng trọng tâm.

Quy tắc:
- Dùng tool để lấy dữ liệu thật từ cửa hàng (sản phẩm, tồn kho, file acc, đơn hàng, khách hàng, FAQ, cài đặt, prompt). Tuyệt đối không bịa số liệu.
- Khi admin yêu cầu đổi dữ liệu (sửa tồn kho, thêm/sửa/bật-tắt sản phẩm, ghi/đọc/chọn prompt, thêm/xóa FAQ, giao/hủy đơn, đổi trạng thái khách, đổi cài đặt): THỰC HIỆN NGAY qua tool rồi báo lại cụ thể đã đổi gì (kèm id/sku, giá trị mới). Không hỏi lại "bạn có chắc không".
- Chức năng xóa: CHỈ được xóa FAQ (admin_delete_faq) và hủy đơn (admin_cancel_order). Sản phẩm KHÔNG có chức năng xóa dòng — muốn ngừng bán thì dùng admin_toggle_product (is_active=0). Không bao giờ xóa file acc.
- Kiểm tra số trước khi gọi tool: giá phải là số >= 0; tồn kho/số lượng phải là số nguyên >= 0; is_active và on chỉ nhận 0 hoặc 1; id đơn/khách/faq phải là số nguyên dương. Nếu số không hợp lệ, báo lỗi và không gọi tool.
- Giá trình bày theo VNĐ. Trình bày kết quả gọn (liệt kê theo dòng).
- Sau khi giao đơn (admin_deliver_order): KHÔNG bao giờ in toàn bộ nội dung dòng acc. Chỉ báo "đã giao" kèm mã đơn và số dòng còn lại. Nội dung acc do tầng route gửi cho khách, không phải do bạn gửi.
- Cài đặt shop chỉ được đọc/ghi các khóa: shop_name, support_phone, announcement. Không được đổi đường dẫn file (ví dụ payment_qr_path) qua chat.
- Muốn sửa prompt: đọc trước bằng admin_read_prompt rồi ghi đè bằng admin_write_prompt.`;

const PROMPT_FILENAME_RE = /^[a-z0-9_-]+\.md$/i;
const ORDER_STATUSES = ['awaiting_payment', 'pending_verify', 'delivered', 'cancelled'];
const SETTING_ALLOWLIST = ['shop_name', 'support_phone', 'announcement'];

// ---------------------------------------------------------------- helpers ---

function normStr(v) {
  if (v === undefined || v === null) return '';
  return String(v);
}

function parseNonNegInt(raw, fieldName) {
  const n = typeof raw === 'number' ? raw : Number(normStr(raw).trim());
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${fieldName} phải là số nguyên >= 0 (nhận: ${JSON.stringify(raw)})`);
  }
  return n;
}

function parseNonNegPrice(raw) {
  if (raw === undefined || raw === null || normStr(raw).trim() === '') {
    throw new Error('price là bắt buộc và phải là số >= 0');
  }
  const n = Number(normStr(raw).trim());
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`price phải là số >= 0 (nhận: ${JSON.stringify(raw)})`);
  }
  return n;
}

function parsePositiveInt(raw, fieldName) {
  const n = typeof raw === 'number' ? raw : Number(normStr(raw).trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${fieldName} phải là số nguyên dương (nhận: ${JSON.stringify(raw)})`);
  }
  return n;
}

function parseZeroOne(raw, fieldName) {
  if (raw === true) return 1;
  if (raw === false) return 0;
  const s = normStr(raw).trim();
  const n = Number(s);
  if (n !== 0 && n !== 1) {
    throw new Error(`${fieldName} chỉ nhận 0 hoặc 1 (nhận: ${JSON.stringify(raw)})`);
  }
  return n;
}

function ensureAdminTables() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '${DEFAULT_SESSION_TITLE}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS admin_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES admin_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_admin_msg_session ON admin_messages(session_id, id);
  `);
  return db;
}

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

function parseSessionId(raw) {
  if (raw === undefined || raw === null || normStr(raw).trim() === '') return null;
  const n = typeof raw === 'number' ? raw : Number(normStr(raw).trim());
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function resolveSessionId(db, sessionId) {
  const parsed = parseSessionId(sessionId);
  if (parsed !== null) {
    const row = db.prepare('SELECT id FROM admin_sessions WHERE id = ?').get(parsed);
    if (row) return parsed;
  }
  const r = db
    .prepare(`INSERT INTO admin_sessions (title) VALUES (?)`)
    .run(DEFAULT_SESSION_TITLE);
  return Number(r.lastInsertRowid);
}

function maybeAutoTitle(db, sid) {
  try {
    const sess = db.prepare('SELECT title FROM admin_sessions WHERE id = ?').get(sid);
    if (!sess || (sess.title && sess.title !== DEFAULT_SESSION_TITLE)) return;
    const first = db
      .prepare(`SELECT content FROM admin_messages WHERE session_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1`)
      .get(sid);
    const t = normStr(first && first.content).trim();
    if (!t) return;
    db.prepare('UPDATE admin_sessions SET title = ? WHERE id = ?').run(t.slice(0, 40), sid);
  } catch (err) {
    logger.warn('adminAgent auto-title failed', { sessionId: sid, error: err.message });
  }
}

function touchSession(db, sid) {
  try {
    db.prepare('UPDATE admin_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(sid);
  } catch {
    // best-effort
  }
}

function findProductBySkuOrId(db, skuOrId) {
  const key = normStr(skuOrId).trim();
  if (!key) return null;
  let row = null;
  if (/^\d+$/.test(key)) {
    row = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(key));
  }
  if (!row) {
    row = db.prepare('SELECT * FROM products WHERE sku = ?').get(key);
  }
  return row || null;
}

function csvEscape(v) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// ---------------------------------------------------------------- tools ---

function toolListProducts() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, sku, name, price, stock_quantity, acc_file
       FROM products ORDER BY id DESC LIMIT 30`
    )
    .all();
  return rows.map((r) => ({
    id: r.id,
    sku: r.sku,
    name: r.name,
    price: r.price,
    stock: r.stock_quantity,
    acc_file: r.acc_file,
  }));
}

function toolGetProduct(args) {
  const skuOrId = normStr(args.sku_or_id).trim();
  if (!skuOrId) throw new Error('sku_or_id là bắt buộc');
  const db = getDb();
  const row = findProductBySkuOrId(db, skuOrId);
  if (!row) throw new Error(`Không tìm thấy sản phẩm với sku/id: ${skuOrId}`);
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    price: row.price,
    stock_quantity: row.stock_quantity,
    category: row.category,
    image_url: row.image_url,
    is_active: row.is_active,
    acc_file: row.acc_file,
    qr_image_path: row.qr_image_path,
    updated_at: row.updated_at,
  };
}

function toolSetStock(args) {
  const skuOrId = normStr(args.sku_or_id).trim();
  if (!skuOrId) throw new Error('sku_or_id là bắt buộc');
  const quantity = parseNonNegInt(args.quantity, 'quantity');
  const db = getDb();
  const row = findProductBySkuOrId(db, skuOrId);
  if (!row) throw new Error(`Không tìm thấy sản phẩm với sku/id: ${skuOrId}`);
  db.prepare(
    'UPDATE products SET stock_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(quantity, row.id);
  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(row.id);
  return {
    id: updated.id,
    sku: updated.sku,
    name: updated.name,
    stock: updated.stock_quantity,
  };
}

async function toolToggleProduct(args) {
  const skuOrId = normStr(args.sku_or_id).trim();
  if (!skuOrId) throw new Error('sku_or_id là bắt buộc');
  const isActive = parseZeroOne(args.is_active, 'is_active');
  const db = getDb();
  const row = findProductBySkuOrId(db, skuOrId);
  if (!row) throw new Error(`Không tìm thấy sản phẩm với sku/id: ${skuOrId}`);
  db.prepare('UPDATE products SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    isActive,
    row.id
  );
  try {
    const { indexProduct } = await import('../rag/indexer.js');
    await indexProduct(row.id);
  } catch (err) {
    logger.warn('adminAgent toggle index failed', { id: row.id, error: err.message });
  }
  const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(row.id);
  return { id: updated.id, sku: updated.sku, name: updated.name, is_active: updated.is_active };
}

async function toolUpsertProduct(args) {
  const sku = normStr(args.sku).trim();
  const name = normStr(args.name).trim();
  if (!sku) throw new Error('sku là bắt buộc');
  if (!name) throw new Error('name là bắt buộc');
  const price = parseNonNegPrice(args.price);
  const stock = args.stock_quantity === undefined ? 0 : parseNonNegInt(args.stock_quantity, 'stock_quantity');
  const category =
    args.category === undefined || args.category === null || normStr(args.category).trim() === ''
      ? null
      : normStr(args.category).trim();
  const description =
    args.description === undefined || args.description === null || normStr(args.description).trim() === ''
      ? null
      : normStr(args.description);
  let accFile = null;
  if (args.acc_file !== undefined && args.acc_file !== null && normStr(args.acc_file).trim() !== '') {
    const f = normStr(args.acc_file).trim();
    // Reuse the same guard as the acc library (plain .txt name, no paths).
    const { safeAccPath } = await import('../orders/stock.js');
    safeAccPath(f); // throws on invalid
    accFile = f;
  }
  const db = getDb();
  db.prepare(
    `INSERT INTO products (sku, name, description, price, stock_quantity, category, acc_file, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(sku) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       price = excluded.price,
       stock_quantity = excluded.stock_quantity,
       category = excluded.category,
       acc_file = excluded.acc_file,
       updated_at = CURRENT_TIMESTAMP`
  ).run(sku, name, description, price, stock, category, accFile);
  const row = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
  try {
    const { indexProduct } = await import('../rag/indexer.js');
    await indexProduct(row.id);
  } catch (err) {
    logger.warn('adminAgent upsert index failed', { id: row.id, error: err.message });
  }
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    price: row.price,
    stock: row.stock_quantity,
    acc_file: row.acc_file,
  };
}

async function toolWritePrompt(args) {
  const filename = normStr(args.filename).trim();
  if (!PROMPT_FILENAME_RE.test(filename)) {
    throw new Error('filename chỉ cho phép chữ/số/_/- và phải kết thúc bằng .md');
  }
  const content = args.content === undefined || args.content === null ? '' : String(args.content);
  const { writePromptFile } = await import('./systemPrompt.js');
  await writePromptFile(filename, content);
  return { ok: true, filename };
}

async function toolReadPrompt(args) {
  const filename = normStr(args.filename).trim();
  if (!PROMPT_FILENAME_RE.test(filename)) {
    throw new Error('filename chỉ cho phép chữ/số/_/- và phải kết thúc bằng .md');
  }
  const { readPromptFile } = await import('./systemPrompt.js');
  const content = readPromptFile(filename);
  return { filename, content };
}

async function toolSelectPrompt(args) {
  const filename = normStr(args.filename).trim();
  if (!PROMPT_FILENAME_RE.test(filename)) {
    throw new Error('filename chỉ cho phép chữ/số/_/- và phải kết thúc bằng .md');
  }
  const mod = await import('./systemPrompt.js');
  try {
    mod.readPromptFile(filename);
  } catch {
    throw new Error(`Không tìm thấy prompt file: ${filename}`);
  }
  await mod.setActivePromptOverride(filename);
  return { ok: true, active: filename };
}

async function toolListAccFiles() {
  const { listAccFiles } = await import('../orders/stock.js');
  return listAccFiles();
}

async function toolListOrders(args) {
  const status = normStr(args.status).trim();
  if (status && !ORDER_STATUSES.includes(status)) {
    throw new Error(`status không hợp lệ (nhận: ${status}). Cho phép: ${ORDER_STATUSES.join(', ')} hoặc để trống.`);
  }
  const { listOrders } = await import('../orders/orders.js');
  return listOrders({ status, limit: 50 });
}

async function toolDeliverOrder(args) {
  const orderId = parsePositiveInt(args.order_id, 'order_id');
  const { deliverOrder } = await import('../orders/orders.js');
  const res = deliverOrder(orderId);
  // KHÔNG gửi nội dung acc cho khách ở đây — tầng route tự gửi.
  // Tool vẫn trả line để route có thể lấy, nhưng agent được dặn chỉ báo "đã giao".
  const out = { ok: res.ok };
  if (res.ok) {
    out.line = res.line;
    out.remaining = res.remaining;
    if (res.order && res.order.order_code) out.order_code = res.order.order_code;
  } else {
    out.error = res.error || 'Giao đơn thất bại';
  }
  return out;
}

async function toolCancelOrder(args) {
  const orderId = parsePositiveInt(args.order_id, 'order_id');
  const { cancelOrder } = await import('../orders/orders.js');
  const res = cancelOrder(orderId);
  if (!res.ok) return { ok: false, order_id: orderId, error: res.error || 'Hủy đơn thất bại' };
  return { ok: true, order_id: orderId };
}

function toolListFaqs() {
  const db = getDb();
  return db
    .prepare('SELECT id, question, answer, updated_at FROM faqs ORDER BY id DESC LIMIT 100')
    .all();
}

async function toolAddFaq(args) {
  const question = normStr(args.question).trim();
  const answer = normStr(args.answer).trim();
  if (!question) throw new Error('question là bắt buộc');
  if (!answer) throw new Error('answer là bắt buộc');
  const db = getDb();
  const r = db.prepare('INSERT INTO faqs (question, answer) VALUES (?, ?)').run(question, answer);
  const id = Number(r.lastInsertRowid);
  try {
    const { indexFaq } = await import('../rag/indexer.js');
    await indexFaq(id);
  } catch (err) {
    logger.warn('adminAgent add-faq index failed', { id, error: err.message });
  }
  return { id, question, answer };
}

async function toolDeleteFaq(args) {
  const id = parsePositiveInt(args.id, 'id');
  const db = getDb();
  const row = db.prepare('SELECT id FROM faqs WHERE id = ?').get(id);
  if (!row) throw new Error(`Không tìm thấy FAQ id: ${id}`);
  db.prepare('DELETE FROM faqs WHERE id = ?').run(id);
  try {
    const { deleteSourceVectors } = await import('../rag/indexer.js');
    await deleteSourceVectors('faq', id);
  } catch (err) {
    logger.warn('adminAgent delete-faq unindex failed', { id, error: err.message });
  }
  return { ok: true, id };
}

function toolGetCustomer(args) {
  const id = parsePositiveInt(args.id, 'id');
  const db = getDb();
  ensureCustomersTable(db);
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!row) throw new Error(`Không tìm thấy khách hàng id: ${id}`);
  return row;
}

function toolSetHandoff(args) {
  const customerId = parsePositiveInt(args.customer_id, 'customer_id');
  const on = parseZeroOne(args.on, 'on');
  const db = getDb();
  ensureCustomersTable(db);
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!row) throw new Error(`Không tìm thấy khách hàng id: ${customerId}`);
  db.prepare('UPDATE customers SET human_handoff = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    on,
    customerId
  );
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
}

function toolSetLead(args) {
  const customerId = parsePositiveInt(args.customer_id, 'customer_id');
  const hasStatus =
    args.lead_status !== undefined && args.lead_status !== null && normStr(args.lead_status).trim() !== '';
  const hasNotes = args.notes !== undefined && args.notes !== null && normStr(args.notes).trim() !== '';
  if (!hasStatus && !hasNotes) throw new Error('Cần truyền ít nhất lead_status hoặc notes');
  const db = getDb();
  ensureCustomersTable(db);
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!row) throw new Error(`Không tìm thấy khách hàng id: ${customerId}`);
  if (hasStatus && hasNotes) {
    db.prepare(
      'UPDATE customers SET lead_status = ?, notes = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(normStr(args.lead_status).trim(), normStr(args.notes).trim(), customerId);
  } else if (hasStatus) {
    db.prepare('UPDATE customers SET lead_status = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      normStr(args.lead_status).trim(),
      customerId
    );
  } else {
    db.prepare('UPDATE customers SET notes = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      normStr(args.notes).trim(),
      customerId
    );
  }
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
}

function toolGetSetting(args) {
  const key = normStr(args.key).trim();
  if (!key) throw new Error('key là bắt buộc');
  if (!SETTING_ALLOWLIST.includes(key)) {
    throw new Error(`key không được phép (nhận: ${key}). Cho phép: ${SETTING_ALLOWLIST.join(', ')}`);
  }
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return { key, value: row ? row.value : '' };
}

function toolSetSetting(args) {
  const key = normStr(args.key).trim();
  if (!key) throw new Error('key là bắt buộc');
  if (!SETTING_ALLOWLIST.includes(key)) {
    throw new Error(`key không được phép (nhận: ${key}). Cho phép: ${SETTING_ALLOWLIST.join(', ')}`);
  }
  const value = args.value === undefined || args.value === null ? '' : String(args.value);
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
  ).run(key, value);
  return { key, value };
}

async function toolStats() {
  const db = getDb();
  const count = (sql) => {
    try {
      return db.prepare(sql).get().c;
    } catch {
      return 0;
    }
  };
  const products = count('SELECT COUNT(*) AS c FROM products');
  const faqs = count('SELECT COUNT(*) AS c FROM faqs');
  const customers = count('SELECT COUNT(*) AS c FROM customers');
  const messages = count('SELECT COUNT(*) AS c FROM conversations');
  let ordersByStatus = {};
  try {
    const rows = db.prepare('SELECT status, COUNT(*) AS c FROM orders GROUP BY status').all();
    for (const r of rows) ordersByStatus[r.status] = r.c;
  } catch {
    ordersByStatus = {};
  }
  let accFiles = [];
  try {
    const { listAccFiles } = await import('../orders/stock.js');
    accFiles = listAccFiles();
  } catch (err) {
    logger.warn('adminAgent stats acc files failed', { error: err.message });
  }
  let activePrompt = config.activeSystemPrompt;
  try {
    const { getActivePromptFile } = await import('./systemPrompt.js');
    activePrompt = getActivePromptFile();
  } catch (err) {
    logger.warn('adminAgent stats active prompt failed', { error: err.message });
  }
  return { products, faqs, customers, messages, orders_by_status: ordersByStatus, acc_files: accFiles, active_prompt: activePrompt };
}

function toolExportProductsCsv() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT sku, name, description, price, stock_quantity, category, image_url, is_active, acc_file
       FROM products ORDER BY id ASC LIMIT 500`
    )
    .all();
  const header = 'sku,name,description,price,stock_quantity,category,image_url,is_active,acc_file';
  const lines = rows.map((r) =>
    [
      csvEscape(r.sku),
      csvEscape(r.name),
      csvEscape(r.description),
      csvEscape(r.price),
      csvEscape(r.stock_quantity),
      csvEscape(r.category),
      csvEscape(r.image_url),
      csvEscape(r.is_active),
      csvEscape(r.acc_file),
    ].join(',')
  );
  return { csv: [header, ...lines].join('\n') };
}

export const ADMIN_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'admin_list_products',
      description: 'Liệt kê tối đa 30 sản phẩm mới nhất (id, sku, name, price, stock, acc_file).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_get_product',
      description: 'Xem chi tiết 1 sản phẩm theo sku hoặc id (gồm description, category, image, acc_file, qr).',
      parameters: {
        type: 'object',
        properties: {
          sku_or_id: { type: 'string', description: 'SKU hoặc id sản phẩm' },
        },
        required: ['sku_or_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_set_stock',
      description: 'Đặt tồn kho mới cho 1 sản phẩm theo sku hoặc id. quantity phải là số nguyên >= 0.',
      parameters: {
        type: 'object',
        properties: {
          sku_or_id: { type: 'string', description: 'SKU hoặc id sản phẩm' },
          quantity: { type: 'integer', description: 'Tồn kho mới (>= 0)' },
        },
        required: ['sku_or_id', 'quantity'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_toggle_product',
      description: 'Bật/tắt bán 1 sản phẩm theo sku hoặc id. is_active chỉ nhận 0 (ngừng bán) hoặc 1 (đang bán). Dùng thay cho xóa sản phẩm.',
      parameters: {
        type: 'object',
        properties: {
          sku_or_id: { type: 'string', description: 'SKU hoặc id sản phẩm' },
          is_active: { type: 'integer', description: '0 = ngừng bán, 1 = đang bán', enum: [0, 1] },
        },
        required: ['sku_or_id', 'is_active'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_upsert_product',
      description: 'Thêm mới hoặc cập nhật sản phẩm theo sku (INSERT ON CONFLICT sku DO UPDATE). price >= 0, stock_quantity nguyên >= 0.',
      parameters: {
        type: 'object',
        properties: {
          sku: { type: 'string', description: 'Mã SKU (khóa, bắt buộc)' },
          name: { type: 'string', description: 'Tên sản phẩm (bắt buộc)' },
          price: { type: 'number', description: 'Giá bán VNĐ (>= 0, bắt buộc)' },
          stock_quantity: { type: 'integer', description: 'Tồn kho (nguyên >= 0, mặc định 0)' },
          category: { type: 'string', description: 'Danh mục (tùy chọn)' },
          description: { type: 'string', description: 'Mô tả (tùy chọn)' },
          acc_file: { type: 'string', description: 'Tên file acc .txt trong thư mục acc (tùy chọn, để trống = không bán acc)' },
        },
        required: ['sku', 'name', 'price'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_write_prompt',
      description: 'Ghi (tạo mới hoặc ghi đè) 1 system-prompt file .md. filename dạng chữ-số-gạch (vd: sales.md). Nên đọc trước bằng admin_read_prompt.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Tên file .md' },
          content: { type: 'string', description: 'Nội dung prompt' },
        },
        required: ['filename', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_read_prompt',
      description: 'Đọc nội dung 1 system-prompt file .md (để xem trước khi sửa).',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Tên file .md đã tồn tại' },
        },
        required: ['filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_select_prompt',
      description: 'Chọn prompt file đang hoạt động (active override). File phải tồn tại.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Tên file .md đã tồn tại' },
        },
        required: ['filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_list_acc_files',
      description: 'Liệt kê các file acc .txt trong thư viện kèm số dòng còn lại.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_list_orders',
      description: 'Liệt kê tối đa 50 đơn hàng mới nhất, lọc theo status (để trống = tất cả).',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Trạng thái đơn',
            enum: ORDER_STATUSES,
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_deliver_order',
      description: 'Xác minh & giao 1 đơn (trừ kho acc, đánh dấu delivered). order_id phải là số nguyên dương. KHÔNG in nội dung acc ra chat — chỉ báo "đã giao", nội dung acc do tầng route gửi.',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'integer', description: 'ID đơn hàng (> 0)' },
        },
        required: ['order_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_cancel_order',
      description: 'Hủy 1 đơn chưa giao. order_id phải là số nguyên dương.',
      parameters: {
        type: 'object',
        properties: {
          order_id: { type: 'integer', description: 'ID đơn hàng (> 0)' },
        },
        required: ['order_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_list_faqs',
      description: 'Liệt kê tối đa 100 FAQ mới nhất (id, question, answer).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_add_faq',
      description: 'Thêm 1 FAQ mới (question và answer đều bắt buộc). Tự re-embed để chatbot học ngay.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Câu hỏi' },
          answer: { type: 'string', description: 'Câu trả lời' },
        },
        required: ['question', 'answer'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_delete_faq',
      description: 'Xóa 1 FAQ theo id (id phải là số nguyên dương). Đây là thao tác xóa được phép.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'ID FAQ (> 0)' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_get_customer',
      description: 'Xem chi tiết 1 khách hàng theo id (id phải là số nguyên dương).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'ID khách hàng (> 0)' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_set_handoff',
      description: 'Bật/tắt chuyển cho nhân viên trực (human_handoff) của 1 khách. on chỉ nhận 0 (bot trả lời) hoặc 1 (chờ nhân viên).',
      parameters: {
        type: 'object',
        properties: {
          customer_id: { type: 'integer', description: 'ID khách hàng (> 0)' },
          on: { type: 'integer', description: '0 = bot trả lời, 1 = chờ nhân viên', enum: [0, 1] },
        },
        required: ['customer_id', 'on'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_set_lead',
      description: 'Cập nhật trạng thái/ghi chú khách hàng (lead_status và/hoặc notes, ít nhất 1 trường).',
      parameters: {
        type: 'object',
        properties: {
          customer_id: { type: 'integer', description: 'ID khách hàng (> 0)' },
          lead_status: { type: 'string', description: 'Trạng thái lead (tùy chọn)' },
          notes: { type: 'string', description: 'Ghi chú (tùy chọn)' },
        },
        required: ['customer_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_get_setting',
      description: 'Đọc 1 cài đặt shop. Chỉ cho phép các khóa: shop_name, support_phone, announcement.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Khóa cài đặt', enum: SETTING_ALLOWLIST },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_set_setting',
      description: 'Ghi 1 cài đặt shop. Chỉ cho phép các khóa: shop_name, support_phone, announcement. Không đổi đường dẫn file qua chat.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Khóa cài đặt', enum: SETTING_ALLOWLIST },
          value: { type: 'string', description: 'Giá trị mới' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_stats',
      description: 'Xem tổng quan shop: số sản phẩm/FAQ/khách/tin nhắn, đơn theo trạng thái, file acc, prompt đang hoạt động.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'admin_export_products_csv',
      description: 'Xuất tối đa 500 sản phẩm ra chuỗi CSV (header sku,name,description,price,stock_quantity,category,image_url,is_active,acc_file) để copy-paste.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

async function execAdminTool(name, args) {
  switch (name) {
    case 'admin_list_products':
      return toolListProducts();
    case 'admin_get_product':
      return toolGetProduct(args || {});
    case 'admin_set_stock':
      return toolSetStock(args || {});
    case 'admin_toggle_product':
      return toolToggleProduct(args || {});
    case 'admin_upsert_product':
      return toolUpsertProduct(args || {});
    case 'admin_write_prompt':
      return toolWritePrompt(args || {});
    case 'admin_read_prompt':
      return toolReadPrompt(args || {});
    case 'admin_select_prompt':
      return toolSelectPrompt(args || {});
    case 'admin_list_acc_files':
      return toolListAccFiles();
    case 'admin_list_orders':
      return toolListOrders(args || {});
    case 'admin_deliver_order':
      return toolDeliverOrder(args || {});
    case 'admin_cancel_order':
      return toolCancelOrder(args || {});
    case 'admin_list_faqs':
      return toolListFaqs();
    case 'admin_add_faq':
      return toolAddFaq(args || {});
    case 'admin_delete_faq':
      return toolDeleteFaq(args || {});
    case 'admin_get_customer':
      return toolGetCustomer(args || {});
    case 'admin_set_handoff':
      return toolSetHandoff(args || {});
    case 'admin_set_lead':
      return toolSetLead(args || {});
    case 'admin_get_setting':
      return toolGetSetting(args || {});
    case 'admin_set_setting':
      return toolSetSetting(args || {});
    case 'admin_stats':
      return toolStats();
    case 'admin_export_products_csv':
      return toolExportProductsCsv();
    case 'web_search': {
      const { webSearch } = await import('../tools/webSearch.js');
      return webSearch({ query: (args || {}).query });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- sessions ---

export async function chatWithAdmin({ sessionId, message, useWebSearch = false, useThinking = false } = {}) {
  const db = ensureAdminTables();
  const text = normStr(message).trim();
  const sid = resolveSessionId(db, sessionId);
  if (!text) return { reply: 'Bạn hãy nhập nội dung cần hỏi nhé.', sessionId: sid };

  db.prepare('INSERT INTO admin_messages (session_id, role, content) VALUES (?, ?, ?)').run(sid, 'user', text);

  const rows = db
    .prepare('SELECT role, content FROM admin_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?')
    .all(sid, SESSION_HISTORY_CAP)
    .reverse();
  const sessionHistory = rows.map((r) => ({ role: r.role, content: r.content }));

  const finish = (reply) => {
    db.prepare('INSERT INTO admin_messages (session_id, role, content) VALUES (?, ?, ?)').run(
      sid,
      'assistant',
      reply
    );
    touchSession(db, sid);
    maybeAutoTitle(db, sid);
    return { reply, sessionId: sid };
  };

  const tools = [...ADMIN_TOOL_DEFS];
  if (useWebSearch && config.enableWebSearch && config.webSearchApiKey) {
    try {
      const { getWebSearchToolDefinition } = await import('../tools/webSearch.js');
      const def = getWebSearchToolDefinition();
      if (def) tools.push(def);
    } catch (err) {
      logger.warn('adminAgent web_search def unavailable', { error: err.message });
    }
  }

  const messages = [{ role: 'system', content: ADMIN_SYSTEM_PROMPT }, ...sessionHistory];

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const resp = await chatCompletion({
        messages,
        tools,
        temperature: config.llmTemperature,
        maxTokens: config.llmMaxTokens,
        think: Boolean(useThinking),
      });
      const toolCalls = resp.toolCalls;

      if (toolCalls.length === 0) {
        // Plain text where tool calls were expected is a valid answer.
        const reply = normStr(resp.content).trim() || '(trợ lý không trả lời được, bạn thử hỏi lại nhé)';
        return finish(reply);
      }

      // Rebuild the assistant turn in the OpenAI shape: replaying the raw
      // response message would leak runtime-only fields, and `arguments` has to
      // go back as a JSON string.
      messages.push({
        role: 'assistant',
        content: normStr(resp.content),
        tool_calls: toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) },
        })),
      });

      for (const call of toolCalls) {
        let result;
        try {
          result = await execAdminTool(call.name, call.arguments || {});
        } catch (err) {
          result = { error: err.message };
        }
        logger.info('ADMIN_AGENT_TOOL', { tool: call.name, sessionId: sid });
        // tool_call_id is mandatory: the model matches the result to its request.
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 8000),
        });
      }
    }
    return finish('Mình đã tra cứu xong nhưng chưa tổng hợp được câu trả lời. Bạn hỏi lại cụ thể hơn nhé.');
  } catch (err) {
    logger.error('adminAgent chat failed', { error: err.message });
    // Probe once so the operator gets the actionable "is LM Studio running?"
    // message instead of a generic failure.
    const health = await healthCheck();
    if (!health.ok) {
      return finish('Xin lỗi, không kết nối được tới LM Studio. Bạn kiểm tra lại LM Studio đang chạy và đã load model chưa nhé.');
    }
    return finish('Xin lỗi, trợ lý AI đang gặp sự cố (LM Studio). Bạn thử lại sau ít phút nhé.');
  }
}

export function listSessions() {
  const db = ensureAdminTables();
  return db
    .prepare(
      `SELECT s.id, s.title, s.updated_at, COUNT(m.id) AS message_count
       FROM admin_sessions s LEFT JOIN admin_messages m ON m.session_id = s.id
       GROUP BY s.id ORDER BY s.updated_at DESC LIMIT 50`
    )
    .all();
}

export function getSessionMessages(sessionId) {
  const db = ensureAdminTables();
  const id = parseSessionId(sessionId);
  if (id === null) return [];
  const sess = db.prepare('SELECT id FROM admin_sessions WHERE id = ?').get(id);
  if (!sess) return [];
  return db
    .prepare('SELECT role, content FROM admin_messages WHERE session_id = ? ORDER BY id ASC')
    .all(id);
}

export function deleteSession(sessionId) {
  const db = ensureAdminTables();
  const id = parseSessionId(sessionId);
  if (id === null) return { ok: true };
  db.prepare('DELETE FROM admin_messages WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM admin_sessions WHERE id = ?').run(id);
  return { ok: true };
}
