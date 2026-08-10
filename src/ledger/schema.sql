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
  intent_json TEXT,
  oracle_evidence_json TEXT NOT NULL,
  canonicalization_format TEXT NOT NULL,
  signature_format TEXT NOT NULL,
  refund_recipient TEXT NOT NULL,
  refund_policy_id TEXT NOT NULL,
  refund_chain_id INTEGER NOT NULL,
  refund_token_address TEXT NOT NULL,
  gross_refund_amount_usd TEXT NOT NULL,
  refund_amount_atomic TEXT NOT NULL,
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
  quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(quote_id),
  state TEXT NOT NULL DEFAULT 'AUTHENTICATED_INGRESS',
  authority_kind TEXT NOT NULL,
  callback_auth_kind TEXT NOT NULL,
  marketplace_tier TEXT,
  settlement_metadata_status TEXT NOT NULL,
  refund_recipient TEXT NOT NULL,
  payment_amount_usd TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_quote ON orders(quote_id);
CREATE INDEX IF NOT EXISTS idx_orders_state ON orders(state);

-- ─── State transition history ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS order_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(order_id),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_source TEXT NOT NULL,
  transitioned_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_transitions_order ON order_transitions(order_id, id);

-- ─── Executions ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS executions (
  execution_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(order_id),
  keeperhub_execution_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  chain_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'AUTHENTICATED_INGRESS',
  canonical_intent_json TEXT NOT NULL,
  outbound_request_json TEXT NOT NULL,
  submission_state TEXT NOT NULL DEFAULT 'NOT_SUBMITTED',
  idempotent_replay INTEGER NOT NULL DEFAULT 0,
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
  keeperhub_verified INTEGER NOT NULL,
  independent_verified INTEGER NOT NULL,
  receipt_status TEXT NOT NULL,
  block_number INTEGER,
  gas_used TEXT,
  verified_at TEXT NOT NULL,
  verification_source TEXT NOT NULL,
  decoded_logs_json TEXT NOT NULL,
  postconditions_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receipts_execution ON receipts(execution_id);

-- ─── Refunds ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS refunds (
  refund_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(order_id),
  quote_id TEXT NOT NULL REFERENCES quotes(quote_id),
  payment_tier TEXT NOT NULL,
  gross_payment_usd TEXT NOT NULL,
  marketplace_fee_usd TEXT NOT NULL,
  basis_net_revenue_usd TEXT NOT NULL,
  gross_refund_amount_usd TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  refund_policy_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  token_address TEXT NOT NULL,
  refund_recipient TEXT NOT NULL,
  expected_sender TEXT NOT NULL,
  eligibility_reason TEXT NOT NULL,
  eligibility_detail TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  outbound_request_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'REFUND_PENDING',
  keeperhub_execution_id TEXT,
  transaction_hash TEXT,
  independent_receipt_block_number TEXT,
  gas_used TEXT,
  decoded_transfer_json TEXT,
  refund_gas_cost_usd TEXT,
  realized_pnl_usd TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT,
  uncertainty_reason TEXT,
  error_reason TEXT,
  UNIQUE(order_id, refund_policy_id)
);

CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id);
CREATE INDEX IF NOT EXISTS idx_refunds_state ON refunds(state);

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
  canonicalization_format TEXT NOT NULL DEFAULT 'basis-canonical-json:v1',
  hash_format TEXT NOT NULL DEFAULT 'sha256:v2',
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(type);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_id);
