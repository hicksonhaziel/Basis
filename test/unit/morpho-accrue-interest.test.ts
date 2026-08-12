import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, keccak256 } from 'viem';
import {
  MIN_ACCRUAL_STALENESS_SECONDS, MORPHO_ACCRUE_INTEREST_ABI, MORPHO_ACCRUE_INTEREST_TOPIC,
  MORPHO_ADDRESS, MORPHO_CHAIN_ID, MORPHO_IRM_ADDRESS, MORPHO_IRM_RUNTIME_CODE_HASH,
  MORPHO_MARKET_ID, MORPHO_MARKET_PARAMS, MORPHO_RUNTIME_CODE_HASH, MORPHO_SELECTOR,
  deriveMorphoMarketId, evaluateMorphoAccrualEvent, morphoAccrueInterestAdapter,
  runtimeCodeHashMatches, validateMorphoPreflightState, validateMorphoReceiptBlockState,
  validatePinnedMorphoMarketParams,
} from '../../src/adapters/morpho-accrue-interest.ts';
import type { DecodedLog, PostconditionReceipt } from '../../src/adapters/adapter.ts';
import { VerificationFailure, VerificationUncertain } from '../../src/executor/verify.ts';

const EXECUTOR = '0x2222222222222222222222222222222222222222' as const;
const TX = `0x${'a'.repeat(64)}` as `0x${string}`;
const OTHER = '0x3333333333333333333333333333333333333333' as const;
const market = (overrides: Partial<Record<'totalBorrowAssets'|'totalBorrowShares'|'lastUpdate'|'fee', bigint>> = {}) => [
  1n, 1n, overrides.totalBorrowAssets ?? 10n, overrides.totalBorrowShares ?? 5n, overrides.lastUpdate ?? 700n, overrides.fee ?? 0n,
] as const;
function normalizedParams() { return morphoAccrueInterestAdapter.validateParams({}, MORPHO_CHAIN_ID); }
function event(overrides: Record<string, unknown> = {}): DecodedLog {
  return { address: MORPHO_ADDRESS, eventName: 'AccrueInterest', args: { id: MORPHO_MARKET_ID, prevBorrowRate: '1', interest: '2', feeShares: '0', ...overrides } };
}
function receipt(events = [event()], rawAddresses: readonly `0x${string}`[] = [MORPHO_ADDRESS]): PostconditionReceipt {
  return {
    executorAddress: EXECUTOR, transactionHash: TX, status: 'success', blockNumber: 100n, gasUsed: 100_000n,
    rawLogs: rawAddresses.map((address) => ({ address, data: '0x' as const, topics: [MORPHO_ACCRUE_INTEREST_TOPIC] as const })), logs: events,
  };
}

const overrideNames = ['target','address','chainId','marketId','marketParams','token','oracle','irm','lltv','function','selector','ABI','calldata','data','value','amount','sender','recipient'];

describe('morpho.accrue_interest strict adapter policy', () => {
  it('accepts only a plain exact empty object on Base Sepolia', () => {
    assert.equal(normalizedParams().chainId, 84532);
    for (const invalid of [null, [], 'x', 1, Object.create(null), new (class {})(), ...overrideNames.map((name) => ({ [name]: 'override' }))]) {
      assert.throws(() => morphoAccrueInterestAdapter.validateParams(invalid, MORPHO_CHAIN_ID), /exactly \{\}/);
    }
    for (const chainId of [1, 8453, 11155111]) assert.throws(() => morphoAccrueInterestAdapter.validateParams({}, chainId), /unsupported chain/);
  });

  it('normalizes all pinned fields and rejects every persisted field independently when tampered', () => {
    const persisted = JSON.parse(JSON.stringify(normalizedParams(), (_key, value) => typeof value === 'bigint' ? value.toString() : value));
    assert.deepEqual(morphoAccrueInterestAdapter.validatePersistedParams!(persisted, MORPHO_CHAIN_ID), normalizedParams());
    for (const field of Object.keys(persisted).filter((field) => field !== 'marketParams')) {
      assert.throws(() => morphoAccrueInterestAdapter.validatePersistedParams!({ ...persisted, [field]: field === 'chainId' ? 8453 : 'tampered' }, MORPHO_CHAIN_ID), /policy fields mismatch/);
    }
    for (const field of Object.keys(persisted.marketParams)) {
      assert.throws(() => morphoAccrueInterestAdapter.validatePersistedParams!({ ...persisted, marketParams: { ...persisted.marketParams, [field]: 'tampered' } }, MORPHO_CHAIN_ID), /policy fields mismatch/);
    }
    assert.throws(() => morphoAccrueInterestAdapter.validatePersistedParams!({ ...persisted, extra: true }, MORPHO_CHAIN_ID), /policy fields mismatch/);
    assert.throws(() => morphoAccrueInterestAdapter.validatePersistedParams!(persisted, 8453), /policy fields mismatch/);
  });

  it('derives the pinned market ID and builds only exact zero-value tuple calldata', () => {
    assert.equal(deriveMorphoMarketId(), MORPHO_MARKET_ID);
    const call = morphoAccrueInterestAdapter.buildCall(normalizedParams(), EXECUTOR);
    assert.equal(call.to, MORPHO_ADDRESS); assert.equal(call.from, EXECUTOR); assert.equal(call.value, 0n);
    assert.equal(call.data.slice(0, 10), MORPHO_SELECTOR);
    const decoded = decodeFunctionData({ abi: MORPHO_ACCRUE_INTEREST_ABI, data: call.data });
    assert.equal(decoded.functionName, 'accrueInterest'); assert.deepEqual(decoded.args?.[0], MORPHO_MARKET_PARAMS);
    const simulation = morphoAccrueInterestAdapter.buildSimulation(normalizedParams());
    assert.equal(simulation.contractAddress, MORPHO_ADDRESS); assert.equal(simulation.value, undefined);
    assert.equal(JSON.parse(simulation.functionArgs!)[0].loanToken, MORPHO_MARKET_PARAMS.loanToken);
    assert.equal(JSON.parse(simulation.functionArgs!)[0].lltv, MORPHO_MARKET_PARAMS.lltv.toString());
  });

  it('binds a deterministic complete canonical intent and exact gas cap', () => {
    const first = morphoAccrueInterestAdapter.canonicalIntent(normalizedParams(), MORPHO_CHAIN_ID, 'bucket');
    const second = morphoAccrueInterestAdapter.canonicalIntent(normalizedParams(), MORPHO_CHAIN_ID, 'bucket');
    assert.deepEqual(first, second);
    for (const value of ['morpho.accrue_interest@1.0.0', String(MORPHO_CHAIN_ID), MORPHO_ADDRESS.toLowerCase(), MORPHO_SELECTOR, MORPHO_MARKET_ID, MORPHO_IRM_ADDRESS.toLowerCase(), MORPHO_MARKET_PARAMS.lltv.toString(), '|0|', 'bucket']) assert.ok(first.canonical.includes(value));
    assert.equal(morphoAccrueInterestAdapter.meta.maxGasEstimate, 180_000n);
    assert.ok(180_000n <= morphoAccrueInterestAdapter.meta.maxGasEstimate);
    assert.ok(180_001n > morphoAccrueInterestAdapter.meta.maxGasEstimate);
  });

  it('checks code hashes, RPC chain, and exact idToMarketParams fail closed', async () => {
    const code = '0x60006000' as const; const hash = keccak256(code);
    assert.equal(runtimeCodeHashMatches(code, hash), true);
    assert.equal(runtimeCodeHashMatches(code, MORPHO_RUNTIME_CODE_HASH), false);
    assert.equal(runtimeCodeHashMatches(undefined, MORPHO_IRM_RUNTIME_CODE_HASH), false);
    validatePinnedMorphoMarketParams([MORPHO_MARKET_PARAMS.loanToken, MORPHO_MARKET_PARAMS.collateralToken, MORPHO_MARKET_PARAMS.oracle, MORPHO_MARKET_PARAMS.irm, MORPHO_MARKET_PARAMS.lltv]);
    assert.throws(() => validatePinnedMorphoMarketParams([OTHER, MORPHO_MARKET_PARAMS.collateralToken, MORPHO_MARKET_PARAMS.oracle, MORPHO_MARKET_PARAMS.irm, MORPHO_MARKET_PARAMS.lltv]), /MarketParams mismatch/);
    const wrongChainRpc = { getChainId: async () => 8453, getBytecode: async () => code, readContract: async () => [], getBlock: async () => ({ number: 1n, timestamp: 1n }) };
    await assert.rejects(morphoAccrueInterestAdapter.quotePreflight!(normalizedParams(), wrongChainRpc), /RPC chain ID mismatch/);
  });

  it('rejects uncreated, zero-borrow, nonzero-fee, future, and insufficiently stale markets', () => {
    validateMorphoPreflightState(market(), 1_000n);
    assert.equal(MIN_ACCRUAL_STALENESS_SECONDS, 300n);
    assert.throws(() => validateMorphoPreflightState(market({ lastUpdate: 0n }), 1_000n), /uncreated/);
    assert.throws(() => validateMorphoPreflightState(market({ totalBorrowAssets: 0n }), 1_000n), /totalBorrowAssets/);
    assert.throws(() => validateMorphoPreflightState(market({ totalBorrowShares: 0n }), 1_000n), /totalBorrowShares/);
    assert.throws(() => validateMorphoPreflightState(market({ fee: 1n }), 1_000n), /fee is nonzero/);
    assert.throws(() => validateMorphoPreflightState(market({ lastUpdate: 1_001n }), 1_000n), /future/);
    assert.throws(() => validateMorphoPreflightState(market({ lastUpdate: 701n }), 1_000n), /below 300/);
    validateMorphoPreflightState(market({ lastUpdate: 700n }), 1_000n);
  });
});

describe('morpho.accrue_interest exact receipt proof', () => {
  it('accepts only exactly one Morpho log with exact market and positive accrual values', () => {
    assert.equal(evaluateMorphoAccrualEvent(receipt()).valid, true);
    const failures = [
      receipt([], []), receipt([event()], [MORPHO_ADDRESS, MORPHO_ADDRESS]),
      { ...receipt(), rawLogs: [{ address: MORPHO_ADDRESS, data: '0x' as const, topics: [`0x${'b'.repeat(64)}` as `0x${string}`] as const }] },
      receipt([{ ...event(), address: OTHER }], [OTHER]), receipt([event({ id: `0x${'b'.repeat(64)}` })]),
      receipt([event({ prevBorrowRate: '0' })]), receipt([event({ interest: '0' })]), receipt([event({ feeShares: '1' })]),
    ];
    for (const value of failures) assert.equal(evaluateMorphoAccrualEvent(value).valid, false);
  });

  it('requires exact historical lastUpdate, positive borrows, and zero fee', () => {
    validateMorphoReceiptBlockState(market({ lastUpdate: 1_000n }), 1_000n);
    assert.throws(() => validateMorphoReceiptBlockState(market({ lastUpdate: 999n }), 1_000n), /lastUpdate/);
    assert.throws(() => validateMorphoReceiptBlockState(market({ totalBorrowAssets: 0n, lastUpdate: 1_000n }), 1_000n), /borrow state/);
    assert.throws(() => validateMorphoReceiptBlockState(market({ totalBorrowShares: 0n, lastUpdate: 1_000n }), 1_000n), /borrow state/);
    assert.throws(() => validateMorphoReceiptBlockState(market({ fee: 1n, lastUpdate: 1_000n }), 1_000n), /fee/);
  });

  it('classifies missing sponsored Morpho proof as UNCERTAIN and unsponsored as failed', async () => {
    const noEvent = receipt([], []);
    const unusedRpc = {} as never;
    await assert.rejects(morphoAccrueInterestAdapter.verifyHistoricalReceipt!(normalizedParams(), noEvent, unusedRpc, { sponsored: true }), VerificationUncertain);
    await assert.rejects(morphoAccrueInterestAdapter.verifyHistoricalReceipt!(normalizedParams(), noEvent, unusedRpc, { sponsored: false }), VerificationFailure);
  });
});
