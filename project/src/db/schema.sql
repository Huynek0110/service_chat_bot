-- Products table
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  price REAL,
  stock_quantity INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  image_url TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  acc_file TEXT,            -- .txt filename in products/ (1 line = 1 account), NULL = no acc stock
  qr_image_path TEXT,       -- per-product QR override, NULL = use global settings.payment_qr_path
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- FAQs table
CREATE TABLE IF NOT EXISTS faqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Knowledge base chunks for RAG
CREATE TABLE IF NOT EXISTS kb_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,   -- 'product' | 'faq'
  source_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Customers table
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

-- Conversations history
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  role TEXT NOT NULL,          -- 'user' | 'assistant' | 'tool'
  content TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conv_user 
ON conversations(channel, external_user_id, created_at);

-- Processed events for deduplication
CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  processed_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Orders (acc sales: customer claims paid -> admin verifies -> bot delivers)
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_code TEXT UNIQUE NOT NULL,   -- e.g. DH000123
  channel TEXT NOT NULL,             -- 'telegram' | 'messenger' | 'cli'
  external_user_id TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  sku TEXT,
  price REAL,
  status TEXT NOT NULL DEFAULT 'awaiting_payment',  -- awaiting_payment | pending_verify | delivered | cancelled
  announced INTEGER NOT NULL DEFAULT 0,             -- QR bundle already sent to buyer
  delivered_line TEXT,               -- archived copy of the delivered acc line (audit)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(channel, external_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);

-- Key/value shop settings editable from admin (no restart needed)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Admin AI agent chat sessions (persisted, selectable, resumable)
CREATE TABLE IF NOT EXISTS admin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT 'Cuộc trò chuyện mới',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES admin_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,          -- 'user' | 'assistant'
  content TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_msg_session ON admin_messages(session_id, id);

-- Vector table (dimension will be set dynamically based on embedding model)
-- Created in migrate.js after detecting embedding dimensions