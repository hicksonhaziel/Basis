import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import { Decimal } from 'decimal.js';
import { encodeAbiParameters, encodeEventTopics, parseAbiItem, type Hex } from 'viem';
import { Ledger } from '../../src/ledger/database.ts';
import { generateQuote } from '../../src/quoter/quote.ts';
import { RefundEngine, verifyRefund, type RefundRpc } from '../../src/executor/refund.ts';
import { REFUND_CHAIN_ID, REFUND_POLICY_ID, REFUND_TIER_TERMS, REFUND_TOKEN_ADDRESS, refundTermsForTier, hasContractualDeadline } from '../../src/config/policy.ts';
import { deriveRefundIdempotencyKey } from '../../src/executor/idempotency.ts';
import { IdempotencyConflictError } from '../../src/keeperhub/errors.ts';

const KEY = 'phase-five-refund-signing-key-000000000000';
const SENDER = '0x2222222222222222222222222222222222222222' as const;
const RECIPIENT = '0x4444444444444444444444444444444444444444' as const;
const HASH = `0x${'a'.repeat(64)}` as Hex;
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function ledger(): Ledger {
  const suffix = `${Date.now()}-${Math.random()}`; const db = `/tmp/basis-refund-${suffix}.sqlite`; const jsonl = `/tmp/basis-refund-${suffix}.jsonl`;
  const value = new Ledger(db, jsonl); cleanups.push(() => { value.close(); for (const p of [db, `${db}-wal`, `${db}-shm`, jsonl]) if (existsSync(p)) unlinkSync(p); }); return value;
}

function obligation(tier: keyof typeof REFUND_TIER_TERMS = 'basis-order-t3') {
  const l = ledger(); const terms = refundTermsForTier(tier); const now = Date.now();
  const quote = generateQuote({
    jobHash: tier.padEnd(64, '0'), jobType: 'fixture', chainId: 8453, deadlineTier: '5m', deadlineAt: new Date(now + 300_000), expiresAt: new Date(now + 60_000), gasEstimate: 1n, nativeAssetUsd: new Decimal('1'),
    breakdown: { protectedGasPriceWei: 1n, marketExecutionCostUsd: new Decimal(0), riskCostUsd: new Decimal(0), privateRoutingFeeUsd: new Decimal(0), marketplaceFeeUsd: new Decimal(terms.grossRefundAmountUsd).mul('.3'), marketplaceFeeBps: 3000, fixedOverheadUsd: new Decimal(0), targetMarginUsd: new Decimal(0), rawPriceUsd: new Decimal(terms.grossRefundAmountUsd), tierRoundingUsd: new Decimal(0), payableTierUsd: new Decimal(terms.grossRefundAmountUsd), paymentTier: tier, pricingModelVersion: 'basis-v2' },
    simulation: { success: true, wouldRevert: false, from: SENDER, to: SENDER, gasEstimate: '1' },
    intent: { adapterName: 'fixture', adapterVersion: '1', chainId: 8453, target: SENDER, functionName: 'x', abi: '[]', calldata: '0x', nativeValueWei: '0', executorAddress: SENDER, deadlineAt: new Date(now + 300_000).toISOString(), validatedParams: {} },
    oracleEvidence: { source: 'chainlink', observedAt: new Date().toISOString(), feedUpdatedAt: new Date().toISOString() }, refundRecipient: RECIPIENT,
  }, KEY);
  l.insertQuote({ ...quote, breakdown: quote.breakdown as unknown as Record<string, unknown>, simulation: quote.simulation as unknown as Record<string, unknown>, intent: quote.intent as unknown as Record<string, unknown>, oracleEvidence: quote.oracleEvidence as unknown as Record<string, unknown> });
  const orderId = `order-${tier}`; const executionId = `exec-${tier}`;
  l.admitOrder({ quoteId: quote.quoteId, orderId, executionId, authorityKind: 'MARKETPLACE_PAYMENT_AUTHORIZED', callbackAuthKind: 'AUTHENTICATED_WORKFLOW_CALLBACK', marketplaceTier: tier, settlementMetadataStatus: 'NOT_EXPOSED_TO_WORKFLOW', refundRecipient: quote.refundRecipient, paymentAmountUsd: quote.priceUsd, idempotencyKey: quote.jobHash, chainId: 8453, intent: { ...quote.intent, quoteId: quote.quoteId, orderId, idempotencyKey: quote.jobHash }, outboundRequest: { contractAddress: SENDER, chainId: 8453, functionName: 'x' } });
  l.transitionOrder(orderId, 'RESIMULATING', 'fixture');
  return { l, quote, refund: l.markRefundEligible(orderId, 'RESIMULATION_FAILED', 'definitive pre-broadcast failure') };
}

function status() { return { executionId: 'kh-refund', status: 'completed' as const, type: 'contract-call', transactionHash: HASH, sponsored: true, receipts: [{ hash: HASH, chainId: 8453, verified: true, receiptStatus: 'success' as const, blockNumber: 10, gasUsed: '21000', verifiedAt: new Date().toISOString() }], createdAt: new Date().toISOString() }; }
function transferLog(from: Hex = SENDER, to: Hex = RECIPIENT, value = 250_000n, token: Hex = REFUND_TOKEN_ADDRESS) {
  const abi = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
  return { address: token, topics: encodeEventTopics({ abi: [abi], eventName: 'Transfer', args: { from, to } }) as readonly Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [value]) };
}
function rpc(log = transferLog()): RefundRpc { return { getTransactionReceipt: async () => ({ transactionHash: HASH, status: 'success' as const, blockNumber: 10n, gasUsed: 21_000n, logs: [log] }), getTransaction: async () => ({ hash: HASH, from: SENDER, to: REFUND_TOKEN_ADDRESS as Hex, input: '0x' as Hex, value: 0n }), getBlockNumber: async () => 12n }; }

const simulation = { success: true as const, status: 'simulated' as const, from: SENDER, to: REFUND_TOKEN_ADDRESS, value: '0', gasEstimate: '50000', simulatedReturnValue: true, wouldRevert: false as const };

describe('Phase 5 fixed refund policy', () => {
  it('derives exact six-decimal gross amounts and signs every immutable term', () => {
    const expected = [10_000n, 50_000n, 250_000n, 1_000_000n];
    Object.keys(REFUND_TIER_TERMS).forEach((tier, i) => assert.equal(BigInt(refundTermsForTier(tier).refundAmountAtomic), expected[i]));
    const { quote } = obligation('basis-order-t1');
    assert.equal(quote.refundPolicyId, REFUND_POLICY_ID); assert.equal(quote.refundChainId, REFUND_CHAIN_ID); assert.equal(quote.refundTokenAddress, REFUND_TOKEN_ADDRESS); assert.equal(quote.grossRefundAmountUsd, '0.01');
  });
  it('uses all stable obligation fields and never a payment transaction hash', () => {
    const base = { refundPolicyId: REFUND_POLICY_ID, orderId: 'o1', quoteId: 'q1', chainId: 8453, tokenAddress: REFUND_TOKEN_ADDRESS, refundRecipient: RECIPIENT, atomicAmount: '10000' };
    assert.equal(deriveRefundIdempotencyKey(base), deriveRefundIdempotencyKey(base));
    assert.notEqual(deriveRefundIdempotencyKey(base), deriveRefundIdempotencyKey({ ...base, orderId: 'o2' }));
  });
  it('atomically creates one obligation with honest economics and exact persisted request', () => {
    const { l, refund } = obligation();
    const again = l.markRefundEligible(refund.order_id, 'OTHER', 'duplicate worker');
    assert.equal(again.refund_id, refund.refund_id); assert.equal((l.getDb().prepare('SELECT COUNT(*) n FROM refunds').get() as any).n, 1);
    assert.equal(refund.gross_payment_usd, '0.25'); assert.equal(refund.marketplace_fee_usd, '0.075'); assert.equal(refund.basis_net_revenue_usd, '0.175'); assert.equal(refund.realized_pnl_usd, '-0.075');
    const request = JSON.parse(refund.outbound_request_json); assert.equal(request.contractAddress, REFUND_TOKEN_ADDRESS); assert.deepEqual(JSON.parse(request.functionArgs), [RECIPIENT, '250000']);
  });
});
  it('gives timing guarantees to deadline-backed tiers but not best-effort', () => {
    assert.equal(hasContractualDeadline('next-block'), true); assert.equal(hasContractualDeadline('5m'), true); assert.equal(hasContractualDeadline('1h'), true); assert.equal(hasContractualDeadline('best-effort'), false);
  });

describe('refund submission and reconciliation', () => {
  it('defaults disabled and leaves eligible work durably pending without any call', async () => {
    const { l, refund } = obligation(); let calls = 0;
    await new RefundEngine(l, { simulate: async () => { calls++; return simulation; } } as never, rpc(), { enabled: false }).reconcile(refund);
    assert.equal(calls, 0); assert.equal(l.getRefund(refund.refund_id)!.state, 'REFUND_PENDING');
  });
  it('persists the record before simulation and prevents broadcast on simulation failure', async () => {
    const { l, refund } = obligation(); let sends = 0;
    const keeper = { simulate: async () => { assert.ok(l.getRefund(refund.refund_id)); throw new Error('insufficient USDC'); }, executeContractCall: async () => { sends++; throw new Error('no'); } };
    await new RefundEngine(l, keeper as never, rpc(), { enabled: true, confirmedWallet: SENDER }).reconcile(refund);
    assert.equal(sends, 0); assert.equal(l.getRefund(refund.refund_id)!.state, 'REFUND_FAILED');
  });
  it('submits once, persists execution ID, and marks REFUNDED only after exact proof', async () => {
    const { l, refund } = obligation(); let sends = 0;
    const keeper = { simulate: async () => simulation, executeContractCall: async () => { sends++; return { executionId: 'kh-refund', status: 'pending' }; }, getExecutionStatus: async () => ({ status: status(), pollIntervalHint: 0 }) };
    await new RefundEngine(l, keeper as never, rpc(), { enabled: true, confirmedWallet: SENDER }).reconcile(refund);
    const final = l.getRefund(refund.refund_id)!; assert.equal(sends, 1); assert.equal(final.state, 'REFUNDED'); assert.equal(final.transaction_hash, HASH); assert.ok(final.decoded_transfer_json);
    await new RefundEngine(l, keeper as never, rpc(), { enabled: true, confirmedWallet: SENDER }).reconcileAll(); assert.equal(sends, 1);
  });
  it('fails closed on idempotency conflict and makes ambiguous submission uncertain without retry', async () => {
    for (const conflict of [true, false]) {
      const { l, refund } = obligation(conflict ? 'basis-order-t1' : 'basis-order-t2');
      const keeper = { simulate: async () => simulation, executeContractCall: async () => { if (conflict) throw new IdempotencyConflictError('other', {}); throw new Error('timeout'); } };
      await new RefundEngine(l, keeper as never, rpc(), { enabled: true, confirmedWallet: SENDER }).reconcile(refund);
      assert.equal(l.getRefund(refund.refund_id)!.state, conflict ? 'REFUND_FAILED' : 'REFUND_UNCERTAIN');
    }
  });
});

describe('independent exact Transfer verification', () => {
  it('rejects missing/unverified KeeperHub proof, missing RPC, and wrong token/sender/recipient/amount', async () => {
    const { refund } = obligation();
    const cases: Array<[any, any]> = [
      [{ ...status(), receipts: [] }, rpc()],
      [{ ...status(), receipts: [{ ...status().receipts[0], verified: false }] }, rpc()],
      [status(), { ...rpc(), getTransactionReceipt: async () => { throw new Error('not found'); } }],
      [status(), rpc(transferLog(SENDER, RECIPIENT, 250_000n, '0x3333333333333333333333333333333333333333'))],
      [status(), rpc(transferLog('0x3333333333333333333333333333333333333333', RECIPIENT))],
      [status(), rpc(transferLog(SENDER, '0x3333333333333333333333333333333333333333'))],
      [status(), rpc(transferLog(SENDER, RECIPIENT, 250_001n))],
    ];
    for (const [s, r] of cases) await assert.rejects(verifyRefund(s, refund, r));
  });
  it('accepts exactly one canonical confirmed Transfer from the simulation-resolved sender', async () => {
    const { refund } = obligation(); const proof = await verifyRefund(status(), refund, rpc());
    assert.equal(proof.transfer.from, SENDER); assert.equal(proof.transfer.to, RECIPIENT); assert.equal(proof.transfer.value, '250000');
  });
});
