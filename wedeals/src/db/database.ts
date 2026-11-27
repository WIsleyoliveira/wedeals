import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace TEXT NOT NULL CHECK (marketplace IN ('mercadolivre','shopee','shein')),
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  image_url TEXT,
  price REAL NOT NULL,
  original_price REAL,
  category TEXT NOT NULL,
  seller_name TEXT,
  seller_reputation REAL,
  official_store INTEGER NOT NULL DEFAULT 0,
  in_stock INTEGER NOT NULL DEFAULT 1,
  commission_rate REAL,
  coupon_code TEXT,
  coupon_discount REAL,
  affiliate_url TEXT,
  status TEXT NOT NULL DEFAULT 'discovered',
  deal_score REAL,
  reject_reason TEXT,
  score_breakdown TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (marketplace, external_id)
);
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace TEXT NOT NULL,
  external_id TEXT NOT NULL,
  price REAL NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ph ON price_history (marketplace, external_id, observed_at);
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('whatsapp','telegram')),
  invite_link TEXT,
  external_id TEXT,
  admins TEXT NOT NULL DEFAULT '[]',
  categories TEXT NOT NULL DEFAULT '[]',
  marketplaces TEXT NOT NULL DEFAULT '[]',
  audience INTEGER,
  audience_source TEXT,
  window_start TEXT NOT NULL DEFAULT '08:00',
  window_end TEXT NOT NULL DEFAULT '22:00',
  min_interval_minutes INTEGER NOT NULL DEFAULT 30,
  max_daily_posts INTEGER NOT NULL DEFAULT 20,
  min_deal_score REAL NOT NULL DEFAULT 60,
  template TEXT,
  affiliate_account TEXT,
  mode TEXT NOT NULL DEFAULT 'assisted' CHECK (mode IN ('assisted','automatic')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  repost_cooldown_days INTEGER NOT NULL DEFAULT 7,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id INTEGER NOT NULL REFERENCES offers(id),
  group_id INTEGER NOT NULL REFERENCES groups(id),
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  tracking_code TEXT NOT NULL UNIQUE,
  image_url TEXT,
  published_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pub_group ON publications (group_id, scheduled_for);
-- Cliques: apenas contagem agregada por hora. Nenhum IP, telefone ou identificador pessoal.
CREATE TABLE IF NOT EXISTS clicks (
  tracking_code TEXT NOT NULL,
  hour TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tracking_code, hour)
);
CREATE TABLE IF NOT EXISTS commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace TEXT NOT NULL,
  external_order_ref TEXT NOT NULL,
  tracking_code TEXT,
  offer_external_id TEXT,
  category TEXT,
  sale_amount REAL NOT NULL,
  commission_amount REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','paid','cancelled')),
  occurred_at TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  UNIQUE (marketplace, external_order_ref)
);
CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  occurred_at TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_runs (
  agent TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  last_run_at TEXT,
  last_result TEXT
);
CREATE TABLE IF NOT EXISTS quota_usage (
  provider TEXT NOT NULL,
  window TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, window)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','operador')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE TABLE IF NOT EXISTS pipeline_counters (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);
`;

export type DB = DatabaseSync;

export function openDatabase(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // busy_timeout: servidor e worker gravam no mesmo arquivo (processos separados).
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Migrações de bancos criados por versões anteriores (o SCHEMA só cria o que não existe). */
function migrate(db: DB) {
  const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  // autor de cada ação (usuário ou "token-admin"); NULL nas ações do sistema e nos registros antigos
  if (!cols("audit_log").includes("actor")) db.exec("ALTER TABLE audit_log ADD COLUMN actor TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at)");
  // verificação em duas etapas (TOTP) por conta
  const userCols = cols("users");
  for (const [name, type] of [["totp_secret", "TEXT"], ["totp_pending_secret", "TEXT"], ["totp_enabled", "INTEGER NOT NULL DEFAULT 0"], ["totp_last_step", "INTEGER"]] as const)
    if (!userCols.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  // chamada (primeira linha) de cada publicação e quem escreveu: "ia" ou "modelo"
  const pubCols = cols("publications");
  if (!pubCols.includes("hook")) db.exec("ALTER TABLE publications ADD COLUMN hook TEXT");
  if (!pubCols.includes("hook_source")) db.exec("ALTER TABLE publications ADD COLUMN hook_source TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS recovery_codes (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at TEXT,
    PRIMARY KEY (user_id, code_hash)
  )`);
}
