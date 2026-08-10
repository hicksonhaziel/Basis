/** SQLite source of truth plus append-only hash-chained audit evidence. */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalJson, CANONICAL_JSON_FORMAT } from '../integrity/canonical.ts';
import { assertOrderState, transition, type OrderState } from '../executor/state-machine.ts';
import type { PersistedExecutionIntent } from '../executor/intent.ts';
import type { ExecuteContractCallRequest } from '../keeperhub/client.ts';
import { Decimal } from 'decimal.js';
import { refundTermsForTier, REFUND_POLICY_ID, MARKETPLACE_FEE_BPS } from '../config/policy.ts';
import { deriveRefundIdempotencyKey } from '../executor/idempotency.ts';
import type { DecodedLog, PostconditionCheck } from '../adapters/adapter.ts';

export const AUDIT_HASH_FORMAT = 'sha256:v2' as const;
export interface AuditEvent { seq: number; timestamp: string; type: string; entityId: string; payload: Record<string, unknown>; canonicalizationFormat: typeof CANONICAL_JSON_FORMAT; hashFormat: typeof AUDIT_HASH_FORMAT; prevHash: string; hash: string; }
export type EventType = 'QUOTE_ISSUED' | 'ORDER_CREATED' | 'STATE_TRANSITION' | 'EXECUTION_STARTED' | 'EXECUTION_SUBMISSION_PERSISTED' | 'EXECUTION_SUBMITTED' | 'EXECUTION_VERIFIED' | 'EXECUTION_FAILED' | 'EXECUTION_UNCERTAIN' | 'REFUND_ELIGIBILITY_DECIDED' | 'REFUND_CREATED' | 'REFUND_SIMULATED' | 'REFUND_SUBMITTED' | 'REFUND_UNCERTAIN' | 'REFUND_VERIFIED' | 'REFUND_FAILED' | 'FEE_SAMPLE_COLLECTED' | 'FX_SAMPLE_COLLECTED';

export interface AdmissionInput {
  quoteId: string;
  orderId: string;
  executionId: string;
  authorityKind: 'AUTHENTICATED_PRIVATE_WORKFLOW' | 'MARKETPLACE_PAYMENT_AUTHORIZED';
  callbackAuthKind: 'AUTHENTICATED_WORKFLOW_CALLBACK';
  marketplaceTier?: string;
  settlementMetadataStatus: 'NOT_EXPOSED_TO_WORKFLOW' | 'NOT_APPLICABLE';
  refundRecipient: string;
  paymentAmountUsd: string;
  idempotencyKey: string;
  chainId: number;
  intent: PersistedExecutionIntent;
  outboundRequest: ExecuteContractCallRequest;
}

export interface ExecutionRecord {
  execution_id: string; order_id: string; keeperhub_execution_id: string | null; idempotency_key: string; chain_id: number;
  state: OrderState; canonical_intent_json: string; outbound_request_json: string; submission_state: string;
  idempotent_replay: number; transaction_hash: string | null; error: string | null;
}

export interface RefundRecord {
  refund_id: string; order_id: string; quote_id: string; payment_tier: string;
  gross_payment_usd: string; marketplace_fee_usd: string; basis_net_revenue_usd: string;
  gross_refund_amount_usd: string; amount_atomic: string; refund_policy_id: string;
  chain_id: number; token_address: string; refund_recipient: string; expected_sender: string;
  eligibility_reason: string; eligibility_detail: string; idempotency_key: string;
  outbound_request_json: string; state: OrderState; keeperhub_execution_id: string | null;
  transaction_hash: string | null; independent_receipt_block_number: string | null;
  gas_used: string | null; decoded_transfer_json: string | null; refund_gas_cost_usd: string | null;
  realized_pnl_usd: string; created_at: string; updated_at: string; verified_at: string | null;
  uncertainty_reason: string | null; error_reason: string | null;
}

export class Ledger {
  private db: Database.Database;
  private jsonlPath: string;
  private lastHash: string;

  constructor(dbPath: string, jsonlPath: string) {
    for (const dir of [dirname(dbPath), dirname(jsonlPath)]) if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.jsonlPath = jsonlPath;
    this.db.exec(readFileSync(resolve(import.meta.dirname!, 'schema.sql'), 'utf-8'));
    this.migrateExistingDatabase();
    const last = this.db.prepare('SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
    this.lastHash = last?.hash ?? '0'.repeat(64);
    this.repairAuditFile();
  }

  private migrateExistingDatabase(): void {
    const add = (table: string, column: string, definition: string): void => {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    add('quotes', 'intent_json', 'TEXT');
    add('quotes', 'oracle_evidence_json', "TEXT NOT NULL DEFAULT '{}'");
    add('quotes', 'canonicalization_format', "TEXT NOT NULL DEFAULT 'basis-canonical-json:v1'");
    add('quotes', 'signature_format', "TEXT NOT NULL DEFAULT 'hmac-sha256:v2'");
    add('quotes', 'refund_recipient', "TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000'");
    add('quotes', 'refund_policy_id', "TEXT NOT NULL DEFAULT ''");
    add('quotes', 'refund_chain_id', 'INTEGER NOT NULL DEFAULT 0');
    add('quotes', 'refund_token_address', "TEXT NOT NULL DEFAULT ''");
    add('quotes', 'gross_refund_amount_usd', "TEXT NOT NULL DEFAULT ''");
    add('quotes', 'refund_amount_atomic', "TEXT NOT NULL DEFAULT ''");
    add('order_transitions', 'actor_source', "TEXT NOT NULL DEFAULT 'legacy'");
    add('orders', 'callback_auth_kind', "TEXT NOT NULL DEFAULT 'LEGACY_UNKNOWN'");
    add('orders', 'marketplace_tier', 'TEXT');
    add('orders', 'settlement_metadata_status', "TEXT NOT NULL DEFAULT 'NOT_APPLICABLE'");
    add('orders', 'refund_recipient', "TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000'");
    add('audit_events', 'canonicalization_format', "TEXT NOT NULL DEFAULT 'basis-canonical-json:v1'");
    add('audit_events', 'hash_format', "TEXT NOT NULL DEFAULT 'sha256:v2'");
    add('orders', 'authority_kind', "TEXT NOT NULL DEFAULT 'LEGACY_UNKNOWN'");
    add('executions', 'canonical_intent_json', "TEXT NOT NULL DEFAULT '{}'");
    add('executions', 'outbound_request_json', "TEXT NOT NULL DEFAULT '{}'");
    add('executions', 'submission_state', "TEXT NOT NULL DEFAULT 'LEGACY_UNKNOWN'");
    add('executions', 'idempotent_replay', 'INTEGER NOT NULL DEFAULT 0');
    add('refunds', 'quote_id', "TEXT NOT NULL DEFAULT ''");
    add('refunds', 'payment_tier', "TEXT NOT NULL DEFAULT ''");
    add('refunds', 'gross_payment_usd', "TEXT NOT NULL DEFAULT '0'");
    add('refunds', 'marketplace_fee_usd', "TEXT NOT NULL DEFAULT '0'");
    add('refunds', 'basis_net_revenue_usd', "TEXT NOT NULL DEFAULT '0'");
    add('refunds', 'gross_refund_amount_usd', "TEXT NOT NULL DEFAULT '0'");
    add('refunds', 'amount_atomic', "TEXT NOT NULL DEFAULT '0'");
    add('refunds', 'refund_policy_id', "TEXT NOT NULL DEFAULT ''");
    add('refunds', 'chain_id', 'INTEGER NOT NULL DEFAULT 0');
    add('refunds', 'token_address', "TEXT NOT NULL DEFAULT ''");
    add('refunds', 'refund_recipient', "TEXT NOT NULL DEFAULT ''");
    add('refunds', 'expected_sender', "TEXT NOT NULL DEFAULT ''");
    add('refunds', 'eligibility_reason', "TEXT NOT NULL DEFAULT ''");
    add('refunds', 'eligibility_detail', "TEXT NOT NULL DEFAULT ''");
    add('refunds', 'outbound_request_json', "TEXT NOT NULL DEFAULT '{}'");
    add('refunds', 'updated_at', "TEXT NOT NULL DEFAULT ''");
    add('refunds', 'verified_at', 'TEXT');
    add('refunds', 'independent_receipt_block_number', 'TEXT');
    add('refunds', 'gas_used', 'TEXT');
    add('refunds', 'decoded_transfer_json', 'TEXT');
    add('refunds', 'refund_gas_cost_usd', 'TEXT');
    add('refunds', 'realized_pnl_usd', "TEXT NOT NULL DEFAULT '0'");
    add('refunds', 'uncertainty_reason', 'TEXT');
    add('refunds', 'error_reason', 'TEXT');
    add('receipts', 'keeperhub_verified', 'INTEGER NOT NULL DEFAULT 0');
    add('receipts', 'independent_verified', 'INTEGER NOT NULL DEFAULT 0');
    add('receipts', 'verification_source', "TEXT NOT NULL DEFAULT 'legacy'");
    add('receipts', 'decoded_logs_json', "TEXT NOT NULL DEFAULT '[]'");
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_quote_unique ON orders(quote_id)');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_order_unique ON executions(order_id)');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_idempotency_unique ON executions(idempotency_key)');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_order_policy_unique ON refunds(order_id,refund_policy_id)');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_idempotency_unique ON refunds(idempotency_key)');
  }

  private insertAuditRow(type: EventType, entityId: string, payload: Record<string, unknown>): AuditEvent {
    const timestamp = new Date().toISOString();
    const inserted = this.db.prepare(`INSERT INTO audit_events
      (timestamp,type,entity_id,payload_json,canonicalization_format,hash_format,prev_hash,hash)
      VALUES (?,?,?,?,?,?,?,?)`).run(timestamp, type, entityId, JSON.stringify(payload), CANONICAL_JSON_FORMAT, AUDIT_HASH_FORMAT, '', '');
    const seq = Number(inserted.lastInsertRowid);
    const previous = this.db.prepare('SELECT hash FROM audit_events WHERE seq < ? ORDER BY seq DESC LIMIT 1').get(seq) as { hash: string } | undefined;
    const prevHash = previous?.hash ?? '0'.repeat(64);
    const hash = computeEventHash(seq, timestamp, type, entityId, payload, prevHash, CANONICAL_JSON_FORMAT, AUDIT_HASH_FORMAT);
    this.db.prepare('UPDATE audit_events SET prev_hash=?,hash=? WHERE seq=?').run(prevHash, hash, seq);
    return { seq, timestamp, type, entityId, payload, canonicalizationFormat: CANONICAL_JSON_FORMAT, hashFormat: AUDIT_HASH_FORMAT, prevHash, hash };
  }

  private commitAuditFiles(events: AuditEvent[]): void {
    if (!events.length) return;
    this.lastHash = events.at(-1)!.hash;
    this.exportAuditJsonl();
  }

  exportAuditJsonl(): void {
    const rows = this.db.prepare(`SELECT seq,timestamp,type,entity_id,payload_json,canonicalization_format,hash_format,prev_hash,hash
      FROM audit_events ORDER BY seq`).all() as Array<Record<string, unknown>>;
    const content = rows.map((row) => JSON.stringify({
      seq: row.seq, timestamp: row.timestamp, type: row.type, entityId: row.entity_id,
      payload: JSON.parse(row.payload_json as string), canonicalizationFormat: row.canonicalization_format,
      hashFormat: row.hash_format, prevHash: row.prev_hash, hash: row.hash,
    })).join('\n');
    const temporary = `${this.jsonlPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      writeFileSync(temporary, content ? `${content}\n` : '', { flag: 'wx' });
      renameSync(temporary, this.jsonlPath);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }

  private repairAuditFile(): void { this.exportAuditJsonl(); }

  appendEvent(type: EventType, entityId: string, payload: Record<string, unknown>): AuditEvent {
    let event!: AuditEvent;
    this.db.transaction(() => { event = this.insertAuditRow(type, entityId, payload); })();
    this.commitAuditFiles([event]);
    return event;
  }

  getLastHash(): string { return this.lastHash; }
  getEventCount(): number { return (this.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get() as { count: number }).count; }

  insertQuote(quote: {
    quoteId: string; jobHash: string; jobType: string; chainId: number; deadlineTier: string; deadlineAt: string; expiresAt: string;
    priceUsd: string; paymentTier: string; pricingModelVersion: string; breakdown: Record<string, unknown>; simulation: Record<string, unknown>;
    intent?: Record<string, unknown>; oracleEvidence?: Record<string, unknown>; canonicalizationFormat?: string; signatureFormat?: string;
    refundRecipient: string; refundPolicyId?: string; refundChainId?: number; refundTokenAddress?: string;
    grossRefundAmountUsd?: string; refundAmountAtomic?: string; signature: string; issuedAt: string;
  }): void {
    const terms = refundTermsForTier(quote.paymentTier);
    this.db.prepare(`INSERT INTO quotes (quote_id,job_hash,job_type,chain_id,deadline_tier,deadline_at,expires_at,price_usd,payment_tier,pricing_model_version,breakdown_json,simulation_json,intent_json,oracle_evidence_json,canonicalization_format,signature_format,refund_recipient,refund_policy_id,refund_chain_id,refund_token_address,gross_refund_amount_usd,refund_amount_atomic,signature,issued_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      quote.quoteId, quote.jobHash, quote.jobType, quote.chainId, quote.deadlineTier, quote.deadlineAt, quote.expiresAt, quote.priceUsd,
      quote.paymentTier, quote.pricingModelVersion, JSON.stringify(quote.breakdown), JSON.stringify(quote.simulation), quote.intent ? JSON.stringify(quote.intent) : null,
      JSON.stringify(quote.oracleEvidence ?? {}), quote.canonicalizationFormat ?? CANONICAL_JSON_FORMAT, quote.signatureFormat ?? 'hmac-sha256:v2', quote.refundRecipient,
      quote.refundPolicyId ?? terms.refundPolicyId, quote.refundChainId ?? terms.refundChainId, quote.refundTokenAddress ?? terms.refundTokenAddress, quote.grossRefundAmountUsd ?? terms.grossRefundAmountUsd, quote.refundAmountAtomic ?? terms.refundAmountAtomic, quote.signature, quote.issuedAt,
    );
  }

  markQuoteConsumed(quoteId: string): void { this.db.prepare('UPDATE quotes SET consumed=1, consumed_at=? WHERE quote_id=?').run(new Date().toISOString(), quoteId); }
  isQuoteConsumed(quoteId: string): boolean { return (this.db.prepare('SELECT consumed FROM quotes WHERE quote_id=?').get(quoteId) as { consumed: number } | undefined)?.consumed === 1; }

  admitOrder(input: AdmissionInput): void {
    const now = new Date().toISOString();
    const events: AuditEvent[] = [];
    this.db.transaction(() => {
      const consumed = this.db.prepare('UPDATE quotes SET consumed=1, consumed_at=? WHERE quote_id=? AND consumed=0').run(now, input.quoteId);
      if (consumed.changes !== 1) throw new Error(`Quote ${input.quoteId} has already been consumed`);
      this.db.prepare(`INSERT INTO orders
        (order_id,quote_id,state,authority_kind,callback_auth_kind,marketplace_tier,settlement_metadata_status,refund_recipient,payment_amount_usd,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.orderId, input.quoteId, 'AUTHENTICATED_INGRESS', input.authorityKind, input.callbackAuthKind,
        input.marketplaceTier ?? null, input.settlementMetadataStatus, input.refundRecipient, input.paymentAmountUsd, now, now,
      );
      this.db.prepare(`INSERT INTO executions (execution_id,order_id,idempotency_key,chain_id,state,canonical_intent_json,outbound_request_json,submission_state,started_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(
        input.executionId, input.orderId, input.idempotencyKey, input.chainId, 'AUTHENTICATED_INGRESS', JSON.stringify(input.intent), JSON.stringify(input.outboundRequest), 'REQUEST_PERSISTED', now,
      );
      this.db.prepare('INSERT INTO order_transitions (order_id,from_state,to_state,reason,actor_source,transitioned_at) VALUES (?,?,?,?,?,?)').run(input.orderId, 'QUOTED', 'AUTHENTICATED_INGRESS', input.authorityKind, 'keeperhub-workflow-callback', now);
      const created = this.insertAuditRow('ORDER_CREATED', input.orderId, {
        quoteId: input.quoteId,
        authorityKind: input.authorityKind,
        callbackAuthKind: input.callbackAuthKind,
        marketplaceTier: input.marketplaceTier,
        settlementMetadataStatus: input.settlementMetadataStatus,
        refundRecipient: input.refundRecipient,
        marketplacePaymentAuthorized: input.authorityKind === 'MARKETPLACE_PAYMENT_AUTHORIZED',
      });
      events.push(created, this.insertAuditRow('EXECUTION_SUBMISSION_PERSISTED', input.executionId, { idempotencyKey: input.idempotencyKey, request: input.outboundRequest }));
    })();
    this.commitAuditFiles(events);
  }

  /** Compatibility helper for non-execution ledger tests. */
  insertOrder(order: { orderId: string; quoteId: string; state: string; paymentAmountUsd: string }): void {
    assertOrderState(order.state);
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO orders
      (order_id,quote_id,state,authority_kind,callback_auth_kind,settlement_metadata_status,refund_recipient,payment_amount_usd,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(order.orderId, order.quoteId, order.state, 'LEGACY_TEST', 'LEGACY_UNKNOWN', 'NOT_APPLICABLE', '0x0000000000000000000000000000000000000000', order.paymentAmountUsd, now, now);
  }

  transitionOrder(orderId: string, to: OrderState, reason: string, actorSource = 'basis-runtime'): void {
    if (!reason.trim()) throw new Error('State transition reason is required');
    const now = new Date().toISOString();
    let from!: OrderState;
    let event!: AuditEvent;
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT state FROM orders WHERE order_id=?').get(orderId) as { state: string } | undefined;
      if (!row) throw new Error(`Order not found: ${orderId}`);
      assertOrderState(row.state); from = row.state; transition(from, to);
      const changed = this.db.prepare('UPDATE orders SET state=?,updated_at=? WHERE order_id=? AND state=?').run(to, now, orderId, from);
      if (changed.changes !== 1) throw new Error(`Concurrent state transition detected for ${orderId}`);
      this.db.prepare('UPDATE executions SET state=? WHERE order_id=?').run(to, orderId);
      this.db.prepare('INSERT INTO order_transitions (order_id,from_state,to_state,reason,actor_source,transitioned_at) VALUES (?,?,?,?,?,?)').run(orderId, from, to, reason, actorSource, now);
      event = this.insertAuditRow('STATE_TRANSITION', orderId, { from, to, reason, actorSource, transitionedAt: now });
    })();
    this.commitAuditFiles([event]);
  }

  updateOrderState(orderId: string, state: string): void { assertOrderState(state); this.transitionOrder(orderId, state, 'legacy caller'); }

  insertExecution(exec: { executionId: string; orderId: string; keeperhubExecutionId?: string; idempotencyKey: string; chainId: number; state: string }): void {
    assertOrderState(exec.state);
    this.db.prepare(`INSERT INTO executions (execution_id,order_id,keeperhub_execution_id,idempotency_key,chain_id,state,canonical_intent_json,outbound_request_json,submission_state,started_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(exec.executionId, exec.orderId, exec.keeperhubExecutionId ?? null, exec.idempotencyKey, exec.chainId, exec.state, '{}', '{}', 'LEGACY_TEST', new Date().toISOString());
  }

  updateExecution(executionId: string, updates: { state?: string; transactionHash?: string; gasUsed?: string; gasUsedWei?: string; sponsored?: boolean; completedAt?: string; error?: string; keeperhubExecutionId?: string; submissionState?: string; idempotentReplay?: boolean }): void {
    const fields: string[] = []; const values: unknown[] = [];
    const put = (column: string, value: unknown): void => { fields.push(`${column}=?`); values.push(value); };
    if (updates.state !== undefined) { assertOrderState(updates.state); put('state', updates.state); }
    if (updates.transactionHash !== undefined) put('transaction_hash', updates.transactionHash);
    if (updates.gasUsed !== undefined) put('gas_used', updates.gasUsed);
    if (updates.gasUsedWei !== undefined) put('gas_used_wei', updates.gasUsedWei);
    if (updates.sponsored !== undefined) put('sponsored', updates.sponsored ? 1 : 0);
    if (updates.completedAt !== undefined) put('completed_at', updates.completedAt);
    if (updates.error !== undefined) put('error', updates.error);
    if (updates.keeperhubExecutionId !== undefined) put('keeperhub_execution_id', updates.keeperhubExecutionId);
    if (updates.submissionState !== undefined) put('submission_state', updates.submissionState);
    if (updates.idempotentReplay !== undefined) put('idempotent_replay', updates.idempotentReplay ? 1 : 0);
    if (!fields.length) return; values.push(executionId);
    this.db.prepare(`UPDATE executions SET ${fields.join(',')} WHERE execution_id=?`).run(...values);
  }

  recordSubmission(executionId: string, keeperhubExecutionId: string, idempotentReplay: boolean): void {
    this.updateExecution(executionId, { keeperhubExecutionId, submissionState: 'ACKNOWLEDGED', idempotentReplay });
    this.appendEvent('EXECUTION_SUBMITTED', executionId, { keeperhubExecutionId, idempotentReplay });
  }

  recordReceipt(input: { executionId: string; transactionHash: string; chainId: number; keeperHubVerified: boolean; independentVerified: boolean; receiptStatus: string; blockNumber: bigint; gasUsed: bigint; decodedLogs: DecodedLog[]; postconditions: PostconditionCheck[] }): void {
    this.db.prepare(`INSERT INTO receipts (execution_id,transaction_hash,chain_id,keeperhub_verified,independent_verified,receipt_status,block_number,gas_used,verified_at,verification_source,decoded_logs_json,postconditions_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.executionId, input.transactionHash, input.chainId, input.keeperHubVerified ? 1 : 0, input.independentVerified ? 1 : 0, input.receiptStatus,
      input.blockNumber.toString(), input.gasUsed.toString(), new Date().toISOString(), 'keeperhub+independent-rpc', JSON.stringify(input.decodedLogs), JSON.stringify(input.postconditions),
    );
  }

  getExecution(executionId: string): ExecutionRecord | undefined { return this.db.prepare('SELECT * FROM executions WHERE execution_id=?').get(executionId) as ExecutionRecord | undefined; }
  getRecoverableExecutions(includeCrashRecovery = true): ExecutionRecord[] {
    const states = includeCrashRecovery
      ? "'AUTHENTICATED_INGRESS','RESIMULATING','EXECUTING','VERIFYING','UNCERTAIN'"
      : "'UNCERTAIN'";
    return this.db.prepare(`SELECT * FROM executions WHERE state IN (${states}) ORDER BY started_at`).all() as ExecutionRecord[];
  }
  markRefundEligible(orderId: string, eligibilityReason: string, detail: string): RefundRecord {
    const now = new Date().toISOString();
    const events: AuditEvent[] = [];
    let refund!: RefundRecord;
    this.db.transaction(() => {
      const row = this.db.prepare(`SELECT o.*,q.refund_policy_id,q.refund_chain_id,q.refund_token_address,q.gross_refund_amount_usd,q.refund_amount_atomic,q.payment_tier AS quote_tier,q.price_usd,q.intent_json
        FROM orders o JOIN quotes q ON q.quote_id=o.quote_id WHERE o.order_id=?`).get(orderId) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`Order not found: ${orderId}`);
      if (row.authority_kind !== 'MARKETPLACE_PAYMENT_AUTHORIZED' || row.settlement_metadata_status !== 'NOT_EXPOSED_TO_WORKFLOW') throw new Error('Only atomically accepted paid Marketplace orders are refundable');
      assertOrderState(row.state as string);
      if (row.state === 'UNCERTAIN') throw new Error('Execution uncertainty must resolve before refund eligibility');
      const tier = String(row.marketplace_tier);
      const terms = refundTermsForTier(tier);
      if (row.quote_tier !== tier || row.price_usd !== terms.grossRefundAmountUsd || row.payment_amount_usd !== terms.grossRefundAmountUsd
        || row.refund_policy_id !== terms.refundPolicyId || row.refund_chain_id !== terms.refundChainId
        || String(row.refund_token_address).toLowerCase() !== terms.refundTokenAddress
        || row.gross_refund_amount_usd !== terms.grossRefundAmountUsd || row.refund_amount_atomic !== terms.refundAmountAtomic) {
        throw new Error('Persisted signed quote, authenticated tier, price, and refund policy do not agree');
      }
      const existing = this.db.prepare('SELECT * FROM refunds WHERE order_id=? AND refund_policy_id=?').get(orderId, REFUND_POLICY_ID) as RefundRecord | undefined;
      if (existing) { refund = existing; return; }
      transition(row.state as OrderState, 'REFUND_PENDING');
      const refundId = `refund_${createHash('sha256').update(`${REFUND_POLICY_ID}|${orderId}`).digest('hex').slice(0, 32)}`;
      const idempotencyKey = deriveRefundIdempotencyKey({ refundPolicyId: REFUND_POLICY_ID, orderId, quoteId: String(row.quote_id), chainId: terms.refundChainId, tokenAddress: terms.refundTokenAddress, refundRecipient: String(row.refund_recipient), atomicAmount: terms.refundAmountAtomic });
      const intent = JSON.parse(String(row.intent_json)) as { executorAddress?: string };
      const expectedSender = String(intent.executorAddress ?? '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(expectedSender)) throw new Error('Cannot resolve expected refund sender from signed KeeperHub context');
      const outbound = {
        contractAddress: terms.refundTokenAddress, chainId: terms.refundChainId, functionName: 'transfer',
        functionArgs: JSON.stringify([String(row.refund_recipient).toLowerCase(), terms.refundAmountAtomic]),
        abi: JSON.stringify([{ type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }]),
      };
      const gross = new Decimal(terms.grossRefundAmountUsd);
      const fee = gross.mul(MARKETPLACE_FEE_BPS).div(10_000);
      const net = gross.minus(fee);
      const realized = net.minus(gross);
      this.db.prepare(`INSERT INTO refunds (refund_id,order_id,quote_id,payment_tier,gross_payment_usd,marketplace_fee_usd,basis_net_revenue_usd,gross_refund_amount_usd,amount_atomic,refund_policy_id,chain_id,token_address,refund_recipient,expected_sender,eligibility_reason,eligibility_detail,idempotency_key,outbound_request_json,state,realized_pnl_usd,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(refundId, orderId, row.quote_id, tier, gross.toFixed(2), fee.toFixed(3), net.toFixed(3), terms.grossRefundAmountUsd, terms.refundAmountAtomic, terms.refundPolicyId, terms.refundChainId, terms.refundTokenAddress, String(row.refund_recipient).toLowerCase(), expectedSender, eligibilityReason, detail, idempotencyKey, JSON.stringify(outbound), 'REFUND_PENDING', realized.toFixed(3), now, now);
      this.db.prepare('UPDATE orders SET state=?,updated_at=? WHERE order_id=? AND state=?').run('REFUND_PENDING', now, orderId, row.state);
      this.db.prepare('UPDATE executions SET state=? WHERE order_id=?').run('REFUND_PENDING', orderId);
      this.db.prepare('INSERT INTO order_transitions (order_id,from_state,to_state,reason,actor_source,transitioned_at) VALUES (?,?,?,?,?,?)').run(orderId, row.state, 'REFUND_PENDING', detail, 'refund-eligibility-policy', now);
      events.push(this.insertAuditRow('REFUND_ELIGIBILITY_DECIDED', refundId, { orderId, eligible: true, eligibilityReason, refundPolicyId: terms.refundPolicyId, detailedSettlementMetadataAvailable: false }));
      events.push(this.insertAuditRow('REFUND_CREATED', refundId, { orderId, quoteId: row.quote_id, paymentTier: tier, grossRefundAmountUsd: terms.grossRefundAmountUsd, amountAtomic: terms.refundAmountAtomic, chainId: terms.refundChainId, tokenAddress: terms.refundTokenAddress, refundRecipient: row.refund_recipient, idempotencyKey, economics: { grossCustomerPaymentUsd: gross.toFixed(2), marketplaceFeeUsd: fee.toFixed(3), basisNetRevenueUsd: net.toFixed(3), refundUsd: gross.toFixed(2), realizedPnlBeforeGasUsd: realized.toFixed(3) } }));
      refund = this.db.prepare('SELECT * FROM refunds WHERE refund_id=?').get(refundId) as RefundRecord;
    })();
    this.commitAuditFiles(events);
    return refund;
  }

  claimRefund(refundId: string): RefundRecord | undefined {
    const now = new Date().toISOString(); let event: AuditEvent | undefined; let claimed = false;
    this.db.transaction(() => {
      const row = this.db.prepare(`SELECT r.order_id,o.state AS order_state FROM refunds r JOIN orders o ON o.order_id=r.order_id WHERE r.refund_id=? AND r.state=?`).get(refundId, 'REFUND_PENDING') as { order_id: string; order_state: string } | undefined;
      if (!row) return;
      assertOrderState(row.order_state); transition(row.order_state, 'REFUND_SUBMITTING');
      const refundChanged = this.db.prepare('UPDATE refunds SET state=?,updated_at=? WHERE refund_id=? AND state=?').run('REFUND_SUBMITTING', now, refundId, 'REFUND_PENDING');
      const orderChanged = this.db.prepare('UPDATE orders SET state=?,updated_at=? WHERE order_id=? AND state=?').run('REFUND_SUBMITTING', now, row.order_id, row.order_state);
      if (refundChanged.changes !== 1 || orderChanged.changes !== 1) throw new Error(`Concurrent refund claim detected for ${refundId}`);
      this.db.prepare('UPDATE executions SET state=? WHERE order_id=?').run('REFUND_SUBMITTING', row.order_id);
      this.db.prepare('INSERT INTO order_transitions (order_id,from_state,to_state,reason,actor_source,transitioned_at) VALUES (?,?,?,?,?,?)').run(row.order_id, row.order_state, 'REFUND_SUBMITTING', 'refund worker atomically claimed persisted obligation', 'refund-reconciler', now);
      event = this.insertAuditRow('STATE_TRANSITION', row.order_id, { from: row.order_state, to: 'REFUND_SUBMITTING', reason: 'refund worker atomically claimed persisted obligation', actorSource: 'refund-reconciler', transitionedAt: now });
      claimed = true;
    })();
    if (event) this.commitAuditFiles([event]);
    return claimed ? this.getRefund(refundId) : undefined;
  }

  updateRefundState(refundId: string, to: OrderState, reason: string, updates: Partial<{ keeperhubExecutionId: string; transactionHash: string; expectedSender: string; blockNumber: string; gasUsed: string; decodedTransfer: Record<string, unknown>; verifiedAt: string; uncertaintyReason: string | null; errorReason: string | null }>): RefundRecord {
    const now = new Date().toISOString(); const events: AuditEvent[] = [];
    this.db.transaction(() => {
      const current = this.getRefund(refundId); if (!current) throw new Error(`Refund not found: ${refundId}`);
      transition(current.state, to);
      const order = this.db.prepare('SELECT state FROM orders WHERE order_id=?').get(current.order_id) as { state: string } | undefined;
      if (!order) throw new Error(`Order not found: ${current.order_id}`);
      assertOrderState(order.state); transition(order.state, to);
      const fields = ['state=?', 'updated_at=?']; const values: unknown[] = [to, now];
      const put = (column: string, value: unknown) => { fields.push(`${column}=?`); values.push(value); };
      if (updates.keeperhubExecutionId !== undefined) put('keeperhub_execution_id', updates.keeperhubExecutionId);
      if (updates.transactionHash !== undefined) put('transaction_hash', updates.transactionHash);
      if (updates.expectedSender !== undefined) put('expected_sender', updates.expectedSender);
      if (updates.blockNumber !== undefined) put('independent_receipt_block_number', updates.blockNumber);
      if (updates.gasUsed !== undefined) put('gas_used', updates.gasUsed);
      if (updates.decodedTransfer !== undefined) put('decoded_transfer_json', JSON.stringify(updates.decodedTransfer));
      if (updates.verifiedAt !== undefined) put('verified_at', updates.verifiedAt);
      if (updates.uncertaintyReason !== undefined) put('uncertainty_reason', updates.uncertaintyReason);
      if (updates.errorReason !== undefined) put('error_reason', updates.errorReason);
      values.push(refundId, current.state);
      const refundChanged = this.db.prepare(`UPDATE refunds SET ${fields.join(',')} WHERE refund_id=? AND state=?`).run(...values);
      const orderChanged = this.db.prepare('UPDATE orders SET state=?,updated_at=? WHERE order_id=? AND state=?').run(to, now, current.order_id, order.state);
      if (refundChanged.changes !== 1 || orderChanged.changes !== 1) throw new Error(`Concurrent refund transition detected for ${refundId}`);
      this.db.prepare('UPDATE executions SET state=? WHERE order_id=?').run(to, current.order_id);
      this.db.prepare('INSERT INTO order_transitions (order_id,from_state,to_state,reason,actor_source,transitioned_at) VALUES (?,?,?,?,?,?)').run(current.order_id, order.state, to, reason, 'refund-reconciler', now);
      events.push(this.insertAuditRow('STATE_TRANSITION', current.order_id, { from: order.state, to, reason, actorSource: 'refund-reconciler', transitionedAt: now }));
      const eventType: EventType = to === 'REFUND_UNCERTAIN' ? 'REFUND_UNCERTAIN' : to === 'REFUND_FAILED' ? 'REFUND_FAILED' : to === 'REFUNDED' ? 'REFUND_VERIFIED' : to === 'REFUND_VERIFYING' ? 'REFUND_SUBMITTED' : 'REFUND_SIMULATED';
      events.push(this.insertAuditRow(eventType, refundId, { from: current.state, to, reason, keeperhubExecutionId: updates.keeperhubExecutionId ?? current.keeperhub_execution_id, transactionHash: to === 'REFUNDED' ? updates.transactionHash : undefined }));
    })();
    this.commitAuditFiles(events);
    return this.getRefund(refundId)!;
  }

  getRefund(refundId: string): RefundRecord | undefined { return this.db.prepare('SELECT * FROM refunds WHERE refund_id=?').get(refundId) as RefundRecord | undefined; }
  getRefundByOrder(orderId: string): RefundRecord | undefined { return this.db.prepare('SELECT * FROM refunds WHERE order_id=?').get(orderId) as RefundRecord | undefined; }
  getRecoverableRefunds(): RefundRecord[] { return this.db.prepare("SELECT * FROM refunds WHERE state IN ('REFUND_PENDING','REFUND_SUBMITTING','REFUND_VERIFYING','REFUND_UNCERTAIN') ORDER BY created_at").all() as RefundRecord[]; }

  getDb(): Database.Database { return this.db; }
  close(): void { this.db.close(); }
}

export function computeEventHash(
  seq: number,
  timestamp: string,
  type: string,
  entityId: string,
  payload: Record<string, unknown>,
  prevHash: string,
  canonicalizationFormat: string = CANONICAL_JSON_FORMAT,
  hashFormat: string = AUDIT_HASH_FORMAT,
): string {
  if (canonicalizationFormat !== CANONICAL_JSON_FORMAT || hashFormat !== AUDIT_HASH_FORMAT) throw new Error('Unsupported audit integrity format');
  const canonical = canonicalJson({ seq, timestamp, type, entityId, payload, prevHash, canonicalizationFormat, hashFormat });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function verifyAuditChain(jsonlPath: string): { valid: boolean; brokenAt?: number; error?: string } {
  if (!existsSync(jsonlPath)) return { valid: true };
  const content = readFileSync(jsonlPath, 'utf-8').trim(); if (!content) return { valid: true };
  let prevHash = '0'.repeat(64); const lines = content.split('\n');
  for (let index = 0; index < lines.length; index++) {
    let event: AuditEvent;
    try { event = JSON.parse(lines[index]!) as AuditEvent; }
    catch { return { valid: false, brokenAt: index + 1, error: `Invalid JSON at seq ${index + 1}` }; }
    if (event.seq !== index + 1) return { valid: false, brokenAt: index + 1, error: `Expected seq ${index + 1}, got ${event.seq}` };
    if (event.prevHash !== prevHash) return { valid: false, brokenAt: event.seq, error: `prevHash mismatch at seq ${event.seq}` };
    try {
      const expected = computeEventHash(event.seq, event.timestamp, event.type, event.entityId, event.payload, event.prevHash, event.canonicalizationFormat, event.hashFormat);
      if (event.hash !== expected) return { valid: false, brokenAt: event.seq, error: `Hash mismatch at seq ${event.seq}` };
    } catch (error) {
      return { valid: false, brokenAt: event.seq, error: error instanceof Error ? error.message : String(error) };
    }
    prevHash = event.hash;
  }
  return { valid: true };
}
