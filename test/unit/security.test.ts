import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { existsSync, unlinkSync } from 'node:fs';
import { Decimal } from 'decimal.js';
import { registerOrderRoutes, type PaidTier, type TierCredentials } from '../../src/api/routes/order.ts';
import { Ledger } from '../../src/ledger/database.ts';
import { loadEnv } from '../../src/config/env.ts';
import { generateQuote, type Quote } from '../../src/quoter/quote.ts';
import { keeperHubRequest, type PersistedExecutionIntent } from '../../src/executor/intent.ts';
import { createErc20TransferAdapter } from '../../src/adapters/erc20-transfer.ts';
import { MAX_WETH_AMOUNT_WEI, WETH_ADDRESSES, weiToEtherString, wethWrapAdapter } from '../../src/adapters/weth-wrap.ts';

const KEY = 'phase-four-signing-key-at-least-32-bytes';
const TOKEN = '0x1111111111111111111111111111111111111111' as const;
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const;
const REFUND = '0x4444444444444444444444444444444444444444' as const;
const TIERS: PaidTier[] = ['basis-order-t1', 'basis-order-t2', 'basis-order-t3', 'basis-order-t4'];
const PRICES: Record<PaidTier, string> = { 'basis-order-t1': '0.01', 'basis-order-t2': '0.05', 'basis-order-t3': '0.25', 'basis-order-t4': '1' };
const CREDENTIALS: TierCredentials = {
  'basis-order-t1': 't1-workflow-secret-00000000000000000000000000000000',
  'basis-order-t2': 't2-workflow-secret-00000000000000000000000000000000',
  'basis-order-t3': 't3-workflow-secret-00000000000000000000000000000000',
  'basis-order-t4': 't4-workflow-secret-00000000000000000000000000000000',
};
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function buildQuote(tier: PaidTier): Quote {
  const now = Date.now();
  const price = new Decimal(PRICES[tier]);
  return generateQuote({
    jobHash: tier.padEnd(64, '0'), jobType: 'weth.wrap', chainId: 8453, deadlineTier: '5m',
    deadlineAt: new Date(now + 300_000), expiresAt: new Date(now + 60_000), gasEstimate: 30_000n,
    nativeAssetUsd: new Decimal('2500'),
    breakdown: { protectedGasPriceWei: 1n, marketExecutionCostUsd: new Decimal(0), riskCostUsd: new Decimal(0), privateRoutingFeeUsd: new Decimal(0), marketplaceFeeUsd: new Decimal(0), marketplaceFeeBps: 3000, fixedOverheadUsd: new Decimal(0), targetMarginUsd: new Decimal(0), rawPriceUsd: price, tierRoundingUsd: new Decimal(0), payableTierUsd: price, paymentTier: tier, pricingModelVersion: 'basis-v2' },
    simulation: { success: true, wouldRevert: false, from: RECIPIENT, to: WETH_ADDRESSES[8453]!, gasEstimate: '30000', functionName: 'deposit', abi: '[]', value: '0.001' },
    intent: { adapterName: 'weth.wrap', adapterVersion: '1.1.0', chainId: 8453, target: WETH_ADDRESSES[8453]!, functionName: 'deposit', abi: '[]', calldata: '0x1234', nativeValueWei: '1', keeperHubValue: '0.001', executorAddress: RECIPIENT, deadlineAt: new Date(now + 300_000).toISOString(), validatedParams: { amount: '1' } },
    oracleEvidence: { source: 'chainlink', observedAt: new Date(now).toISOString(), feedUpdatedAt: new Date(now).toISOString() },
    refundRecipient: REFUND,
  }, KEY);
}

function persistQuote(ledger: Ledger, quote: Quote): void {
  ledger.insertQuote({
    quoteId: quote.quoteId, jobHash: quote.jobHash, jobType: quote.jobType, chainId: quote.chainId,
    deadlineTier: quote.deadlineTier, deadlineAt: quote.deadlineAt, expiresAt: quote.expiresAt,
    priceUsd: quote.priceUsd, paymentTier: quote.paymentTier, pricingModelVersion: quote.pricingModelVersion,
    breakdown: quote.breakdown as unknown as Record<string, unknown>, simulation: quote.simulation as unknown as Record<string, unknown>,
    intent: quote.intent as unknown as Record<string, unknown>, oracleEvidence: quote.oracleEvidence as unknown as Record<string, unknown>,
    canonicalizationFormat: quote.canonicalizationFormat, signatureFormat: quote.signatureFormat,
    refundRecipient: quote.refundRecipient, signature: quote.signature, issuedAt: quote.issuedAt,
  });
}

async function makeOrderApp(tier: PaidTier) {
  const suffix = `${Date.now()}-${Math.random()}`;
  const dbPath = `/tmp/basis-phase4-${suffix}.sqlite`; const jsonl = `/tmp/basis-phase4-${suffix}.jsonl`;
  const ledger = new Ledger(dbPath, jsonl); const quote = buildQuote(tier); persistQuote(ledger, quote);
  let calls = 0; let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const executor = {
    executeOrder: async (acceptedQuote: Quote, orderId: string, authorityKind: 'MARKETPLACE_PAYMENT_AUTHORIZED', marketplaceTier: string) => {
      calls++;
      const intent: PersistedExecutionIntent = { ...acceptedQuote.intent, quoteId: acceptedQuote.quoteId, orderId, idempotencyKey: acceptedQuote.jobHash };
      ledger.admitOrder({ quoteId: acceptedQuote.quoteId, orderId, executionId: `exec_${orderId}`, authorityKind, callbackAuthKind: 'AUTHENTICATED_WORKFLOW_CALLBACK', marketplaceTier, settlementMetadataStatus: 'NOT_EXPOSED_TO_WORKFLOW', refundRecipient: acceptedQuote.refundRecipient, paymentAmountUsd: acceptedQuote.priceUsd, idempotencyKey: acceptedQuote.jobHash, chainId: acceptedQuote.chainId, intent, outboundRequest: keeperHubRequest(intent) });
      ledger.transitionOrder(orderId, 'RESIMULATING', 'fixture asynchronous execution started');
      await blocked;
      return { executionId: `exec_${orderId}`, orderId, status: 'RESIMULATING', sponsored: false };
    },
  };
  const app = Fastify(); registerOrderRoutes(app, executor as never, ledger, CREDENTIALS, KEY);
  cleanups.push(async () => { release(); await app.close(); ledger.close(); for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, jsonl]) if (existsSync(p)) unlinkSync(p); });
  return { app, ledger, quote, calls: () => calls };
}
const auth = (tier: PaidTier) => ({ authorization: `Bearer ${CREDENTIALS[tier]}` });

describe('paid Marketplace order ingress', () => {
  for (const tier of TIERS) {
    it(`${tier} credential accepts only its matching quote`, async () => {
      const { app, quote, calls } = await makeOrderApp(tier);
      const response = await app.inject({ method: 'POST', url: '/orders', headers: auth(tier), payload: { quoteId: quote.quoteId } });
      assert.equal(response.statusCode, 202); assert.equal(calls(), 1); assert.match(response.json().orderId, /^ord_/);
    });
  }

  it('every tier credential rejects all three non-matching quote tiers', async () => {
    for (const quoteTier of TIERS) {
      for (const credential of TIERS.filter((tier) => tier !== quoteTier)) {
        const { app, quote, calls } = await makeOrderApp(quoteTier);
        const response = await app.inject({ method: 'POST', url: '/orders', headers: auth(credential), payload: { quoteId: quote.quoteId } });
        assert.equal(response.statusCode, 403); assert.equal(calls(), 0);
      }
    }
  });

  it('rejects missing and invalid credentials', async () => {
    const { app, quote, calls } = await makeOrderApp('basis-order-t1');
    assert.equal((await app.inject({ method: 'POST', url: '/orders', payload: { quoteId: quote.quoteId } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/orders', headers: { authorization: 'Bearer invalid' }, payload: { quoteId: quote.quoteId } })).statusCode, 401);
    assert.equal(calls(), 0);
  });

  it('rejects legacy payment headers, paymentTxHash, tier, and refundRecipient overrides', async () => {
    const attempts = [
      { headers: { ...auth('basis-order-t1'), 'x-basis-payment-authority': 'keeperhub' }, payload: { quoteId: '' } },
      { headers: auth('basis-order-t1'), payload: { quoteId: '', paymentTxHash: '0xfake' } },
      { headers: auth('basis-order-t1'), payload: { quoteId: '', paymentTier: 'basis-order-t1' } },
      { headers: auth('basis-order-t1'), payload: { quoteId: '', refundRecipient: RECIPIENT } },
    ];
    for (const attempt of attempts) {
      const fixture = await makeOrderApp('basis-order-t1'); attempt.payload.quoteId = fixture.quote.quoteId;
      const response = await fixture.app.inject({ method: 'POST', url: '/orders', headers: attempt.headers, payload: attempt.payload });
      assert.equal(response.statusCode, 400); assert.equal(fixture.calls(), 0);
    }
  });

  it('returns quickly while execution continues and duplicate delivery returns one orderId', async () => {
    const { app, quote, calls } = await makeOrderApp('basis-order-t2');
    const started = Date.now();
    const first = await app.inject({ method: 'POST', url: '/orders', headers: auth('basis-order-t2'), payload: { quoteId: quote.quoteId } });
    assert.ok(Date.now() - started < 1000); assert.equal(first.statusCode, 202);
    const second = await app.inject({ method: 'POST', url: '/orders', headers: auth('basis-order-t2'), payload: { quoteId: quote.quoteId } });
    assert.equal(second.statusCode, 202); assert.equal(second.json().orderId, first.json().orderId); assert.equal(second.json().duplicate, true); assert.equal(calls(), 1);
  });

  it('concurrent callbacks atomically create one order and never persist the secret', async () => {
    const { app, ledger, quote, calls } = await makeOrderApp('basis-order-t3');
    const responses = await Promise.all(Array.from({ length: 8 }, () => app.inject({ method: 'POST', url: '/orders', headers: auth('basis-order-t3'), payload: { quoteId: quote.quoteId } })));
    assert.equal(new Set(responses.map((r) => r.json().orderId)).size, 1); assert.equal(calls(), 1);
    const order = ledger.getDb().prepare('SELECT * FROM orders').get() as Record<string, unknown>;
    assert.equal(order.refund_recipient, REFUND); assert.equal(order.marketplace_tier, 'basis-order-t3'); assert.equal(order.authority_kind, 'MARKETPLACE_PAYMENT_AUTHORIZED'); assert.equal(order.settlement_metadata_status, 'NOT_EXPOSED_TO_WORKFLOW');
    assert.equal(JSON.stringify(order).includes(CREDENTIALS['basis-order-t3']), false);
  });
});

describe('adapter safety policies', () => {
  it('rejects arbitrary WETH addresses and excessive amounts', () => {
    assert.throws(() => wethWrapAdapter.validateParams({ weth: TOKEN, amount: '1' }, 8453), /caller-selected/);
    assert.throws(() => wethWrapAdapter.validateParams({ amount: (MAX_WETH_AMOUNT_WEI + 1n).toString() }, 8453), /exceeds maximum/);
    assert.equal(wethWrapAdapter.validateParams({ amount: MAX_WETH_AMOUNT_WEI.toString() }, 8453).weth.toLowerCase(), WETH_ADDRESSES[8453]!.toLowerCase());
  });
  it('formats wei without JavaScript Number precision loss', () => assert.equal(weiToEtherString(9_007_199_254_740_993n), '0.009007199254740993'));
  it('enforces exact ERC-20 allowlist policy', () => {
    const adapter = createErc20TransferAdapter([{ chainId: 8453, token: TOKEN, recipient: RECIPIENT, maxAmount: 100n }]);
    assert.throws(() => adapter.validateParams({ token: '0x3333333333333333333333333333333333333333', to: RECIPIENT, amount: '1' }, 8453), /not allowlisted/);
    assert.throws(() => adapter.validateParams({ token: TOKEN, to: RECIPIENT, amount: '101' }, 8453), /exceeds allowlisted maximum/);
  });
});

function productionEnv() {
  return {
    BASIS_ENV: 'production', KEEPERHUB_API_KEY: 'kh_prod', BASIS_SIGNING_KEY: 's'.repeat(32),
    BASIS_ORDER_T1_SECRET: '1'.repeat(32), BASIS_ORDER_T2_SECRET: '2'.repeat(32), BASIS_ORDER_T3_SECRET: '3'.repeat(32), BASIS_ORDER_T4_SECRET: '4'.repeat(32),
    ORACLE_REFERENCE_ETH_USD: '2500', ORACLE_REFERENCE_UPDATED_AT: String(Math.floor(Date.now() / 1000)),
  };
}
describe('production configuration', () => {
  it('requires all four distinct paid workflow secrets', () => {
    const env = productionEnv(); delete (env as Partial<typeof env>).BASIS_ORDER_T4_SECRET;
    assert.throws(() => loadEnv(env), /BASIS_ORDER_T4_SECRET/);
    assert.throws(() => loadEnv({ ...productionEnv(), BASIS_ORDER_T4_SECRET: '3'.repeat(32) }), /must be distinct/);
  });
  it('forbids test FX fallback and needs an oracle reference', () => {
    const noReference = productionEnv(); delete (noReference as Partial<typeof noReference>).ORACLE_REFERENCE_ETH_USD;
    assert.throws(() => loadEnv(noReference), /reference price and timestamp/);
    assert.throws(() => loadEnv({ ...productionEnv(), ALLOW_TEST_FX_FALLBACK: 'true', TEST_FX_FALLBACK_USD: '2500' }), /cannot enable/);
  });
  it('runs without any model-provider configuration', () => {
    const env = loadEnv(productionEnv());
    assert.equal(Object.keys(env).some((key) => /llm|openai|anthropic/i.test(key)), false);
  });
});
