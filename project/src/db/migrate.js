import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { config } from '../config.js';
import { logger } from '../services/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = resolve(__dirname, '../../data/app.db');
const SCHEMA_PATH = resolve(__dirname, 'schema.sql');

let db = null;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    // Load sqlite-vec extension
    sqliteVec.load(db);
    logger.info('sqlite-vec extension loaded');
  }
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// The OpenAI-compatible API has no "show model" endpoint to probe, so the vector
// width is static config (EMBEDDING_DIM). The old POST /api/show probe failed on
// every single boot and logged a warning before falling back to the same value.
// Changing EMBEDDING_DIM requires dropping kb_vectors/kb_chunks and reindexing
// with one model — see README "Troubleshooting".
function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    logger.info(`Added column ${table}.${column}`);
  }
}

export async function initDb() {
  const db = getDb();

  // Run base schema
  const schema = readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schema);
  logger.info('Base schema applied');
  
  // Create vector table with the configured width. Vectors are only ever written
  // when an embedding model is loaded, so an empty LMSTUDIO_EMBEDDING_MODEL is a
  // valid, fully working state — the table just stays empty.
  const dimensions = config.embeddingDim;
  
  // Check if vector table exists with correct dimensions
  try {
    const checkStmt = db.prepare(`SELECT * FROM kb_vectors LIMIT 1`);
    checkStmt.get();
    logger.info('Vector table already exists');
  } catch (e) {
    // Table doesn't exist, create it
    const createVecSql = `
      CREATE VIRTUAL TABLE kb_vectors USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding FLOAT[${dimensions}]
      )
    `;
    db.exec(createVecSql);
    logger.info(`Created kb_vectors virtual table with ${dimensions} dimensions`);
  }
  
  // Column upgrades for pre-existing databases (CREATE TABLE IF NOT EXISTS
  // won't add columns to old tables).
  ensureColumn(db, 'products', 'acc_file', 'TEXT');
  ensureColumn(db, 'products', 'qr_image_path', 'TEXT');

  // Initialize history tables
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
  
  logger.info('Database initialization complete');
  return db;
}

// Run migration if called directly (URL compare breaks on Windows paths with spaces, so match by filename)
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('db/migrate.js')) {
  initDb()
    .then(() => {
      logger.info('Migration completed successfully');
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      logger.error('Migration failed', { error: err.message, stack: err.stack });
      closeDb();
      process.exit(1);
    });
}