-- Schema database Finanze (Cloudflare D1) — v2
-- Da eseguire una sola volta quando crei il database, dal dashboard Cloudflare
-- (D1 > il tuo database > Console) incollando questo contenuto.
-- Se avevi già creato il database con lo schema v1, cancella le tabelle prima
-- di rieseguirlo (o esegui semplicemente questo file su un database nuovo,
-- dato che l'app non è ancora online).

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '📦',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amount REAL NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('contanti','carta')),
  note TEXT,
  merchant TEXT,
  expense_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manuale' CHECK (source IN ('manuale','foto','voce')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cache dei riepiloghi mensili scritti dall'IA, per non richiamare l'API a ogni apertura
CREATE TABLE IF NOT EXISTS insights (
  month TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id);

-- Le quattro categorie di partenza. Altre si aggiungono dall'app quando vuoi.
INSERT OR IGNORE INTO categories (name, color, icon) VALUES
  ('Spesa', '#8FAE6B', '🛒'),
  ('Carburante', '#D4A24C', '⛽'),
  ('Uscite', '#A67CB5', '🎬'),
  ('Oggetti', '#6B8CAE', '📦');
