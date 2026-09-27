// src/admin/routes.js — Phase 4 Admin UI.
//
// ROUTER EXPORT (single named export — this file exports exactly one symbol):
//   export const adminRouter
//
// Mount in src/server.js (auth is applied there via adminAuth — do NOT add auth here):
//   import { adminRouter } from './admin/routes.js';
//   app.set('view engine', 'ejs');                 // NOTE: `ejs` must be installed separately
//   app.set('views', adminRouter.viewsDirectory);  // -> src/admin/views
//   app.use('/admin', adminRouter);
//
// Notes:
// - CSV import has NO multer/file-upload: forms paste CSV text into <textarea name="csv">.
// - Every POST handler validates input, never throws to the client, and redirects on success.
// - After product/FAQ create/update, RAG re-index is best-effort: DB save always wins,
//   and an index failure appends ?index_error=1 to the redirect.

import { Router } from 'express';
import multer from 'multer';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, extname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../db/migrate.js';
import { indexProduct, indexFaq, deleteSourceVectors } from '../rag/indexer.js';
import {
  listPromptFiles,
  readPromptFile,
  writePromptFile,
  getActivePromptFile,
} from '../core/systemPrompt.js';
import { config } from '../config.js';
import { logger } from '../services/logger.js';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import {
  ACC_DIR,
  UPLOAD_DIR,
  ensureStorage,
  safeAccPath,
  listAccFiles,
  getSetting,
  setSetting,
} from '../orders/stock.js';
import { chatWithAdmin, listSessions, getSessionMessages, deleteSession } from '../core/adminAgent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const adminRouter = Router();

// Absolute path of the EJS views directory (src/admin/views).
// Convenience for server.js: app.set('views', adminRouter.viewsDirectory).
adminRouter.viewsDirectory = resolve(__dirname, 'views');

// ---------------------------------------------------------------- helpers ---

const LEAD_STATUSES = ['new', 'interested', 'qualified', 'customer', 'closed'];

const PRODUCT_CSV_COLUMNS = [
  'sku',
  'name',
  'description',
  'price',
  'stock_quantity',
  'category',
  'image_url',
  'is_active',
];

const FAQ_CSV_COLUMNS = ['question', 'answer'];

const PROMPT_CREATE_RE = /^[a-zA-Z0-9_-]+\.md$/;

function baseUrl(req) {
  return req.baseUrl || '/admin';
}

function normStr(v) {
  if (v === undefined || v === null) return '';
  return String(v);
}

function emptyToNull(s) {
  const t = normStr(s).trim();
  return t === '' ? null : t;
}

// price: empty -> null (allowed); otherwise must be a finite number >= 0.
function parsePrice(raw) {
  if (raw === undefined || raw === null || normStr(raw).trim() === '') {
    return { ok: true, value: null };
  }
  const n = Number(normStr(raw).trim());
  if (!Number.isFinite(n) || n < 0) return { ok: false, value: null };
  return { ok: true, value: n };
}

// stock: empty -> 0; otherwise must be an integer string >= 0.
function parseStock(raw) {
  if (raw === undefined || raw === null || normStr(raw).trim() === '') {
    return { ok: true, value: 0 };
  }
  const s = normStr(raw).trim();
  if (!/^\d+$/.test(s)) return { ok: false, value: 0 };
  return { ok: true, value: parseInt(s, 10) };
}

function parseIsActive(raw, defaultValue = 1) {
  if (raw === undefined || raw === null || normStr(raw).trim() === '') return defaultValue;
  const v = normStr(raw).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(v)) return 1;
  if (['0', 'false', 'off', 'no'].includes(v)) return 0;
  return defaultValue;
}

// Guard for prompt filenames coming from the URL: reject path traversal.
// (Express would not match '/' inside one :param segment, but '..' must be rejected.)
function isUnsafePromptFilename(fn) {
  if (typeof fn !== 'string' || fn.length === 0) return true;
  return (
    fn.includes('/') || fn.includes('\\') || fn.includes('..') || fn.includes('\0')
  );
}

// Escape %, _ and \ for LIKE ... ESCAPE '\' searches.
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

// CSRF guard for all POST /admin: if Origin (else Referer) is present and its
// host differs from the request Host, reject with 403. Same-origin admin form
// posts always match; API clients that send neither header still pass
// (Basic Auth remains the real gate).
function checkSameOrigin(req, res, next) {
  const origin = req.get('Origin') || req.get('Referer');
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return res.status(403).send('Forbidden: invalid Origin');
    }
    const host = (req.get('Host') || '').toLowerCase();
    if (!host || originHost !== host) {
      return res.status(403).send('Forbidden: cross-origin POST rejected');
    }
  }
  next();
}

adminRouter.use((req, res, next) => {
  if (req.method === 'POST') return checkSameOrigin(req, res, next);
  next();
});

// CSV import caps: shared by products/faqs paste-import handlers.
const CSV_MAX_CHARS = 200000;
const CSV_MAX_ROWS = 500;
const NAME_MAX = 200; // product name / faq question
const DESC_MAX = 5000; // product description / faq answer

function csvTooLarge(raw) {
  return raw.length > CSV_MAX_CHARS;
}

function capStr(s, max) {
  const t = String(s ?? '');
  return t.length > max ? t.slice(0, max) : t;
}

// ---------------------------------------------------------------- uploads (AGENT-B) ---
//
// multer memoryStorage uploaders: files are validated here, then written to
// disk explicitly (never trust the client filename for the destination).

const qrUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'image/png' || file.mimetype === 'image/jpeg') return cb(null, true);
    cb(new Error('File QR phải là ảnh PNG hoặc JPG (tối đa 2MB).'));
  },
});

const accUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = extname(file.originalname || '').toLowerCase();
    if (ext === '.txt') return cb(null, true);
    cb(new Error('File acc phải có đuôi .txt (tối đa 1MB).'));
  },
});

// Run a multer single-file middleware inside a handler so upload errors can be
// shown on the form instead of hitting the generic JSON error handler.
function runSingleUpload(req, res, mw) {
  return new Promise((resolve) => {
    mw(req, res, (err) => resolve(err || null));
  });
}

function multerErrMessage(err) {
  if (!err) return null;
  if (err.code === 'LIMIT_FILE_SIZE') return 'File quá lớn (vượt giới hạn dung lượng).';
  return err.message || 'Upload thất bại.';
}

// Best-effort acc-file list for form dropdowns (never throws to the client).
function safeListAccFiles() {
  try {
    return listAccFiles();
  } catch (err) {
    logger.warn('safeListAccFiles failed', { error: err.message });
    return [];
  }
}

// Validate the acc_file dropdown value: '' = no acc; otherwise must be a known
// library file (prevents stale/forged values).
function validateAccFile(raw, accFiles) {
  const v = normStr(raw).trim();
  if (!v) return { ok: true, value: null };
  if (!accFiles.some((f) => f.file === v)) {
    return { ok: false, value: null, error: `File acc không tồn tại trong thư viện: ${v}` };
  }
  return { ok: true, value: v };
}

// '.png' | '.jpg' | null based on mimetype (fallback: original extension).
function qrExtFor(file) {
  if (file.mimetype === 'image/png') return '.png';
  if (file.mimetype === 'image/jpeg') return '.jpg';
  const ext = extname(file.originalname || '').toLowerCase();
  if (ext === '.png') return '.png';
  if (ext === '.jpg' || ext === '.jpeg') return '.jpg';
  return null;
}

// Save per-product QR as UPLOAD_DIR/qr_<id>.<ext>; removes a stale sibling
// with the other extension. Returns the absolute path, or throws.
function saveProductQr(productId, file) {
  const ext = qrExtFor(file);
  if (!ext) throw new Error('File QR phải là ảnh PNG hoặc JPG.');
  ensureStorage();
  const dest = join(UPLOAD_DIR, `qr_${productId}${ext}`);
  writeFileSync(dest, file.buffer);
  for (const other of ext === '.png' ? ['.jpg'] : ['.png']) {
    const stale = join(UPLOAD_DIR, `qr_${productId}${other}`);
    if (stale !== dest && existsSync(stale)) {
      try {
        unlinkSync(stale);
      } catch {
        // best-effort
      }
    }
  }
  return dest;
}

// Basename of a stored absolute path for preview URLs (null when none).
function uploadPreviewName(absPath) {
  if (!absPath) return null;
  const b = basename(String(absPath));
  if (!b || b === '.' || b === '..') return null;
  return b;
}

// ---------------------------------------------------------------- dashboard ---

// GET /admin/ — dashboard with entity counts.
adminRouter.get('/', async (req, res, next) => {
  try {
    const db = getDb();
    const products = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
    const faqs = db.prepare('SELECT COUNT(*) AS c FROM faqs').get().c;
    const customers = db.prepare('SELECT COUNT(*) AS c FROM customers').get().c;
    const messages = db.prepare('SELECT COUNT(*) AS c FROM conversations').get().c;
    let pendingVerify = 0;
    try {
      const { countPendingVerify } = await import('../orders/orders.js');
      pendingVerify = countPendingVerify();
    } catch (err) {
      logger.warn('dashboard countPendingVerify failed', { error: err.message });
    }
    res.render('dashboard', { counts: { products, faqs, customers, messages, pendingVerify } });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- guide ---

// GET /admin/huong-dan — trang hướng dẫn sử dụng cho admin không biết code.
adminRouter.get('/huong-dan', (req, res, next) => {
  try {
    res.render('huong-dan', {
      webSearchOn: config.enableWebSearch,
      chatModel: config.lmStudioChatModel,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- products ---

// GET /admin/products — list with optional ?q= search (name / sku / category).
adminRouter.get('/products', (req, res, next) => {
  try {
    const db = getDb();
    const q = normStr(req.query.q).trim();
    let products;
    if (q) {
      const like = `%${escapeLike(q)}%`;
      products = db
        .prepare(
          `SELECT * FROM products
           WHERE name LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\'
           ORDER BY updated_at DESC, id DESC`
        )
        .all(like, like, like);
    } else {
      products = db
        .prepare('SELECT * FROM products ORDER BY updated_at DESC, id DESC')
        .all();
    }
    res.render('products_list', { products, q, index_error: req.query.index_error });
  } catch (err) {
    next(err);
  }
});

// GET /admin/products/new — empty create form.
adminRouter.get('/products/new', (req, res, next) => {
  try {
    res.render('products_form', {
      isEdit: false,
      action: `${baseUrl(req)}/products`,
      errors: [],
      accFiles: safeListAccFiles(),
      qrPreview: null,
      product: {
        id: null,
        sku: '',
        name: '',
        description: '',
        price: '',
        stock_quantity: 0,
        category: '',
        image_url: '',
        is_active: 1,
        acc_file: '',
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/products/export — download all products as CSV.
adminRouter.get('/products/export', (req, res, next) => {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT sku, name, description, price, stock_quantity, category, image_url, is_active
         FROM products ORDER BY id ASC`
      )
      .all();
    const csv = stringify(rows, { header: true, columns: PRODUCT_CSV_COLUMNS });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="products.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// GET /admin/products/import — paste-CSV form (no file upload; multer not used).
adminRouter.get('/products/import', (req, res, next) => {
  try {
    res.render('products_import', { result: null, csv: '' });
  } catch (err) {
    next(err);
  }
});

// POST /admin/products — create. Validates name (required), price (>= 0), stock (int >= 0).
// Multipart form (multer memory): optional `qr_image` (png/jpg <= 2MB) + `acc_file` dropdown.
adminRouter.post('/products', async (req, res, next) => {
  const base = baseUrl(req);
  try {
    const uploadErr = await runSingleUpload(req, res, qrUpload.single('qr_image'));
    const uploadErrMsg = multerErrMessage(uploadErr);
    const body = req.body || {};
    const errors = [];
    if (uploadErrMsg) errors.push(uploadErrMsg);
    const name = normStr(body.name).trim();
    if (!name) errors.push('Tên sản phẩm (name) là bắt buộc.');
    const priceParsed = parsePrice(body.price);
    if (!priceParsed.ok) errors.push('Giá (price) phải là số >= 0.');
    const stockParsed = parseStock(body.stock_quantity);
    if (!stockParsed.ok) errors.push('Tồn kho (stock_quantity) phải là số nguyên >= 0.');
    const accFiles = safeListAccFiles();
    const accParsed = validateAccFile(body.acc_file, accFiles);
    if (!accParsed.ok) errors.push(accParsed.error);

    const product = {
      id: null,
      sku: normStr(body.sku).trim(),
      name,
      description: normStr(body.description),
      price: priceParsed.ok ? (body.price === undefined || normStr(body.price).trim() === '' ? '' : priceParsed.value) : normStr(body.price),
      stock_quantity: stockParsed.ok ? stockParsed.value : normStr(body.stock_quantity),
      category: normStr(body.category).trim(),
      image_url: normStr(body.image_url).trim(),
      is_active: parseIsActive(body.is_active, 1),
      acc_file: normStr(body.acc_file).trim(),
    };

    if (errors.length > 0) {
      res.status(400);
      return res.render('products_form', {
        isEdit: false,
        action: `${base}/products`,
        errors,
        accFiles,
        qrPreview: null,
        product,
      });
    }

    const db = getDb();
    const info = db
      .prepare(
        `INSERT INTO products
         (sku, name, description, price, stock_quantity, category, image_url, is_active, acc_file, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      )
      .run(
        emptyToNull(product.sku),
        name,
        emptyToNull(product.description),
        priceParsed.value,
        stockParsed.value,
        emptyToNull(product.category),
        emptyToNull(product.image_url),
        product.is_active ? 1 : 0,
        accParsed.value
      );
    const id = Number(info.lastInsertRowid);

    // Per-product QR: insert first (need id), then save file + update row.
    if (req.file) {
      try {
        const qrPath = saveProductQr(id, req.file);
        db.prepare('UPDATE products SET qr_image_path = ? WHERE id = ?').run(qrPath, id);
      } catch (err) {
        // DB row already saved — QR failure must not lose the product.
        logger.warn('POST /products QR save failed', { id, error: err.message });
      }
    }

    // Best-effort RAG re-index: DB save wins; on failure flag ?index_error=1.
    try {
      await indexProduct(id);
    } catch (err) {
      logger.warn('POST /products index failed', { id, error: err.message });
      return res.redirect(`${base}/products?index_error=1`);
    }
    return res.redirect(`${base}/products`);
    } catch (err) {
    logger.error('POST /products failed', { error: err.message });
    // Never crash: fall back to the list on unexpected errors.
    return res.redirect(`${base}/products`);
  }
});

// GET /admin/products/:id/edit — edit form.
adminRouter.get('/products/:id/edit', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).send('Product not found');
    const db = getDb();
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!product) return res.status(404).send('Product not found');
    res.render('products_form', {
      isEdit: true,
      action: `${baseUrl(req)}/products/${id}`,
      errors: [],
      accFiles: safeListAccFiles(),
      qrPreview: uploadPreviewName(product.qr_image_path),
      product: {
        ...product,
        price: product.price === null || product.price === undefined ? '' : product.price,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/products/:id — update (same validation as create + optional QR overwrite).
adminRouter.post('/products/:id', async (req, res, next) => {
  const base = baseUrl(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.redirect(`${base}/products`);
  try {
    const uploadErr = await runSingleUpload(req, res, qrUpload.single('qr_image'));
    const uploadErrMsg = multerErrMessage(uploadErr);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) return res.status(404).send('Product not found');

    const body = req.body || {};
    const errors = [];
    if (uploadErrMsg) errors.push(uploadErrMsg);
    const name = normStr(body.name).trim();
    if (!name) errors.push('Tên sản phẩm (name) là bắt buộc.');
    const priceParsed = parsePrice(body.price);
    if (!priceParsed.ok) errors.push('Giá (price) phải là số >= 0.');
    const stockParsed = parseStock(body.stock_quantity);
    if (!stockParsed.ok) errors.push('Tồn kho (stock_quantity) phải là số nguyên >= 0.');
    const accFiles = safeListAccFiles();
    const accParsed = validateAccFile(body.acc_file, accFiles);
    if (!accParsed.ok) errors.push(accParsed.error);

    const product = {
      ...existing,
      sku: normStr(body.sku).trim(),
      name,
      description: normStr(body.description),
      price: priceParsed.ok ? (body.price === undefined || normStr(body.price).trim() === '' ? '' : priceParsed.value) : normStr(body.price),
      stock_quantity: stockParsed.ok ? stockParsed.value : normStr(body.stock_quantity),
      category: normStr(body.category).trim(),
      image_url: normStr(body.image_url).trim(),
      is_active: parseIsActive(body.is_active, 1),
      acc_file: normStr(body.acc_file).trim(),
    };

    if (errors.length > 0) {
      res.status(400);
      return res.render('products_form', {
        isEdit: true,
        action: `${base}/products/${id}`,
        errors,
        accFiles,
        qrPreview: uploadPreviewName(existing.qr_image_path),
        product,
      });
    }

    let qrPath = existing.qr_image_path || null;
    if (req.file) {
      try {
        qrPath = saveProductQr(id, req.file);
      } catch (err) {
        res.status(400);
        return res.render('products_form', {
          isEdit: true,
          action: `${base}/products/${id}`,
          errors: [err.message],
          accFiles,
          qrPreview: uploadPreviewName(existing.qr_image_path),
          product,
        });
      }
    }

    db.prepare(
      `UPDATE products SET
       sku = ?, name = ?, description = ?, price = ?, stock_quantity = ?,
       category = ?, image_url = ?, is_active = ?, acc_file = ?, qr_image_path = ?,
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(
      emptyToNull(product.sku),
      name,
      emptyToNull(product.description),
      priceParsed.value,
      stockParsed.value,
      emptyToNull(product.category),
      emptyToNull(product.image_url),
      product.is_active ? 1 : 0,
      accParsed.value,
      qrPath,
      id
    );

    try {
      await indexProduct(id);
    } catch (err) {
      logger.warn('POST /products index failed', { id, error: err.message });
      return res.redirect(`${base}/products?index_error=1`);
    }
    return res.redirect(`${base}/products`);
  } catch (err) {
    logger.error('POST /products/:id failed', { id, error: err.message });
    return res.redirect(`${base}/products`);
  }
});

// POST /admin/products/:id/delete — delete row + its RAG vectors.
adminRouter.post('/products/:id/delete', async (req, res) => {
  const base = baseUrl(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.redirect(`${base}/products`);
    const db = getDb();
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    try {
      await deleteSourceVectors('product', id);
    } catch (err) {
      // Vector cleanup is best-effort; the DB delete already succeeded.
      logger.warn('POST /products/:id/delete vector cleanup failed', { id, error: err.message });
    }
    return res.redirect(`${base}/products`);
  } catch (err) {
    logger.error('POST /products/:id/delete failed', { error: err.message });
    return res.redirect(`${base}/products`);
  }
});

// POST /admin/products/import — parse pasted CSV text (field `csv`), upsert by sku.
adminRouter.post('/products/import', async (req, res, next) => {
  try {
    const raw = req.body && req.body.csv !== undefined ? String(req.body.csv) : '';
    const done = (result) => res.render('products_import', { result, csv: raw });
    if (csvTooLarge(raw)) {
      res.status(413);
      return done({
        created: 0,
        updated: 0,
        indexErrors: 0,
        errors: [`CSV quá lớn: tối đa ${CSV_MAX_CHARS} ký tự và ${CSV_MAX_ROWS} dòng.`],
      });
    }
    if (!raw.trim()) {
      return done({
        created: 0,
        updated: 0,
        indexErrors: 0,
        errors: ['Nội dung CSV trống. Hãy dán CSV (kèm dòng header) vào ô bên dưới.'],
      });
    }
    let records;
    try {
      records = parse(raw, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    } catch (err) {
      return done({ created: 0, updated: 0, indexErrors: 0, errors: ['CSV không hợp lệ: ' + err.message] });
    }
    if (records.length > CSV_MAX_ROWS) {
      res.status(413);
      return done({
        created: 0,
        updated: 0,
        indexErrors: 0,
        errors: [`CSV quá nhiều dòng: tối đa ${CSV_MAX_ROWS} dòng (nhận ${records.length}).`],
      });
    }

    const db = getDb();
    const findBySku = db.prepare('SELECT id FROM products WHERE sku = ?');
    const insertStmt = db.prepare(
      `INSERT INTO products
       (sku, name, description, price, stock_quantity, category, image_url, is_active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    );
    const updateStmt = db.prepare(
      `UPDATE products SET
       name = ?, description = ?, price = ?, stock_quantity = ?,
       category = ?, image_url = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    );

    let created = 0;
    let updated = 0;
    let indexErrors = 0;
    const errors = [];

    for (let i = 0; i < records.length; i++) {
      const rowNum = i + 2; // +1 for header, +1 for 1-based lines
      try {
        const r = records[i] || {};
        const name = capStr(normStr(r.name).trim(), NAME_MAX);
        if (!name) {
          errors.push(`Dòng ${rowNum}: thiếu tên sản phẩm (cột name bắt buộc).`);
          continue;
        }
        const priceParsed = parsePrice(r.price);
        if (!priceParsed.ok) {
          errors.push(`Dòng ${rowNum}: giá (price) phải là số >= 0.`);
          continue;
        }
        const stockParsed = parseStock(r.stock_quantity);
        if (!stockParsed.ok) {
          errors.push(`Dòng ${rowNum}: tồn kho (stock_quantity) phải là số nguyên >= 0.`);
          continue;
        }
        const sku = emptyToNull(r.sku);
        let description = emptyToNull(r.description);
        if (description && description.length > DESC_MAX) description = description.slice(0, DESC_MAX);
        const category = emptyToNull(r.category);
        const imageUrl = emptyToNull(r.image_url);
        const isActive = parseIsActive(r.is_active, 1);

        let id;
        if (sku) {
          const existingRow = findBySku.get(sku);
          if (existingRow) {
            updateStmt.run(name, description, priceParsed.value, stockParsed.value, category, imageUrl, isActive, existingRow.id);
            id = existingRow.id;
            updated++;
          } else {
            id = Number(
              insertStmt.run(sku, name, description, priceParsed.value, stockParsed.value, category, imageUrl, isActive).lastInsertRowid
            );
            created++;
          }
        } else {
          id = Number(
            insertStmt.run(null, name, description, priceParsed.value, stockParsed.value, category, imageUrl, isActive).lastInsertRowid
          );
          created++;
        }
        try {
          await indexProduct(id);
        } catch (_e) {
          indexErrors++;
        }
      } catch (err) {
        errors.push(`Dòng ${rowNum}: ${err.message}`);
      }
    }

    return done({ created, updated, indexErrors, errors });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- faqs ---

// GET /admin/faqs — list with optional ?q= search (question / answer).
adminRouter.get('/faqs', (req, res, next) => {
  try {
    const db = getDb();
    const q = normStr(req.query.q).trim();
    let faqs;
    if (q) {
      const like = `%${escapeLike(q)}%`;
      faqs = db
        .prepare(
          `SELECT * FROM faqs
           WHERE question LIKE ? ESCAPE '\\' OR answer LIKE ? ESCAPE '\\'
           ORDER BY updated_at DESC, id DESC`
        )
        .all(like, like);
    } else {
      faqs = db.prepare('SELECT * FROM faqs ORDER BY updated_at DESC, id DESC').all();
    }
    res.render('faqs_list', { faqs, q, index_error: req.query.index_error });
  } catch (err) {
    next(err);
  }
});

// GET /admin/faqs/new — empty create form.
adminRouter.get('/faqs/new', (req, res, next) => {
  try {
    res.render('faqs_form', {
      isEdit: false,
      action: `${baseUrl(req)}/faqs`,
      errors: [],
      faq: { id: null, question: '', answer: '' },
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/faqs/export — download all FAQs as CSV.
adminRouter.get('/faqs/export', (req, res, next) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT question, answer FROM faqs ORDER BY id ASC').all();
    const csv = stringify(rows, { header: true, columns: FAQ_CSV_COLUMNS });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="faqs.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

// GET /admin/faqs/import — paste-CSV form (no file upload; multer not used).
adminRouter.get('/faqs/import', (req, res, next) => {
  try {
    res.render('faqs_import', { result: null, csv: '' });
  } catch (err) {
    next(err);
  }
});

// POST /admin/faqs — create. Both question and answer are required.
adminRouter.post('/faqs', async (req, res) => {
  const base = baseUrl(req);
  try {
    const body = req.body || {};
    const errors = [];
    const question = normStr(body.question).trim();
    const answer = normStr(body.answer).trim();
    if (!question) errors.push('Câu hỏi (question) là bắt buộc.');
    if (!answer) errors.push('Câu trả lời (answer) là bắt buộc.');

    if (errors.length > 0) {
      res.status(400);
      return res.render('faqs_form', {
        isEdit: false,
        action: `${base}/faqs`,
        errors,
        faq: { id: null, question: normStr(body.question), answer: normStr(body.answer) },
      });
    }

    const db = getDb();
    const info = db
      .prepare('INSERT INTO faqs (question, answer, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)')
      .run(question, answer);
    const id = Number(info.lastInsertRowid);

    try {
      await indexFaq(id);
    } catch (err) {
      logger.warn('POST /faqs index failed', { id, error: err.message });
      return res.redirect(`${base}/faqs?index_error=1`);
    }
    return res.redirect(`${base}/faqs`);
  } catch (err) {
    logger.error('POST /faqs failed', { error: err.message });
    return res.redirect(`${base}/faqs`);
  }
});

// GET /admin/faqs/:id/edit — edit form.
adminRouter.get('/faqs/:id/edit', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).send('FAQ not found');
    const db = getDb();
    const faq = db.prepare('SELECT * FROM faqs WHERE id = ?').get(id);
    if (!faq) return res.status(404).send('FAQ not found');
    res.render('faqs_form', {
      isEdit: true,
      action: `${baseUrl(req)}/faqs/${id}`,
      errors: [],
      faq,
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/faqs/:id — update (same validation as create).
adminRouter.post('/faqs/:id', async (req, res) => {
  const base = baseUrl(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.redirect(`${base}/faqs`);
  try {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM faqs WHERE id = ?').get(id);
    if (!existing) return res.status(404).send('FAQ not found');

    const body = req.body || {};
    const errors = [];
    const question = normStr(body.question).trim();
    const answer = normStr(body.answer).trim();
    if (!question) errors.push('Câu hỏi (question) là bắt buộc.');
    if (!answer) errors.push('Câu trả lời (answer) là bắt buộc.');

    if (errors.length > 0) {
      res.status(400);
      return res.render('faqs_form', {
        isEdit: true,
        action: `${base}/faqs/${id}`,
        errors,
        faq: { id, question: normStr(body.question), answer: normStr(body.answer) },
      });
    }

    db.prepare(
      'UPDATE faqs SET question = ?, answer = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(question, answer, id);

    try {
      await indexFaq(id);
    } catch (err) {
      logger.warn('POST /faqs/:id index failed', { id, error: err.message });
      return res.redirect(`${base}/faqs?index_error=1`);
    }
    return res.redirect(`${base}/faqs`);
  } catch (err) {
    logger.error('POST /faqs/:id failed', { id, error: err.message });
    return res.redirect(`${base}/faqs`);
  }
});

// POST /admin/faqs/:id/delete — delete row + its RAG vectors.
adminRouter.post('/faqs/:id/delete', async (req, res) => {
  const base = baseUrl(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.redirect(`${base}/faqs`);
    const db = getDb();
    db.prepare('DELETE FROM faqs WHERE id = ?').run(id);
    try {
      await deleteSourceVectors('faq', id);
    } catch (err) {
      // Vector cleanup is best-effort; the DB delete already succeeded.
      logger.warn('POST /faqs/:id/delete vector cleanup failed', { id, error: err.message });
    }
    return res.redirect(`${base}/faqs`);
  } catch (err) {
    logger.error('POST /faqs/:id/delete failed', { error: err.message });
    return res.redirect(`${base}/faqs`);
  }
});

// POST /admin/faqs/import — parse pasted CSV text (field `csv`).
// FAQs have no SKU-like key, so rows upsert by exact question match.
adminRouter.post('/faqs/import', async (req, res, next) => {
  try {
    const raw = req.body && req.body.csv !== undefined ? String(req.body.csv) : '';
    const done = (result) => res.render('faqs_import', { result, csv: raw });
    if (csvTooLarge(raw)) {
      res.status(413);
      return done({
        created: 0,
        updated: 0,
        indexErrors: 0,
        errors: [`CSV quá lớn: tối đa ${CSV_MAX_CHARS} ký tự và ${CSV_MAX_ROWS} dòng.`],
      });
    }
    if (!raw.trim()) {
      return done({
        created: 0,
        updated: 0,
        indexErrors: 0,
        errors: ['Nội dung CSV trống. Hãy dán CSV (kèm dòng header) vào ô bên dưới.'],
      });
    }
    let records;
    try {
      records = parse(raw, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    } catch (err) {
      return done({ created: 0, updated: 0, indexErrors: 0, errors: ['CSV không hợp lệ: ' + err.message] });
    }
    if (records.length > CSV_MAX_ROWS) {
      res.status(413);
      return done({
        created: 0,
        updated: 0,
        indexErrors: 0,
        errors: [`CSV quá nhiều dòng: tối đa ${CSV_MAX_ROWS} dòng (nhận ${records.length}).`],
      });
    }

    const db = getDb();
    const findByQuestion = db.prepare('SELECT id FROM faqs WHERE question = ?');
    const insertStmt = db.prepare(
      'INSERT INTO faqs (question, answer, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
    );
    const updateStmt = db.prepare(
      'UPDATE faqs SET answer = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    );

    let created = 0;
    let updated = 0;
    let indexErrors = 0;
    const errors = [];

    for (let i = 0; i < records.length; i++) {
      const rowNum = i + 2;
      try {
        const r = records[i] || {};
        const question = capStr(normStr(r.question).trim(), NAME_MAX);
        const answer = capStr(normStr(r.answer).trim(), DESC_MAX);
        if (!question) {
          errors.push(`Dòng ${rowNum}: thiếu câu hỏi (cột question bắt buộc).`);
          continue;
        }
        if (!answer) {
          errors.push(`Dòng ${rowNum}: thiếu câu trả lời (cột answer bắt buộc).`);
          continue;
        }
        let id;
        const existingRow = findByQuestion.get(question);
        if (existingRow) {
          updateStmt.run(answer, existingRow.id);
          id = existingRow.id;
          updated++;
        } else {
          id = Number(insertStmt.run(question, answer).lastInsertRowid);
          created++;
        }
        try {
          await indexFaq(id);
        } catch (_e) {
          indexErrors++;
        }
      } catch (err) {
        errors.push(`Dòng ${rowNum}: ${err.message}`);
      }
    }

    return done({ created, updated, indexErrors, errors });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- prompts ---

// GET /admin/prompts — list prompt files + show which one is active (from config).
adminRouter.get('/prompts', (req, res, next) => {
  try {
    const files = listPromptFiles();
    const active = config.activeSystemPrompt || getActivePromptFile();
    res.render('prompts_list', { files, active });
  } catch (err) {
    next(err);
  }
});

// GET /admin/prompts/new — create-file form. MUST be defined before /:filename.
adminRouter.get('/prompts/new', (req, res, next) => {
  try {
    res.render('prompts_form', { filename: '', content: '', error: null });
  } catch (err) {
    next(err);
  }
});

// POST /admin/prompts — create a new .md file. Filename: /^[a-zA-Z0-9_-]+\.md$/.
adminRouter.post('/prompts', async (req, res) => {
  const base = baseUrl(req);
  const filename = normStr(req.body && req.body.filename).trim();
  const content = req.body && req.body.content !== undefined ? String(req.body.content) : '';
  const fail = (message, status = 400) => {
    res.status(status);
    return res.render('prompts_form', { filename, content, error: message });
  };
  try {
    if (!PROMPT_CREATE_RE.test(filename)) {
      return fail('Tên file không hợp lệ. Chỉ cho phép chữ cái, số, _ - và phải kết thúc bằng .md (ví dụ: sales.md).');
    }
    // Refuse to overwrite an existing file from the "new" endpoint.
    try {
      readPromptFile(filename);
      return fail('File đã tồn tại. Hãy mở file đó để chỉnh sửa thay vì tạo mới.');
    } catch (_e) {
      // Not found -> safe to create.
    }
    await writePromptFile(filename, content);
    return res.redirect(`${base}/prompts/${encodeURIComponent(filename)}`);
  } catch (err) {
    logger.error('POST /prompts failed', { filename, error: err.message });
    try {
      return fail('Không thể tạo file: ' + err.message);
    } catch (innerErr) {
      logger.error('POST /prompts fail-render failed', { error: innerErr.message });
      return res.redirect(`${base}/prompts`);
    }
  }
});

// POST /admin/prompts/active — switch the active prompt file at runtime.
// Body: { filename }. MUST be defined before /prompts/:filename (else 'active'
// would match :filename). Calls setActivePromptOverride() from
// core/systemPrompt.js via dynamic import (that module only imports
// config+logger, so no cycle either way).
adminRouter.post('/prompts/active', async (req, res) => {
  const base = baseUrl(req);
  try {
    const filename = normStr(req.body && req.body.filename).trim();
    if (!PROMPT_CREATE_RE.test(filename) || isUnsafePromptFilename(filename)) {
      return res.status(400).send('Invalid filename');
    }
    try {
      readPromptFile(filename);
    } catch (_e) {
      return res.status(404).send('Prompt file not found');
    }
    const mod = await import('../core/systemPrompt.js');
    if (typeof mod.setActivePromptOverride !== 'function') {
      logger.warn('POST /prompts/active unavailable: setActivePromptOverride not exported', { filename });
      return res.status(501).send('Active-prompt switching is not available in this build');
    }
    await mod.setActivePromptOverride(filename);
    return res.redirect(`${base}/prompts`);
  } catch (err) {
    logger.error('POST /prompts/active failed', { error: err.message });
    return res.redirect(`${base}/prompts`);
  }
});

// GET /admin/prompts/:filename — view/edit one prompt file (traversal-guarded).
adminRouter.get('/prompts/:filename', (req, res, next) => {
  try {
    const filename = req.params.filename;
    if (isUnsafePromptFilename(filename)) return res.status(400).send('Invalid filename');
    let content;
    try {
      content = readPromptFile(filename);
    } catch (_e) {
      return res.status(404).send('Prompt file not found');
    }
    res.render('prompts_edit', { filename, content, saved: req.query.saved, error: null });
  } catch (err) {
    next(err);
  }
});

// POST /admin/prompts/:filename — save one prompt file (traversal-guarded).
adminRouter.post('/prompts/:filename', async (req, res, next) => {
  const base = baseUrl(req);
  try {
    const filename = req.params.filename;
    if (isUnsafePromptFilename(filename)) return res.status(400).send('Invalid filename');
    const content = req.body && req.body.content !== undefined ? String(req.body.content) : '';
    try {
      await writePromptFile(filename, content);
    } catch (err) {
      res.status(400);
      return res.render('prompts_edit', {
        filename,
        content,
        saved: null,
        error: 'Không thể lưu file: ' + err.message,
      });
    }
    return res.redirect(`${base}/prompts/${encodeURIComponent(filename)}?saved=1`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------- customers ---

// GET /admin/customers — list customers with message counts (LEFT JOIN conversations).
adminRouter.get('/customers', (req, res, next) => {
  try {
    const db = getDb();
    const customers = db
      .prepare(
        `SELECT c.*, COUNT(m.id) AS message_count
         FROM customers c
         LEFT JOIN conversations m
           ON m.channel = c.channel AND m.external_user_id = c.external_user_id
         GROUP BY c.id
         ORDER BY c.last_seen_at DESC, c.id DESC`
      )
      .all();
    res.render('customers_list', { customers });
  } catch (err) {
    next(err);
  }
});

// GET /admin/customers/:id — detail + last 50 messages.
adminRouter.get('/customers/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).send('Customer not found');
    const db = getDb();
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!customer) return res.status(404).send('Customer not found');
    const messages = db
      .prepare(
        `SELECT * FROM conversations
         WHERE channel = ? AND external_user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 50`
      )
      .all(customer.channel, customer.external_user_id);
    messages.reverse(); // chronological for display
    res.render('customers_detail', { customer, messages, leadStatuses: LEAD_STATUSES });
  } catch (err) {
    next(err);
  }
});

// POST /admin/customers/:id/handoff — toggle human_handoff via `action=on|off`.
adminRouter.post('/customers/:id/handoff', (req, res) => {
  const base = baseUrl(req);
  const back = `${base}/customers/${encodeURIComponent(req.params.id)}`;
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.redirect(`${base}/customers`);
    const action = normStr(req.body && req.body.action).trim().toLowerCase();
    if (action !== 'on' && action !== 'off') return res.redirect(back);
    const db = getDb();
    db.prepare('UPDATE customers SET human_handoff = ? WHERE id = ?').run(
      action === 'on' ? 1 : 0,
      id
    );
    return res.redirect(back);
  } catch (err) {
    logger.error('POST /customers/:id/handoff failed', { error: err.message });
    return res.redirect(back);
  }
});

// POST /admin/customers/:id/notes — update notes + lead_status (allow-listed).
adminRouter.post('/customers/:id/notes', (req, res) => {
  const base = baseUrl(req);
  const back = `${base}/customers/${encodeURIComponent(req.params.id)}`;
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.redirect(`${base}/customers`);
    // Cap notes length (<= 2000 chars).
    let notes = req.body && req.body.notes !== undefined ? String(req.body.notes) : '';
    if (notes.length > 2000) notes = notes.slice(0, 2000);
    const leadStatus = normStr(req.body && req.body.lead_status).trim();
    const db = getDb();
    if (LEAD_STATUSES.includes(leadStatus)) {
      db.prepare('UPDATE customers SET notes = ?, lead_status = ? WHERE id = ?').run(
        notes,
        leadStatus,
        id
      );
    } else {
      // Invalid status: still save notes, keep the existing lead_status.
      db.prepare('UPDATE customers SET notes = ? WHERE id = ?').run(notes, id);
    }
    return res.redirect(back);
  } catch (err) {
    logger.error('POST /customers/:id/notes failed', { error: err.message });
    return res.redirect(back);
  }
});

// ---------------------------------------------------------------- uploads (AGENT-B) ---

// GET /admin/uploads/:name — serve files ONLY from UPLOAD_DIR (product QR,
// global payment QR previews). Basename guard: no paths, no traversal,
// image extensions only.
adminRouter.get('/uploads/:name', (req, res) => {
  try {
    const raw = req.params.name || '';
    const name = basename(raw);
    if (!name || name !== raw || name.includes('..') || name.includes('\0')) {
      return res.status(400).send('Invalid filename');
    }
    const ext = extname(name).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
      return res.status(400).send('Invalid filename');
    }
    ensureStorage();
    const abs = resolve(UPLOAD_DIR, name);
    if (abs !== join(UPLOAD_DIR, name) || !existsSync(abs)) {
      return res.status(404).send('Not found');
    }
    res.setHeader('Content-Type', ext === '.png' ? 'image/png' : 'image/jpeg');
    return res.sendFile(abs);
  } catch (err) {
    logger.error('GET /uploads/:name failed', { error: err.message });
    return res.status(404).send('Not found');
  }
});

// ---------------------------------------------------------------- orders (AGENT-B) ---

const ORDER_STATUSES = ['awaiting_payment', 'pending_verify', 'delivered', 'cancelled'];

// GET /admin/orders — order table with ?status= filter.
adminRouter.get('/orders', async (req, res, next) => {
  try {
    const status = normStr(req.query.status).trim();
    const filter = ORDER_STATUSES.includes(status) ? status : '';
    const { listOrders, countPendingVerify } = await import('../orders/orders.js');
    const orders = listOrders({ status: filter, limit: 100 });
    let pendingCount = 0;
    try {
      pendingCount = countPendingVerify();
    } catch (err) {
      logger.warn('GET /orders countPendingVerify failed', { error: err.message });
    }
    res.render('orders_list', {
      orders,
      status: filter || 'all',
      statuses: ORDER_STATUSES,
      pendingCount,
      result: null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/orders/:id/deliver — verify + deliver 1 acc line, then push it
// to the buyer over Telegram (best-effort; the DB row is already delivered so
// the line is also shown on the result page and never lost).
adminRouter.post('/orders/:id/deliver', async (req, res, next) => {
  const base = baseUrl(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.redirect(`${base}/orders`);
  try {
    const { listOrders, countPendingVerify, deliverOrder } = await import('../orders/orders.js');
    const outcome = deliverOrder(id);
    let sendStatus = null;
    if (outcome.ok) {
      const order = outcome.order;
      if (order.channel === 'telegram') {
        try {
          const tg = await import('../channels/telegram.js');
          const bot = typeof tg.getTelegramBot === 'function' ? tg.getTelegramBot() : null;
          if (bot) {
            await bot.telegram.sendMessage(
              order.external_user_id,
              `Acc của bạn (đơn ${order.order_code}):\n${outcome.line}`
            );
            sendStatus = 'Đã gửi acc qua Telegram.';
          } else {
            sendStatus = 'Bot Telegram chưa chạy — hãy copy dòng acc bên dưới gửi tay cho khách.';
          }
        } catch (err) {
          logger.error('POST /orders/:id/deliver telegram send failed', {
            id,
            error: err.message,
          });
          sendStatus = 'Gửi Telegram thất bại — hãy copy dòng acc bên dưới gửi tay cho khách.';
        }
      } else {
        sendStatus = `Kênh ${order.channel} không tự gửi được — hãy copy dòng acc bên dưới gửi tay cho khách.`;
      }
    }
    const orders = listOrders({ status: '', limit: 100 });
    let pendingCount = 0;
    try {
      pendingCount = countPendingVerify();
    } catch {
      // best-effort badge
    }
    res.render('orders_list', {
      orders,
      status: 'all',
      statuses: ORDER_STATUSES,
      pendingCount,
      result: outcome.ok
        ? {
            ok: true,
            orderCode: outcome.order.order_code,
            line: outcome.line,
            remaining: outcome.remaining,
            sendStatus,
          }
        : { ok: false, error: outcome.error || 'Giao hàng thất bại.' },
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/orders/:id/cancel — cancel an order (delivered orders refuse).
adminRouter.post('/orders/:id/cancel', async (req, res) => {
  const base = baseUrl(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.redirect(`${base}/orders`);
  try {
    const { cancelOrder } = await import('../orders/orders.js');
    const outcome = cancelOrder(id);
    if (!outcome.ok) {
      logger.warn('POST /orders/:id/cancel refused', { id, error: outcome.error });
    }
    return res.redirect(`${base}/orders`);
  } catch (err) {
    logger.error('POST /orders/:id/cancel failed', { id, error: err.message });
    return res.redirect(`${base}/orders`);
  }
});

// ---------------------------------------------------------------- settings (AGENT-B) ---

// GET /admin/settings — global payment QR + acc library.
adminRouter.get('/settings', (req, res, next) => {
  try {
    const paymentQrPath = getSetting('payment_qr_path', '');
    res.render('settings', {
      paymentQrPreview: uploadPreviewName(paymentQrPath),
      accFiles: safeListAccFiles(),
      result: null,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/settings/payment-qr — upload global payment QR (png/jpg <= 2MB).
adminRouter.post('/settings/payment-qr', async (req, res, next) => {
  const renderWith = (result, error) => {
    try {
      res.render('settings', {
        paymentQrPreview: uploadPreviewName(getSetting('payment_qr_path', '')),
        accFiles: safeListAccFiles(),
        result,
        error,
      });
    } catch (err) {
      next(err);
    }
  };
  try {
    const uploadErr = await runSingleUpload(req, res, qrUpload.single('qr'));
    const uploadErrMsg = multerErrMessage(uploadErr);
    if (uploadErrMsg) {
      res.status(400);
      return renderWith(null, uploadErrMsg);
    }
    if (!req.file) {
      res.status(400);
      return renderWith(null, 'Bạn chưa chọn file QR nào.');
    }
    const ext = qrExtFor(req.file);
    if (!ext) {
      res.status(400);
      return renderWith(null, 'File QR phải là ảnh PNG hoặc JPG.');
    }
    ensureStorage();
    const dest = join(UPLOAD_DIR, `payment-qr${ext}`);
    writeFileSync(dest, req.file.buffer);
    for (const other of ext === '.png' ? ['.jpg'] : ['.png']) {
      const stale = join(UPLOAD_DIR, `payment-qr${other}`);
      if (stale !== dest && existsSync(stale)) {
        try {
          unlinkSync(stale);
        } catch {
          // best-effort
        }
      }
    }
    setSetting('payment_qr_path', dest);
    return renderWith('Đã cập nhật QR thanh toán chung.', null);
  } catch (err) {
    logger.error('POST /settings/payment-qr failed', { error: err.message });
    res.status(500);
    return renderWith(null, 'Không lưu được file QR: ' + err.message);
  }
});

// POST /admin/settings/acc-upload — upload a new .txt acc file (<= 1MB).
adminRouter.post('/settings/acc-upload', async (req, res, next) => {
  const renderWith = (result, error) => {
    try {
      res.render('settings', {
        paymentQrPreview: uploadPreviewName(getSetting('payment_qr_path', '')),
        accFiles: safeListAccFiles(),
        result,
        error,
      });
    } catch (err) {
      next(err);
    }
  };
  try {
    const uploadErr = await runSingleUpload(req, res, accUpload.single('acc_file'));
    const uploadErrMsg = multerErrMessage(uploadErr);
    if (uploadErrMsg) {
      res.status(400);
      return renderWith(null, uploadErrMsg);
    }
    if (!req.file) {
      res.status(400);
      return renderWith(null, 'Bạn chưa chọn file acc nào.');
    }
    const original = req.file.originalname || '';
    if (original.includes('+đã bán') || original.includes('đã bán')) {
      res.status(400);
      return renderWith(null, 'Tên file không được chứa "+đã bán" (hậu tố dành cho file lưu trữ đã bán).');
    }
    let dest;
    try {
      dest = safeAccPath(original);
    } catch (err) {
      res.status(400);
      return renderWith(null, err.message);
    }
    ensureStorage();
    writeFileSync(dest, req.file.buffer);
    return renderWith(`Đã tải lên file acc: ${basename(dest)}`, null);
  } catch (err) {
    logger.error('POST /settings/acc-upload failed', { error: err.message });
    res.status(500);
    return renderWith(null, 'Không lưu được file acc: ' + err.message);
  }
});

// ---------------------------------------------------------------- admin AI agent (AGENT-ROUTES) ---
//
// NOTE (route order): every /agent/sessions* and /agent/chat route is defined
// here, together, BEFORE the end of the file. No /:param-style route can
// swallow them: all param routes in this router are prefixed (/products/:id,
// /faqs/:id, /prompts/:filename, /customers/:id, /orders/:id, /uploads/:name)
// so there is no conflict with /agent/....
// Session persistence contracts live in src/core/adminAgent.js (brain agent
// owns that file — this router only imports it):
//   chatWithAdmin({sessionId?, message, useWebSearch, useThinking}) -> {reply, sessionId}
//   listSessions() -> [{id,title,updated_at,message_count}]
//   getSessionMessages(sessionId) -> [{role,content}]
//   deleteSession(sessionId) -> {ok}

// GET /admin/agent — chat UI with persisted session list.
adminRouter.get('/agent', async (req, res, next) => {
  try {
    let sessions = [];
    try {
      sessions = await listSessions();
    } catch (err) {
      logger.warn('GET /agent listSessions failed', { error: err.message });
      sessions = [];
    }
    res.render('agent', {
      sessions,
      webSearchOn: config.enableWebSearch,
      chatModel: config.lmStudioChatModel,
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/agent/sessions — JSON list of chat sessions.
adminRouter.get('/agent/sessions', async (req, res) => {
  try {
    const sessions = await listSessions();
    return res.json(sessions);
  } catch (err) {
    logger.error('GET /agent/sessions failed', { error: err.message });
    return res.status(500).json({ error: 'Không tải được danh sách phiên chat.' });
  }
});

// POST /admin/agent/sessions — create an empty session, return { id }.
// (adminAgent.js exposes no newSession, and creating via chatWithAdmin would
// require a message — so the row is inserted directly here.)
adminRouter.post('/agent/sessions', (req, res) => {
  try {
    const db = getDb();
    const info = db
      .prepare("INSERT INTO admin_sessions (title) VALUES ('Cuộc trò chuyện mới')")
      .run();
    return res.json({ id: Number(info.lastInsertRowid) });
  } catch (err) {
    logger.error('POST /agent/sessions failed', { error: err.message });
    return res.status(500).json({ error: 'Không tạo được phiên chat mới.' });
  }
});

// GET /admin/agent/sessions/:id/messages — JSON [{ role, content }].
adminRouter.get('/agent/sessions/:id/messages', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'sessionId không hợp lệ.' });
    const messages = await getSessionMessages(id);
    return res.json(messages);
  } catch (err) {
    logger.error('GET /agent/sessions/:id/messages failed', { error: err.message });
    return res.status(500).json({ error: 'Không tải được tin nhắn.' });
  }
});

// DELETE /admin/agent/sessions/:id — JSON { ok }.
adminRouter.delete('/agent/sessions/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'sessionId không hợp lệ.' });
    const result = await deleteSession(id);
    return res.json(result);
  } catch (err) {
    logger.error('DELETE /agent/sessions/:id failed', { error: err.message });
    return res.status(500).json({ error: 'Không xóa được phiên chat.' });
  }
});

// POST /admin/agent/chat — JSON { message, sessionId?, useWebSearch?, useThinking? }
// -> { reply, sessionId }.
adminRouter.post('/agent/chat', async (req, res) => {
  try {
    const body = req.body || {};
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'message là bắt buộc.' });
    if (message.length > 4000) return res.status(400).json({ error: 'message tối đa 4000 ký tự.' });
    let sessionId;
    if (body.sessionId !== undefined && body.sessionId !== null && String(body.sessionId).trim() !== '') {
      const n = Number(body.sessionId);
      if (!Number.isInteger(n)) return res.status(400).json({ error: 'sessionId không hợp lệ.' });
      sessionId = n;
    }
    const useWebSearch = body.useWebSearch === true || body.useWebSearch === 'true';
    const useThinking = body.useThinking === true || body.useThinking === 'true';
    const result = await chatWithAdmin({ sessionId, message, useWebSearch, useThinking });
    return res.json({ reply: result.reply, sessionId: result.sessionId });
  } catch (err) {
    logger.error('POST /agent/chat failed', { error: err.message });
    return res.status(500).json({ error: 'Trợ lý AI đang gặp sự cố, bạn thử lại sau.' });
  }
});
