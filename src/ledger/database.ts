/**
 * Basis Ledger — SQLite + Hash-Chained JSONL Audit Log.
 *
 * Dual-ledger design:
 * - SQLite (WAL mode): queryable source of truth, fast lookups
 * - JSONL (append-only): tamper-evident audit trail, SHA-256 hash chain
 *
 * Every consequential state transition appends to both.
 * The JSONL can be independently verified by any party.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AuditEvent {
  seq: number;
  timestamp: string;
  type: string;
  entityId: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export type EventType =
  | 'QUOTE_ISSUED'
  | 'ORDER_CREATED'
  | 'EXECUTION_STARTED'
  | 'EXECUTION_VERIFIED'
  | 'EXECUTION_FAILED'
  | 'EXECUTION_UNCERTAIN'
  | 'REFUND_ISSUED'
  | 'REFUND_COMPLETED'
  | 'FEE_SAMPLE_COLLECTED'
  | 'FX_SAMPLE_COLLECTED';

// ─── Database ────────────────────────────────────────────────────────────────

export class Ledger {
  private db: Database.Database;
  private jsonlPath: string;
  private lastHash: string;

  constructor(dbPath: string, jsonlPath: string) {
    // Ensure directories exist
    const dbDir = dirname(dbPath);
    const jsonlDir = dirname(jsonlPath);
    if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
    if (!existsSync(jsonlDir)) mkdirSync(jsonlDir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.jsonlPath = jsonlPath;

    // Initialize schema
    const schema = readFileSync(resolve(import.meta.dirname!, 'schema.sql'), 'utf-8');
    this.db.exec(schema);

    // Recover last hash from audit_events table
    const lastRow = this.db.prepare(
      'SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1',
    ).get() as { hash: string } | undefined;
    this.lastHash = lastRow?.hash ?? '0'.repeat(64);
  }

  // ─── Audit Chain ──────────────────────────────────────────────────────────

  /**
   * Append an audit event to both SQLite and JSONL.
   * Returns the created event with its sequence number and hash.
   */
  appendEvent(type: EventType, entityId: string, payload: Record<string, unknown>): AuditEvent {
    const timestamp = new Date().toISOString();
    const prevHash = this.lastHash;

    // Compute hash: SHA-256(canonicalJSON(seq placeholder, timestamp, type, entityId, payload, prevHash))
    // We get seq after insert, so we compute with -1 and update... 
    // Actually, let's compute seq first from current count
    const seqRow = this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 as next_seq FROM audit_events').get() as { next_seq: number };
    const seq = seqRow.next_seq;

    const hash = computeEventHash(seq, timestamp, type, entityId, payload, prevHash);

    // Insert into SQLite
    this.db.prepare(`
      INSERT INTO audit_events (seq, timestamp, type, entity_id, payload_json, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(seq, timestamp, type, entityId, JSON.stringify(payload), prevHash, hash);

    // Append to JSONL
    const event: AuditEvent = { seq, timestamp, type, entityId, payload, prevHash, hash };
    appendFileSync(this.jsonlPath, JSON.stringify(event) + '\n');

    this.lastHash = hash;
    return event;
  }

  /**
   * Get the last hash in the chain.
   */
  getLastHash(): string {
    return this.lastHash;
  }

  /**
   * Get total event count.
   */
  getEventCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM audit_events').get() as { count: number };
    return row.count;
  }

  // ─── Quote Operations ─────────────────────────────────────────────────────

  insertQuote(quote: {
    quoteId: string;
    jobHash: string;
    jobType: string;
    chainId: number;
    deadlineTier: string;
    deadlineAt: string;
    expiresAt: string;
    priceUsd: string;
    paymentTier: string;
    pricingModelVersion: string;
    breakdown: Record<string, unknown>;
    simulation: Record<string, unknown>;
    signature: string;
    issuedAt: string;
  }): void {
    this.db.prepare(`
      INSERT INTO quotes (quote_id, job_hash, job_type, chain_id, deadline_tier, deadline_at,
        expires_at, price_usd, payment_tier, pricing_model_version, breakdown_json,
        simulation_json, signature, issued_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      quote.quoteId, quote.jobHash, quote.jobType, quote.chainId,
      quote.deadlineTier, quote.deadlineAt, quote.expiresAt, quote.priceUsd,
      quote.paymentTier, quote.pricingModelVersion,
      JSON.stringify(quote.breakdown), JSON.stringify(quote.simulation),
      quote.signature, quote.issuedAt,
    );
  }

  markQuoteConsumed(quoteId: string): void {
    this.db.prepare(`
      UPDATE quotes SET consumed = 1, consumed_at = ? WHERE quote_id = ?
    `).run(new Date().toISOString(), quoteId);
  }

  isQuoteConsumed(quoteId: string): boolean {
    const row = this.db.prepare('SELECT consumed FROM quotes WHERE quote_id = ?').get(quoteId) as { consumed: number } | undefined;
    return row?.consumed === 1;
  }

  // ─── Order Operations ─────────────────────────────────────────────────────

  insertOrder(order: {
    orderId: string;
    quoteId: string;
    state: string;
    paymentTxHash?: string;
    paymentAmountUsd: string;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO orders (order_id, quote_id, state, payment_tx_hash, payment_amount_usd, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(order.orderId, order.quoteId, order.state, order.paymentTxHash ?? null, order.paymentAmountUsd, now, now);
  }

  updateOrderState(orderId: string, state: string): void {
    this.db.prepare(`
      UPDATE orders SET state = ?, updated_at = ? WHERE order_id = ?
    `).run(state, new Date().toISOString(), orderId);
  }

  // ─── Execution Operations ─────────────────────────────────────────────────

  insertExecution(exec: {
    executionId: string;
    orderId: string;
    keeperhubExecutionId?: string;
    idempotencyKey: string;
    chainId: number;
    state: string;
  }): void {
    this.db.prepare(`
      INSERT INTO executions (execution_id, order_id, keeperhub_execution_id, idempotency_key,
        chain_id, state, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      exec.executionId, exec.orderId, exec.keeperhubExecutionId ?? null,
      exec.idempotencyKey, exec.chainId, exec.state, new Date().toISOString(),
    );
  }

  updateExecution(executionId: string, updates: {
    state?: string;
    transactionHash?: string;
    gasUsed?: string;
    gasUsedWei?: string;
    sponsored?: boolean;
    completedAt?: string;
    error?: string;
    keeperhubExecutionId?: string;
  }): void {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.state !== undefined) { fields.push('state = ?'); values.push(updates.state); }
    if (updates.transactionHash !== undefined) { fields.push('transaction_hash = ?'); values.push(updates.transactionHash); }
    if (updates.gasUsed !== undefined) { fields.push('gas_used = ?'); values.push(updates.gasUsed); }
    if (updates.gasUsedWei !== undefined) { fields.push('gas_used_wei = ?'); values.push(updates.gasUsedWei); }
    if (updates.sponsored !== undefined) { fields.push('sponsored = ?'); values.push(updates.sponsored ? 1 : 0); }
    if (updates.completedAt !== undefined) { fields.push('completed_at = ?'); values.push(updates.completedAt); }
    if (updates.error !== undefined) { fields.push('error = ?'); values.push(updates.error); }
    if (updates.keeperhubExecutionId !== undefined) { fields.push('keeperhub_execution_id = ?'); values.push(updates.keeperhubExecutionId); }

    if (fields.length === 0) return;
    values.push(executionId);

    this.db.prepare(`UPDATE executions SET ${fields.join(', ')} WHERE execution_id = ?`).run(...values);
  }

  // ─── Utility ──────────────────────────────────────────────────────────────

  /**
   * Get raw database for advanced queries.
   */
  getDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

// ─── Hash Chain Functions ────────────────────────────────────────────────────

/**
 * Compute the SHA-256 hash for an audit event.
 * Hash = SHA-256(JSON.stringify({seq, timestamp, type, entityId, payload, prevHash}))
 * Keys are sorted for determinism.
 */
export function computeEventHash(
  seq: number,
  timestamp: string,
  type: string,
  entityId: string,
  payload: Record<string, unknown>,
  prevHash: string,
): string {
  const obj = { seq, timestamp, type, entityId, payload, prevHash };
  const canonical = JSON.stringify(obj, Object.keys(obj).sort());
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Verify the integrity of a JSONL audit chain.
 * Returns the first broken sequence number, or null if the chain is valid.
 */
export function verifyAuditChain(jsonlPath: string): { valid: boolean; brokenAt?: number; error?: string } {
  if (!existsSync(jsonlPath)) {
    return { valid: true }; // Empty chain is valid
  }

  const content = readFileSync(jsonlPath, 'utf-8').trim();
  if (!content) return { valid: true };

  const lines = content.split('\n');
  let prevHash = '0'.repeat(64);

  for (let i = 0; i < lines.length; i++) {
    const event: AuditEvent = JSON.parse(lines[i]!);

    // Verify sequence continuity
    if (event.seq !== i + 1) {
      return { valid: false, brokenAt: i + 1, error: `Expected seq ${i + 1}, got ${event.seq}` };
    }

    // Verify prev hash
    if (event.prevHash !== prevHash) {
      return { valid: false, brokenAt: event.seq, error: `prevHash mismatch at seq ${event.seq}` };
    }

    // Recompute and verify hash
    const expectedHash = computeEventHash(
      event.seq, event.timestamp, event.type, event.entityId, event.payload, event.prevHash,
    );
    if (event.hash !== expectedHash) {
      return { valid: false, brokenAt: event.seq, error: `Hash mismatch at seq ${event.seq}` };
    }

    prevHash = event.hash;
  }

  return { valid: true };
}
