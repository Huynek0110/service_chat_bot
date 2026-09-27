import { getEmbedding } from './embed.js';
import { getDb } from '../db/migrate.js';
import { config } from '../config.js';
import { logger } from '../services/logger.js';

// Returns null (not []) when retrieval failed, so callers can tell "no match"
// apart from "RAG unavailable" and skip the knowledge-base block cleanly.
// AGENTS.md §3.6: the bot must still chat when no embedding model is loaded.
export async function retrieve(query, topK = config.ragTopK) {
  try {
    // Embed the query
    const queryEmbedding = await getEmbedding(query);
    // Respect byteOffset/byteLength: the ArrayBuffer may be larger than this view.
    const buffer = Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);
    
    const db = getDb();
    
    // KNN search using sqlite-vec
    // Using MATCH with k parameter for KNN
    const stmt = db.prepare(`
      SELECT 
        kc.content,
        kc.source_type,
        kc.source_id,
        v.distance
      FROM kb_vectors v
      JOIN kb_chunks kc ON kc.id = v.chunk_id
      WHERE v.embedding MATCH ?
      AND k = ?
      ORDER BY v.distance
    `);
    
    const results = stmt.all(buffer, topK);
    
    logger.debug('RAG retrieve', { query: query.substring(0, 50), results: results.length });
    
    return results.map(r => ({
      content: r.content,
      sourceType: r.source_type,
      sourceId: r.source_id,
      distance: r.distance
    }));
  } catch (error) {
    // embed.js already logged the once-per-process degradation warning.
    logger.debug('RAG retrieve unavailable', { error: error.message, query });
    return null;
  }
}

export async function retrieveFormatted(query, topK = config.ragTopK) {
  const results = await retrieve(query, topK);
  
  // null = RAG unavailable, '' = searched but nothing matched. Both are falsy,
  // so the caller simply omits the reference block.
  if (!results || results.length === 0) {
    return null;
  }
  
  let formatted = '';
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    formatted += `[${i + 1}] ${r.content}\n`;
  }
  
  return formatted.trim();
}