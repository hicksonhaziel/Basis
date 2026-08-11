import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import { Decimal } from 'decimal.js';
import type { PublicClient } from 'viem';
import { registry } from '../../src/adapters/registry.ts';
import type { JobAdapter } from '../../src/adapters/adapter.ts';
import { BasisExecutor } from '../../src/executor/execute.ts';
import { Ledger } from '../../src/ledger/database.ts';
import { generateQuote, type Quote } from '../../src/quoter/quote.ts';
import type { ExecutionStatus, SimulationSuccess } from '../../src/keeperhub/client.ts';
import { KeeperHubError, IdempotencyConflictError, IdempotencyInProgressError } from '../../src/keeperhub/errors.ts';
import { ReconciliationWorker } from '../../src/reconciliation/worker.ts';
import { keeperHubRequest, type PersistedExecutionIntent } from '../../src/executor/intent.ts';

const KEY = 'lifecycle-signing-key-at-least-32-characters';
const TARGET = '0x1111111111111111111111111111111111111111' as const;
const EXECUTOR = '0x2222222222222222222222222222222222222222' as const;
const HASH = `0x${'a'.repeat(64)}` as const;
const OTHER_HASH = `0x${'b'.repeat(64)}` as const;
const cleanups: Array<() => void> = [];
afterEach(() => { preSubmitCalls = 0; while (cleanups.length) cleanups.pop()!(); });

interface LifecycleParams { failPostcondition?: boolean; failPreflight?: boolean; }
let preSubmitCalls = 0;

const adapter: JobAdapter<LifecycleParams> = {
  meta: { jobType: 'test.lifecycle', version: '1.0.0', description: 'Lifecycle fixture', mode: 'permissionless', maxGasEstimate: 100_000n, sendsNativeValue: false, supportedChains: [8453] },
  validateParams(raw) { return raw as LifecycleParams; },
  buildCall(_params, from) { return { to: TARGET, data: '0x1234', value: 0n, from }; },
  buildSimulation() { return { contractAddress: TARGET, functionName: 'execute', functionArgs: '["7"]', abi: '[]' }; },
  canonicalIntent(_params, chainId, bucket) { return { fields: [], canonical: `test.lifecycle|${chainId}|${bucket}` }; },
  async preSubmitPreflight(params) { preSubmitCalls++; if (params.failPreflight) throw new Error('fixture preflight rejected'); },
  verifyPostconditions(params) { return [{ passed: !params.failPostcondition, check: 'fixture postcondition' }]; },
  describe() { return 'fixture'; },
};

before(() => { if (!registry.get(adapter.meta.jobType)) registry.register(adapter); });

function makeLedger(): Ledger {
  const id = `${Date.now()}-${Math.random()}`;
  const db = `/tmp/basis-lifecycle-${id}.sqlite`; const jsonl = `/tmp/basis-lifecycle-${id}.jsonl`;
  const ledger = new Ledger(db, jsonl);
  cleanups.push(() => { ledger.close(); for (const path of [db, `${db}-wal`, `${db}-shm`, jsonl]) if (existsSync(path)) unlinkSync(path); });
  return ledger;
}

function makeQuote(ledger: Ledger, params: LifecycleParams = {}): Quote {
  const now = Date.now();
  const deadline = new Date(now + 300_000);
  const quote = generateQuote({
    jobHash: `${Math.random()}`.padEnd(64, '0').slice(0, 64), jobType: adapter.meta.jobType, chainId: 8453, deadlineTier: '5m', deadlineAt: deadline, expiresAt: new Date(now + 60_000), gasEstimate: 50_000n, nativeAssetUsd: new Decimal('3000'),
    breakdown: { protectedGasPriceWei: 1n, marketExecutionCostUsd: new Decimal('0.01'), riskCostUsd: new Decimal('0'), privateRoutingFeeUsd: new Decimal('0'), marketplaceFeeUsd: new Decimal('0.004285714285714286'), marketplaceFeeBps: 3000, fixedOverheadUsd: new Decimal('0'), targetMarginUsd: new Decimal('0'), rawPriceUsd: new Decimal('0.014285714285714286'), tierRoundingUsd: new Decimal('0.035714285714285714'), payableTierUsd: new Decimal('0.05'), paymentTier: 'basis-order-t2', pricingModelVersion: 'basis-v2' },
    simulation: { success: true, wouldRevert: false, from: EXECUTOR, to: TARGET, gasEstimate: '50000', functionName: 'execute', functionArgs: '["7"]', abi: '[]' },
    intent: { adapterName: adapter.meta.jobType, adapterVersion: adapter.meta.version, chainId: 8453, target: TARGET, functionName: 'execute', functionArgs: '["7"]', abi: '[]', calldata: '0x1234', nativeValueWei: '0', executorAddress: EXECUTOR, deadlineAt: deadline.toISOString(), validatedParams: params },
    oracleEvidence: { source: 'chainlink', observedAt: new Date().toISOString(), feedUpdatedAt: new Date().toISOString() },
    refundRecipient: '0x4444444444444444444444444444444444444444',
  }, KEY);
  ledger.insertQuote({ quoteId: quote.quoteId, jobHash: quote.jobHash, jobType: quote.jobType, chainId: quote.chainId, deadlineTier: quote.deadlineTier, deadlineAt: quote.deadlineAt, expiresAt: quote.expiresAt, priceUsd: quote.priceUsd, paymentTier: quote.paymentTier, pricingModelVersion: quote.pricingModelVersion, breakdown: quote.breakdown as unknown as Record<string, unknown>, simulation: quote.simulation as unknown as Record<string, unknown>, intent: quote.intent as unknown as Record<string, unknown>, oracleEvidence: quote.oracleEvidence as unknown as Record<string, unknown>, canonicalizationFormat: quote.canonicalizationFormat, signatureFormat: quote.signatureFormat, refundRecipient: quote.refundRecipient, signature: quote.signature, issuedAt: quote.issuedAt });
  return quote;
}

function simulation(overrides: Partial<SimulationSuccess> = {}): SimulationSuccess {
  return { success: true, status: 'simulated', from: EXECUTOR, to: TARGET, value: '0', gasEstimate: '50000', simulatedReturnValue: null, wouldRevert: false, ...overrides };
}
function status(overrides: Partial<ExecutionStatus> = {}): ExecutionStatus {
  return { executionId: 'kh_1', status: 'completed', type: 'contract-call', transactionHash: HASH, sponsored: false, receipts: [{ hash: HASH, chainId: 8453, verified: true, receiptStatus: 'success', blockNumber: 10, gasUsed: '50000', verifiedAt: new Date().toISOString() }], createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), ...overrides };
}
function rpc(overrides: Record<string, unknown> = {}): PublicClient {
  return {
    getTransactionReceipt: async () => ({ transactionHash: HASH, status: 'success', blockNumber: 10n, gasUsed: 50_000n, logs: [] }),
    getTransaction: async () => ({ hash: HASH, from: EXECUTOR, to: TARGET, input: '0x1234', value: 0n }),
    ...overrides,
  } as unknown as PublicClient;
}

async function executeScenario(options: { sim?: () => Promise<SimulationSuccess>; send?: () => Promise<any>; poll?: () => Promise<ExecutionStatus>; rpc?: PublicClient; params?: LifecycleParams } = {}) {
  const ledger = makeLedger(); const quote = makeQuote(ledger, options.params);
  let sends = 0;
  const keeper = {
    simulate: options.sim ?? (async () => simulation()),
    executeContractCall: async () => { sends++; return options.send ? options.send() : { executionId: 'kh_1', status: 'pending' }; },
    pollUntilComplete: options.poll ?? (async () => status()),
  };
  const executor = new BasisExecutor({ keeperHubClient: keeper as never, ledger, signingKey: KEY, rpcUrls: { 8453: 'test' }, rpcClientFactory: () => options.rpc ?? rpc() });
  const result = await executor.executeOrder(quote, `ord_${Math.random()}`, 'MARKETPLACE_PAYMENT_AUTHORIZED', quote.paymentTier);
  return { result, ledger, quote, sends: () => sends };
}

describe('production quote oracle policy', () => {
  it('fails closed on Chainlink RPC failure even if fallback values are configured', async () => {
    const ledger = makeLedger();
    const keeper = { getOrgWalletAddress: async () => EXECUTOR, simulate: async () => simulation() };
    const failingRpc = {
      chain: { id: 8453 },
      getFeeHistory: async () => ({ oldestBlock: 1n, baseFeePerGas: [1n, 1n], reward: [[1n, 1n, 1n, 1n, 1n]] }),
      readContract: async () => { throw new Error('oracle RPC unavailable'); },
    } as unknown as PublicClient;
    const executor = new BasisExecutor({
      keeperHubClient: keeper as never, ledger, signingKey: KEY, rpcUrls: { 8453: 'test' }, rpcClientFactory: () => failingRpc,
      environment: 'production', oracleReference: { priceUsd: '2500', updatedAt: Math.floor(Date.now() / 1000) },
      allowTestFxFallback: true, testFxFallbackUsd: '3100',
    });
    await assert.rejects(executor.requestQuote({ jobType: adapter.meta.jobType, params: {}, chainId: 8453, deadlineTier: '5m', refundRecipient: '0x4444444444444444444444444444444444444444' }), /oracle RPC unavailable/);
  });
});

describe('deterministic execution lifecycle', () => {
  it('successfully re-simulates, executes, independently verifies, and succeeds', async () => {
    const { result, ledger } = await executeScenario();
    assert.equal(result.status, 'SUCCEEDED');
    const order = ledger.getDb().prepare('SELECT state,authority_kind FROM orders').get() as any;
    assert.deepEqual(order, { state: 'SUCCEEDED', authority_kind: 'MARKETPLACE_PAYMENT_AUTHORIZED' });
    assert.equal((ledger.getDb().prepare('SELECT COUNT(*) AS count FROM receipts WHERE keeperhub_verified=1 AND independent_verified=1').get() as any).count, 1);
  });
  it('re-simulation failure goes to REFUND_PENDING without submission', async () => {
    const { result, sends } = await executeScenario({ sim: async () => { throw new Error('reverted'); } });
    assert.equal(result.status, 'REFUND_PENDING'); assert.equal(sends(), 0); assert.equal(preSubmitCalls, 0);
  });
  it('runs pre-submit preflight after re-simulation and before submission', async () => {
    const { result, sends } = await executeScenario({ params: { failPreflight: true } });
    assert.equal(result.status, 'REFUND_PENDING'); assert.match(result.error!, /fixture preflight rejected/);
    assert.equal(preSubmitCalls, 1); assert.equal(sends(), 0);
  });
  it('rejects re-simulation target mismatch', async () => {
    const { result, sends } = await executeScenario({ sim: async () => simulation({ to: OTHER_HASH.slice(0, 42) as `0x${string}` }) });
    assert.equal(result.status, 'REFUND_PENDING'); assert.match(result.error!, /target mismatch/); assert.equal(sends(), 0);
  });
  it('rejects re-simulation value mismatch', async () => {

    const { result, sends } = await executeScenario({ sim: async () => simulation({ value: '1' }) });
    assert.equal(result.status, 'REFUND_PENDING'); assert.match(result.error!, /value mismatch/); assert.equal(sends(), 0);
  });
  it('accepts gas at the adapter cap and rejects gas above it before submission', async () => {
    const atCap = await executeScenario({ sim: async () => simulation({ gasEstimate: '100000' }) });
    assert.equal(atCap.result.status, 'SUCCEEDED'); assert.equal(atCap.sends(), 1);
    const aboveCap = await executeScenario({ sim: async () => simulation({ gasEstimate: '100001' }) });
    assert.equal(aboveCap.result.status, 'REFUND_PENDING'); assert.match(aboveCap.result.error!, /exceeds adapter max/); assert.equal(aboveCap.sends(), 0);
  });

  const verificationCases: Array<[string, Partial<ExecutionStatus>, PublicClient | undefined, LifecycleParams | undefined, RegExp]> = [
    ['no receipts', { receipts: [] }, undefined, undefined, /no applicable receipts/],
    ['unverified receipt', { receipts: [{ ...status().receipts[0]!, verified: false }] }, undefined, undefined, /not verified/],
    ['failed receipt', { receipts: [{ ...status().receipts[0]!, receiptStatus: 'reverted' }] }, undefined, undefined, /not successful/],
    ['independent status zero', {}, rpc({ getTransactionReceipt: async () => ({ transactionHash: HASH, status: 'reverted', blockNumber: 10n, gasUsed: 1n, logs: [] }) }), undefined, /Independent RPC receipt status/],
    ['RPC hash disagreement', {}, rpc({ getTransactionReceipt: async () => ({ transactionHash: OTHER_HASH, status: 'success', blockNumber: 10n, gasUsed: 1n, logs: [] }) }), undefined, /hash disagreement/],
    ['postcondition failure', {}, undefined, { failPostcondition: true }, /postcondition/],
    ['executor mismatch', {}, rpc({ getTransaction: async () => ({ hash: HASH, from: '0x3333333333333333333333333333333333333333', to: TARGET, input: '0x1234', value: 0n }) }), undefined, /executor mismatch/],
  ];
  for (const [name, statusOverrides, rpcClient, params, error] of verificationCases) {
    it(`fails closed for ${name}`, async () => {
      const output = await executeScenario({ poll: async () => status(statusOverrides), rpc: rpcClient, params });
      assert.equal(output.result.status, 'REFUND_PENDING'); assert.match(output.result.error!, error);
    });
  }
  it('missing independent RPC transaction becomes UNCERTAIN', async () => {
    const output = await executeScenario({ rpc: rpc({ getTransactionReceipt: async () => { throw new Error('not found'); } }) });
    assert.equal(output.result.status, 'UNCERTAIN');
  });
  it('accepts KeeperHub-sponsored smart-account outer routing when independent receipt and adapter postconditions pass', async () => {
    const routed = rpc({ getTransaction: async () => ({ hash: HASH, from: '0x3333333333333333333333333333333333333333', to: '0x5555555555555555555555555555555555555555', input: '0x9999', value: 0n }) });
    const output = await executeScenario({ poll: async () => status({ sponsored: true }), rpc: routed });
    assert.equal(output.result.status, 'SUCCEEDED');
  });
  it('timeout transitions to UNCERTAIN and reconciliation never rebroadcasts it', async () => {
    const output = await executeScenario({ poll: async () => { throw new KeeperHubError('timeout', 0, {}); } });
    assert.equal(output.result.status, 'UNCERTAIN'); assert.equal(output.sends(), 1);
    let reconcileSends = 0;
    const worker = new ReconciliationWorker(output.ledger, { executeContractCall: async () => { reconcileSends++; throw new Error('must not send'); }, getExecutionStatus: async () => ({ status: status({ status: 'running' }), pollIntervalHint: 1 }) } as never, () => rpc());
    await worker.runOnce(); assert.equal(reconcileSends, 0);
  });
  it('handles idempotentReplay explicitly', async () => {
    const output = await executeScenario({ send: async () => ({ executionId: 'kh_1', status: 'pending', idempotentReplay: true }) });
    assert.equal(output.result.status, 'SUCCEEDED');
    assert.equal(output.ledger.getExecution(output.result.executionId)!.idempotent_replay, 1);
  });
  it('polls original execution on idempotency_in_progress', async () => {
    const output = await executeScenario({ send: async () => { throw new IdempotencyInProgressError('kh_original', {}); } });
    assert.equal(output.result.keeperhubExecutionId, 'kh_original'); assert.equal(output.result.status, 'SUCCEEDED');
  });
  it('fails closed on idempotency_conflict', async () => {
    const output = await executeScenario({ send: async () => { throw new IdempotencyConflictError('kh_other', {}); } });
    assert.equal(output.result.status, 'REFUND_PENDING'); assert.match(output.result.error!, /conflict/i);
  });
});

describe('atomicity and restart reconciliation', () => {
  it('concurrent attempts cannot consume one quote twice', () => {
    const ledger = makeLedger(); const quote = makeQuote(ledger); const base = { quoteId: quote.quoteId, authorityKind: 'AUTHENTICATED_PRIVATE_WORKFLOW' as const, callbackAuthKind: 'AUTHENTICATED_WORKFLOW_CALLBACK' as const, settlementMetadataStatus: 'NOT_APPLICABLE' as const, refundRecipient: quote.refundRecipient, paymentAmountUsd: quote.priceUsd, idempotencyKey: quote.jobHash, chainId: 8453 };
    const intent1: PersistedExecutionIntent = { ...quote.intent, quoteId: quote.quoteId, orderId: 'o1', idempotencyKey: quote.jobHash };
    ledger.admitOrder({ ...base, orderId: 'o1', executionId: 'e1', intent: intent1, outboundRequest: keeperHubRequest(intent1) });
    const intent2 = { ...intent1, orderId: 'o2' };
    assert.throws(() => ledger.admitOrder({ ...base, orderId: 'o2', executionId: 'e2', intent: intent2, outboundRequest: keeperHubRequest(intent2) }), /already been consumed/);
    assert.equal((ledger.getDb().prepare('SELECT COUNT(*) AS count FROM orders').get() as any).count, 1);
  });

  it('recovers a crash immediately after atomic admission', async () => {
    const ledger = makeLedger(); const quote = makeQuote(ledger); const intent: PersistedExecutionIntent = { ...quote.intent, quoteId: quote.quoteId, orderId: 'o_admitted', idempotencyKey: quote.jobHash };
    ledger.admitOrder({ quoteId: quote.quoteId, orderId: 'o_admitted', executionId: 'e_admitted', authorityKind: 'AUTHENTICATED_PRIVATE_WORKFLOW', callbackAuthKind: 'AUTHENTICATED_WORKFLOW_CALLBACK', settlementMetadataStatus: 'NOT_APPLICABLE', refundRecipient: quote.refundRecipient, paymentAmountUsd: quote.priceUsd, idempotencyKey: quote.jobHash, chainId: 8453, intent, outboundRequest: keeperHubRequest(intent) });
    let simulations = 0; let sends = 0;
    const worker = new ReconciliationWorker(ledger, {
      simulate: async () => { simulations++; return simulation(); },
      executeContractCall: async () => { sends++; return { executionId: 'kh_admitted', status: 'pending' }; },
      getExecutionStatus: async () => ({ status: status({ executionId: 'kh_admitted' }), pollIntervalHint: 0 }),
    } as never, () => rpc());
    await worker.runOnce(true);
    assert.equal(simulations, 1); assert.equal(sends, 1); assert.equal(preSubmitCalls, 0);
    assert.equal((ledger.getDb().prepare("SELECT state FROM orders WHERE order_id='o_admitted'").get() as any).state, 'SUCCEEDED');
  });

  it('periodic reconciliation does not race active foreground EXECUTING work', async () => {
    const ledger = makeLedger(); const quote = makeQuote(ledger); const intent: PersistedExecutionIntent = { ...quote.intent, quoteId: quote.quoteId, orderId: 'o_live', idempotencyKey: quote.jobHash };
    ledger.admitOrder({ quoteId: quote.quoteId, orderId: 'o_live', executionId: 'e_live', authorityKind: 'AUTHENTICATED_PRIVATE_WORKFLOW', callbackAuthKind: 'AUTHENTICATED_WORKFLOW_CALLBACK', settlementMetadataStatus: 'NOT_APPLICABLE', refundRecipient: quote.refundRecipient, paymentAmountUsd: quote.priceUsd, idempotencyKey: quote.jobHash, chainId: 8453, intent, outboundRequest: keeperHubRequest(intent) });
    ledger.transitionOrder('o_live', 'RESIMULATING', 'fixture'); ledger.transitionOrder('o_live', 'EXECUTING', 'foreground owns execution');
    let statusReads = 0;
    const worker = new ReconciliationWorker(ledger, { getExecutionStatus: async () => { statusReads++; return { status: status(), pollIntervalHint: 0 }; } } as never, () => rpc());
    await worker.runOnce(false);
    assert.equal(statusReads, 0); assert.equal((ledger.getDb().prepare("SELECT state FROM orders WHERE order_id='o_live'").get() as any).state, 'EXECUTING');
  });

  it('recovers a crash after submission through the exact persisted idempotent request', async () => {
    const ledger = makeLedger(); const quote = makeQuote(ledger); const intent: PersistedExecutionIntent = { ...quote.intent, quoteId: quote.quoteId, orderId: 'o_crash', idempotencyKey: quote.jobHash };
    ledger.admitOrder({ quoteId: quote.quoteId, orderId: 'o_crash', executionId: 'e_crash', authorityKind: 'AUTHENTICATED_PRIVATE_WORKFLOW', callbackAuthKind: 'AUTHENTICATED_WORKFLOW_CALLBACK', settlementMetadataStatus: 'NOT_APPLICABLE', refundRecipient: quote.refundRecipient, paymentAmountUsd: quote.priceUsd, idempotencyKey: quote.jobHash, chainId: 8453, intent, outboundRequest: keeperHubRequest(intent) });
    ledger.transitionOrder('o_crash', 'RESIMULATING', 'fixture'); ledger.transitionOrder('o_crash', 'EXECUTING', 'request was sent before process crash');
    let sends = 0;
    const worker = new ReconciliationWorker(ledger, { executeContractCall: async () => { sends++; return { executionId: 'kh_recovered', status: 'completed', idempotentReplay: true }; }, getExecutionStatus: async () => ({ status: status({ executionId: 'kh_recovered' }), pollIntervalHint: 0 }) } as never, () => rpc());
    await worker.runOnce();
    assert.equal(sends, 1); assert.equal((ledger.getDb().prepare("SELECT state FROM orders WHERE order_id='o_crash'").get() as any).state, 'SUCCEEDED');
  });
  it('reconciles UNCERTAIN to SUCCEEDED using the original execution ID only', async () => {
    const output = await executeScenario({ poll: async () => { throw new KeeperHubError('timeout', 0, {}); } }); let sends = 0;
    const worker = new ReconciliationWorker(output.ledger, { executeContractCall: async () => { sends++; throw new Error('no'); }, getExecutionStatus: async () => ({ status: status(), pollIntervalHint: 0 }) } as never, () => rpc());
    await worker.runOnce(); assert.equal(sends, 0); assert.equal((output.ledger.getDb().prepare('SELECT state FROM orders').get() as any).state, 'SUCCEEDED');
  });
  it('reconciles UNCERTAIN through FAILED to REFUND_PENDING', async () => {
    const output = await executeScenario({ poll: async () => { throw new KeeperHubError('timeout', 0, {}); } });
    const worker = new ReconciliationWorker(output.ledger, { getExecutionStatus: async () => ({ status: status({ status: 'failed', error: 'reverted' }), pollIntervalHint: 0 }) } as never, () => rpc());
    await worker.runOnce();
    const transitions = output.ledger.getDb().prepare('SELECT to_state FROM order_transitions ORDER BY id').all() as Array<{to_state:string}>;
    assert.ok(transitions.some((item) => item.to_state === 'FAILED')); assert.equal(transitions.at(-1)!.to_state, 'REFUND_PENDING');
  });
});
