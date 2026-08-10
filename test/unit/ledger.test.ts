import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Ledger, verifyAuditChain, computeEventHash } from '../../src/ledger/database.ts';
import { verifyAuditEvents } from '../../dashboard/audit-chain.mjs';

let ledger: Ledger;
let dbPath: string;
let jsonlPath: string;
let testId: number = 0;

function getTempPaths() {
  testId++;
  const ts = Date.now();
  return {
    db: `/tmp/basis-test-${ts}-${testId}.sqlite`,
    jsonl: `/tmp/basis-test-${ts}-${testId}.jsonl`,
  };
}

function cleanup(paths: { db: string; jsonl: string }) {
  for (const p of [paths.db, paths.db + '-wal', paths.db + '-shm', paths.jsonl]) {
    if (existsSync(p)) unlinkSync(p);
  }
}

describe('ledger/database', () => {
  beforeEach(() => {
    const paths = getTempPaths();
    dbPath = paths.db;
    jsonlPath = paths.jsonl;
    ledger = new Ledger(dbPath, jsonlPath);
  });

  afterEach(() => {
    ledger.close();
    cleanup({ db: dbPath, jsonl: jsonlPath });
  });

  it('event appending increments sequence numbers', () => {
    const e1 = ledger.appendEvent('QUOTE_ISSUED', 'q_1', { price: '0.05' });
    const e2 = ledger.appendEvent('ORDER_CREATED', 'o_1', { quoteId: 'q_1' });
    const e3 = ledger.appendEvent('EXECUTION_STARTED', 'x_1', { orderId: 'o_1' });

    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);
    assert.equal(e3.seq, 3);
    assert.equal(ledger.getEventCount(), 3);
  });

  it('hash chain links correctly (prevHash == previous hash)', () => {
    const e1 = ledger.appendEvent('QUOTE_ISSUED', 'q_1', { price: '0.05' });
    const e2 = ledger.appendEvent('ORDER_CREATED', 'o_1', { quoteId: 'q_1' });
    const e3 = ledger.appendEvent('EXECUTION_STARTED', 'x_1', { orderId: 'o_1' });

    // First event prevHash is all zeros
    assert.equal(e1.prevHash, '0'.repeat(64));
    // Second links to first
    assert.equal(e2.prevHash, e1.hash);
    // Third links to second
    assert.equal(e3.prevHash, e2.hash);
    // Last hash matches last event
    assert.equal(ledger.getLastHash(), e3.hash);
  });

  it('verifyAuditChain passes for valid chain', () => {
    ledger.appendEvent('QUOTE_ISSUED', 'q_1', { price: '0.05' });
    ledger.appendEvent('ORDER_CREATED', 'o_1', { quoteId: 'q_1' });
    ledger.appendEvent('EXECUTION_VERIFIED', 'x_1', { txHash: '0xabc' });

    const result = verifyAuditChain(jsonlPath);
    assert.equal(result.valid, true);
    assert.equal(result.brokenAt, undefined);
  });

  it('rejects nested payload tampering that the legacy serializer failed to bind', () => {
    ledger.appendEvent('QUOTE_ISSUED', 'q_1', { quote: { pricing: { marketplaceFeeBps: 3000 } } });
    ledger.appendEvent('ORDER_CREATED', 'o_1', { quoteId: 'q_1' });

    const content = readFileSync(jsonlPath, 'utf-8');
    const lines = content.trim().split('\n');
    const event = JSON.parse(lines[0]!);
    const legacy = (value: unknown) => JSON.stringify(value, ['entityId','payload','prevHash','seq','timestamp','type']);
    const before = legacy({ seq: event.seq, timestamp: event.timestamp, type: event.type, entityId: event.entityId, payload: event.payload, prevHash: event.prevHash });
    event.payload.quote.pricing.marketplaceFeeBps = 0;
    const after = legacy({ seq: event.seq, timestamp: event.timestamp, type: event.type, entityId: event.entityId, payload: event.payload, prevHash: event.prevHash });
    assert.equal(before, after, 'legacy replacer omitted nested payload keys');
    lines[0] = JSON.stringify(event);
    writeFileSync(jsonlPath, lines.join('\n') + '\n');

    const result = verifyAuditChain(jsonlPath);
    assert.equal(result.valid, false);
    assert.equal(result.brokenAt, 1);
    assert.match(result.error!, /Hash mismatch/);
  });

  it('rejects an audit sequence gap', () => {
    ledger.appendEvent('QUOTE_ISSUED', 'q_1', { nested: { value: 1 } });
    ledger.appendEvent('ORDER_CREATED', 'o_1', { quoteId: 'q_1' });
    const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n');
    const second = JSON.parse(lines[1]!);
    second.seq = 3;
    lines[1] = JSON.stringify(second);
    writeFileSync(jsonlPath, lines.join('\n') + '\n');
    const result = verifyAuditChain(jsonlPath);
    assert.equal(result.valid, false);
    assert.equal(result.brokenAt, 2);
    assert.match(result.error!, /Expected seq 2/);
  });

  it('allocates collision-free linked sequences across concurrent ledger writers', () => {
    const second = new Ledger(dbPath, jsonlPath);
    try {
      const firstEvent = ledger.appendEvent('QUOTE_ISSUED', 'q_1', { writer: 1 });
      const secondEvent = second.appendEvent('ORDER_CREATED', 'o_1', { writer: 2 });
      const thirdEvent = ledger.appendEvent('EXECUTION_STARTED', 'x_1', { writer: 1 });
      assert.deepEqual([firstEvent.seq, secondEvent.seq, thirdEvent.seq], [1, 2, 3]);
      assert.equal(secondEvent.prevHash, firstEvent.hash);
      assert.equal(thirdEvent.prevHash, secondEvent.hash);
      assert.equal(verifyAuditChain(jsonlPath).valid, true);
    } finally { second.close(); }
  });

  it('browser verifier recomputes the same hashes and rejects nested tampering', async () => {
    ledger.appendEvent('QUOTE_ISSUED', 'q_1', { nested: { price: '0.05' } });
    const events = readFileSync(jsonlPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(await verifyAuditEvents(events), { valid: true });
    events[0].payload.nested.price = '999';
    const result = await verifyAuditEvents(events);
    assert.equal(result.valid, false);
    assert.equal(result.brokenAt, 1);
    assert.match(result.error!, /hash mismatch/);
  });

  it('quote consumed flag works', () => {
    // Insert a quote first
    ledger.insertQuote({
      quoteId: 'q_test1',
      jobHash: 'a'.repeat(64),
      jobType: 'erc20.transfer',
      chainId: 8453,
      deadlineTier: '5m',
      deadlineAt: '2026-08-08T12:05:00.000Z',
      expiresAt: '2026-08-08T12:00:30.000Z',
      priceUsd: '0.05',
      paymentTier: 'basis-order-t2',
      pricingModelVersion: 'basis-v1',
      breakdown: { gasEstimate: '200000' },
      simulation: { success: true },
      signature: 'sig123',
      refundRecipient: '0x4444444444444444444444444444444444444444',
      issuedAt: '2026-08-08T12:00:00.000Z',

    });

    assert.equal(ledger.isQuoteConsumed('q_test1'), false);
    ledger.markQuoteConsumed('q_test1');
    assert.equal(ledger.isQuoteConsumed('q_test1'), true);
  });

  it('order insert and state update works', () => {
    // Need a quote first for foreign key
    ledger.insertQuote({
      quoteId: 'q_order_test',
      jobHash: 'b'.repeat(64),
      jobType: 'erc20.transfer',
      chainId: 8453,
      deadlineTier: '5m',
      deadlineAt: '2026-08-08T12:05:00.000Z',
      expiresAt: '2026-08-08T12:00:30.000Z',
      priceUsd: '0.05',
      paymentTier: 'basis-order-t2',
      pricingModelVersion: 'basis-v1',
      breakdown: {},
      simulation: {},
      signature: 'sig456',
      refundRecipient: '0x4444444444444444444444444444444444444444',
      issuedAt: '2026-08-08T12:00:00.000Z',
    });

    ledger.insertOrder({
      orderId: 'o_test1',
      quoteId: 'q_order_test',
      state: 'PAID',
      paymentTxHash: '0xdeadbeef',
      paymentAmountUsd: '0.05',
    });

    // Verify order exists and has initial state
    const db = ledger.getDb();
    const row = db.prepare('SELECT state FROM orders WHERE order_id = ?').get('o_test1') as { state: string };
    assert.equal(row.state, 'PAID');

    // Update state
    ledger.updateOrderState('o_test1', 'RESIMULATING');
    const updated = db.prepare('SELECT state FROM orders WHERE order_id = ?').get('o_test1') as { state: string };
    assert.equal(updated.state, 'RESIMULATING');
  });

  it('multiple events maintain chain integrity', () => {
    // Append many events
    for (let i = 0; i < 10; i++) {
      ledger.appendEvent('FEE_SAMPLE_COLLECTED', `chain_8453_block_${i}`, {
        baseFee: String(30_000_000_000 + i * 1_000_000_000),
        blockNumber: i,
      });
    }

    assert.equal(ledger.getEventCount(), 10);

    // Verify full chain
    const result = verifyAuditChain(jsonlPath);
    assert.equal(result.valid, true);
  });
});
