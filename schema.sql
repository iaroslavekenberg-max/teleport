CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL UNIQUE,
  tg_username TEXT,
  first_name TEXT,
  last_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  plan_name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  vless_link TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_tg_id ON subscriptions(tg_id);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id TEXT NOT NULL UNIQUE,
  tg_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  amount_rub TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_days INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'manual',
  proof_text TEXT,
  admin_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_tg_id ON payments(tg_id);

CREATE TABLE IF NOT EXISTS chrome_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  vless_link TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chrome_claims_code_hash ON chrome_claims(code_hash);
CREATE INDEX IF NOT EXISTS idx_chrome_claims_tg_id ON chrome_claims(tg_id);
