// src/rag/embed.js — embedding side of the RAG pipeline.
//
// Thin wrapper over the LM Studio adapter. The pinned chat model
// (google/gemma-3-1b) is NOT an embedding model, so
// LMSTUDIO_EMBEDDING_MODEL ships empty: every function here throws a
// descriptive Error and every caller is expected to degrade to "no
// knowledge-base context" rather than fail the request.

import { embedText, embedTexts, getEmbeddingModel } from '../llm/client.js';
import { logger } from '../services/logger.js';

// Retrieval runs on every incoming message; without this guard an unconfigured
// embedding model would write one identical warning per message. Log the
// degradation once per process (AGENTS.md §3.6).
let degradationLogged = false;

function logDegradedOnce(error) {
  if (degradationLogged) return;
  degradationLogged = true;
  logger.warn('RAG disabled — continuing without knowledge-base context', {
    error: error.message,
    embeddingModel: getEmbeddingModel() || '(chưa cấu hình LMSTUDIO_EMBEDDING_MODEL)',
  });
}

/**
 * Embed one chunk/query. @returns {Promise<Float32Array>}
 * Throws when no embedding model is configured or LM Studio is unreachable.
 */
export async function getEmbedding(text) {
  try {
    return await embedText(text);
  } catch (error) {
    logDegradedOnce(error);
    throw error;
  }
}

/**
 * Embed many chunks in one round trip. @returns {Promise<Float32Array[]>}
 * Same throw-on-failure contract as getEmbedding.
 */
export async function getEmbeddingsBatch(texts) {
  try {
    return await embedTexts(texts);
  } catch (error) {
    logDegradedOnce(error);
    throw error;
  }
}

/** Configured embedding model id, or '' when RAG is intentionally disabled. */
export function isEmbeddingConfigured() {
  return getEmbeddingModel() !== '';
}

export { getEmbeddingModel };
