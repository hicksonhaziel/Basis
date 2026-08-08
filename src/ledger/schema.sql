-- Basis Ledger Schema
-- SQLite WAL mode for concurrent read/write
-- This is the queryable source of truth alongside the hash-chained JSONL audit log.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─── Quotes ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS quotes (
  quote_id TEXT PRIMARY KEY,
  job_hash TEXT NOT NULL,
  job_type TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  deadline_tier TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  price_usd TEXT NOT NULL,
  payment_tier TEXT NOT NULL,
  pricing_model_version TEXT NOT NULL,
  breakdown_json TEXT NOT NULL,
  simulation_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_quotes_job_hash ON quotes(job_hash);
CREATE INDEX IF NOT EXISTS idx_quotes_expires ON quotes(expires_at);

-- ─── Orders ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(quote_id),
  state TEXT NOT NULL DEFAULT 'PAID',
  payment_tx_hash TEXT,
  payment_amount_usd TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_quote ON orders(quote_id);
CREATE INDEX IF NOT EXISTS idx_orders_state ON orders(state);

-- ─── Executions ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS executions (
  execution_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(order_id),
  keeperhub_execution_id TEXT,
  idempotency_key TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'EXECUTING',
  transaction_hash TEXT,
  gas_used TEXT,
  gas_used_wei TEXT,
  sponsored INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_executions_order ON executions(order_id);
CREATE INDEX IF NOT EXISTS idx_executions_state ON executions(state);
CREATE INDEX IF NOT EXISTS idx_executions_idempotency ON executions(idempotency_key);

-- ─── Receipts ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL REFERENCES executions(execution_id),
  transaction_hash TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  receipt_status TEXT NOT NULL,
  block_number INTEGER,
  gas_used TEXT,
  verified_at TEXT,
  postconditions_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_receipts_execution ON receipts(execution_id);

-- ─── Refunds ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS refunds (
  refund_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(order_id),
  reason TEXT NOT NULL,
  amount_usd TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  keeperhub_execution_id TEXT,
  transaction_hash TEXT,
  state TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id);

-- ─── Fee Samples ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fee_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  base_fee_per_gas TEXT NOT NULL,
  priority_fee_per_gas TEXT NOT NULL,
  effective_gas_price TEXT NOT NULL,
  collected_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fee_samples_chain_block ON fee_samples(chain_id, block_number);

-- ─── FX Samples ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS fx_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id INTEGER NOT NULL,
  price_usd TEXT NOT NULL,
  raw_answer TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  round_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  collected_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fx_samples_chain ON fx_samples(chain_id, collected_at);

-- ─── Audit Events ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(type);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_id);
