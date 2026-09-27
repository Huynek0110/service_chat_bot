import { getDb } from '../db/migrate.js';
import { logger } from '../services/logger.js';

// Escape %, _ and \ for LIKE ... ESCAPE '\' searches (same pattern as admin/routes.js).
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}

export async function searchProducts({ query, category }) {
  const db = getDb();
  
  let sql = `
    SELECT id, sku, name, description, price, stock_quantity, category, image_url, is_active
    FROM products 
    WHERE is_active = 1
  `;
  const params = [];
  
  if (query) {
    sql += ` AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\')`;
    const q = `%${escapeLike(query)}%`;
    params.push(q, q, q);
  }
  
  if (category) {
    sql += ` AND category = ?`;
    params.push(category);
  }
  
  sql += ` ORDER BY 
    CASE WHEN name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
    stock_quantity DESC
    LIMIT 10`;
  
  if (query) {
    params.push(`${escapeLike(query)}%`);
  } else {
    params.push('zzz');
  }
  
  const products = db.prepare(sql).all(...params);
  
  return {
    products: products.map(p => ({
      sku: p.sku,
      name: p.name,
      description: p.description?.substring(0, 200),
      price: p.price,
      formattedPrice: p.price.toLocaleString('vi-VN') + 'đ',
      stock: p.stock_quantity,
      inStock: p.stock_quantity > 0,
      category: p.category,
      imageUrl: p.image_url
    })),
    count: products.length
  };
}

export async function checkStock({ sku_or_name }) {
  const db = getDb();
  
  // Try exact SKU match first
  let product = db.prepare(`
    SELECT id, sku, name, stock_quantity, price, is_active
    FROM products 
    WHERE sku = ? AND is_active = 1
  `).get(sku_or_name);
  
  // If not found, try name match
  if (!product) {
    product = db.prepare(`
      SELECT id, sku, name, stock_quantity, price, is_active
      FROM products 
      WHERE name LIKE ? ESCAPE '\\' AND is_active = 1
      ORDER BY stock_quantity DESC
      LIMIT 1
    `).get(`%${escapeLike(sku_or_name)}%`);
  }
  
  if (!product) {
    return {
      found: false,
      message: `Không tìm thấy sản phẩm "${sku_or_name}" trong cửa hàng.`
    };
  }
  
  return {
    found: true,
    sku: product.sku,
    name: product.name,
    stock: product.stock_quantity,
    price: product.price,
    formattedPrice: product.price.toLocaleString('vi-VN') + 'đ',
    inStock: product.stock_quantity > 0,
    message: product.stock_quantity > 0 
      ? `Sản phẩm "${product.name}" (${product.sku}) còn ${product.stock_quantity} cái.`
      : `Sản phẩm "${product.name}" (${product.sku}) hiện đã hết hàng.`
  };
}

export async function requestHumanHandoff({ reason }, context) {
  const db = getDb();
  const { channel, userId } = context;
  
  // Single-statement upsert: avoids the UPDATE-then-INSERT race when two
  // messages from a new customer arrive concurrently. Appended notes are
  // capped to the last 2000 chars via substr(..., -2000).
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO customers (channel, external_user_id, human_handoff, notes)
    VALUES (?, ?, 1, substr(?, -2000))
    ON CONFLICT(channel, external_user_id) DO UPDATE SET
      human_handoff = 1,
      notes = substr(COALESCE(customers.notes, '') || ?, -2000)
  `).run(channel, userId, `[HANDOFF] ${now}: ${reason}`, `\n[HANDOFF] ${now}: ${reason}`);
  
  logger.info('HUMAN_HANDOFF_REQUESTED', { channel, userId, reason });
  
  return {
    success: true,
    message: 'Đã ghi nhận yêu cầu chuyển cho nhân viên. Nhân viên sẽ liên hệ với bạn sớm nhất có thể.'
  };
}