import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getEmbeddingsBatch } from './embed.js';
import { getDb } from '../db/migrate.js';
import { logger } from '../services/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = resolve(__dirname, '../../data/app.db');

function chunkText(text, maxLength = 500) {
  // Simple chunking by sentences/paragraphs
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let currentChunk = '';
  
  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > maxLength && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + sentence;
    }
  }
  
  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks.length > 0 ? chunks : [text.substring(0, maxLength)];
}

function buildProductChunk(product) {
  return `${product.name} - ${product.description}. Giá: ${product.price.toLocaleString('vi-VN')}đ. Danh mục: ${product.category}. Tồn kho: ${product.stock_quantity} sản phẩm. SKU: ${product.sku}. Trạng thái: ${product.is_active ? 'Đang bán' : 'Ngừng bán'}.`;
}

function buildFaqChunk(faq) {
  return `Câu hỏi: ${faq.question}. Trả lời: ${faq.answer}`;
}

// Convert Float32Array to buffer for sqlite-vec (respect byteOffset/byteLength:
// the underlying ArrayBuffer may be larger than this view).
function toVecBuffer(embedding) {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

// Re-raise embedding failures with a message the shop owner can act on. The admin
// views already render `index_error` for any throw, so the throw IS the UI
// channel (AGENTS.md §3.6) — the message just has to say what to do.
function indexError(what, err) {
  return new Error(
    `${what} Lỗi tạo vector RAG: ${err.message} ` +
    '(Sản phẩm/FAQ vẫn được lưu, chỉ mất phần tra cứu tự động.)'
  );
}

export async function indexProduct(productId) {
  const db = getDb();
  
  // Get product
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) {
    throw new Error(`Product not found: ${productId}`);
  }
  
  // Build chunk content
  const content = buildProductChunk(product);
  const chunks = chunkText(content);
  
  // Embed BEFORE deleting the old vectors: a missing/unreachable embedding model
  // must leave the already-indexed knowledge base intact, not empty it.
  let embeddings;
  try {
    embeddings = await getEmbeddingsBatch(chunks);
  } catch (err) {
    throw indexError(`Không lập chỉ mục sản phẩm "${product.name}".`, err);
  }
  
  // Delete old chunks and vectors — vectors FIRST (same predicate), then chunks.
  // The reverse order would make the vectors subquery match nothing, leaving orphans.
  db.prepare('DELETE FROM kb_vectors WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE source_type = ? AND source_id = ?)').run('product', productId);
  db.prepare('DELETE FROM kb_chunks WHERE source_type = ? AND source_id = ?').run('product', productId);
  
  // Insert chunks and vectors
  const insertChunk = db.prepare('INSERT INTO kb_chunks (source_type, source_id, content) VALUES (?, ?, ?)');
  const insertVector = db.prepare('INSERT INTO kb_vectors (chunk_id, embedding) VALUES (CAST(? AS INTEGER), ?)');
  
  for (let i = 0; i < chunks.length; i++) {
    const result = insertChunk.run('product', productId, chunks[i]);
    const chunkId = Number(result.lastInsertRowid);
    insertVector.run(chunkId, toVecBuffer(embeddings[i]));
  }
  
  logger.info('Product indexed', { productId, chunks: chunks.length });
  return { success: true, chunks: chunks.length };
}

export async function indexFaq(faqId) {
  const db = getDb();
  
  const faq = db.prepare('SELECT * FROM faqs WHERE id = ?').get(faqId);
  if (!faq) {
    throw new Error(`FAQ not found: ${faqId}`);
  }
  
  const content = buildFaqChunk(faq);
  const chunks = chunkText(content);
  
  // Embed first — see indexProduct for why the delete must come after.
  let embeddings;
  try {
    embeddings = await getEmbeddingsBatch(chunks);
  } catch (err) {
    throw indexError(`Không lập chỉ mục FAQ "${faq.question}".`, err);
  }
  
  // Delete old — vectors FIRST (same predicate), then chunks (see indexProduct).
  db.prepare('DELETE FROM kb_vectors WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE source_type = ? AND source_id = ?)').run('faq', faqId);
  db.prepare('DELETE FROM kb_chunks WHERE source_type = ? AND source_id = ?').run('faq', faqId);
  
  const insertChunk = db.prepare('INSERT INTO kb_chunks (source_type, source_id, content) VALUES (?, ?, ?)');
  const insertVector = db.prepare('INSERT INTO kb_vectors (chunk_id, embedding) VALUES (CAST(? AS INTEGER), ?)');
  
  for (let i = 0; i < chunks.length; i++) {
    const result = insertChunk.run('faq', faqId, chunks[i]);
    const chunkId = Number(result.lastInsertRowid);
    insertVector.run(chunkId, toVecBuffer(embeddings[i]));
  }
  
  logger.info('FAQ indexed', { faqId, chunks: chunks.length });
  return { success: true, chunks: chunks.length };
}

export async function reindexAll() {
  const db = getDb();
  
  const products = db.prepare('SELECT id FROM products WHERE is_active = 1').all();
  const faqs = db.prepare('SELECT id FROM faqs').all();
  
  // Probe embeddings BEFORE wiping: reindexAll is destructive, so a broken or
  // unconfigured embedding model must abort instead of emptying kb_chunks.
  try {
    await getEmbeddingsBatch(['kiem tra ket noi embedding']);
  } catch (err) {
    throw indexError('Dừng dựng lại toàn bộ chỉ mục RAG.', err);
  }
  
  // Clear all
  db.exec('DELETE FROM kb_chunks');
  db.exec('DELETE FROM kb_vectors');
  
  // Reindex products
  for (const p of products) {
    await indexProduct(p.id);
  }
  
  // Reindex FAQs
  for (const f of faqs) {
    await indexFaq(f.id);
  }
  
  logger.info('Full reindex completed', { products: products.length, faqs: faqs.length });
  return { products: products.length, faqs: faqs.length };
}

export async function deleteSourceVectors(sourceType, sourceId) {
  const db = getDb();
  // Vectors first (same predicate), then chunks — otherwise the subquery
  // matches nothing and orphan vectors accumulate in kb_vectors.
  db.prepare('DELETE FROM kb_vectors WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE source_type = ? AND source_id = ?)').run(sourceType, sourceId);
  db.prepare('DELETE FROM kb_chunks WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);
  logger.info('Source vectors deleted', { sourceType, sourceId });
}