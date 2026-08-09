import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { existsSync, unlinkSync } from 'node:fs';
import { registerOrderRoutes } from '../../src/api/routes/order.ts';
import { Ledger } from '../../src/ledger/database.ts';
import { loadEnv } from '../../src/config/env.ts';
import { createErc20TransferAdapter } from '../../src/adapters/erc20-transfer.ts';
import { MAX_WETH_AMOUNT_WEI, WETH_ADDRESSES, weiToEtherString, wethWrapAdapter } from '../../src/adapters/weth-wrap.ts';

const SECRET = 'order-ingress-secret-that-is-at-least-32-characters';
const TOKEN = '0x1111111111111111111111111111111111111111' as const;
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function makeOrderApp() {
  const suffix = `${Date.now()}-${Math.random()}`;
  const db = `/tmp/basis-security-${suffix}.sqlite`;
  const jsonl = `/tmp/basis-security-${suffix}.jsonl`;
  const ledger = new Ledger(db, jsonl);
  let calls = 0;
  const executor = { executeOrder: async (_quote: unknown, orderId: string) => { calls++; return { executionId: 'exec_safe', keeperhubExecutionId: 'kh_safe', orderId, status: 'SUCCEEDED' as const, sponsored: false }; } };
  const app = Fastify();
  registerOrderRoutes(app, executor as never, ledger, SECRET);
  ledger.insertQuote({
    quoteId: 'q_safe', jobHash: 'a'.repeat(64), jobType: 'weth.wrap', chainId: 8453,
    deadlineTier: '5m', deadlineAt: new Date(Date.now() + 300_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(), priceUsd: '0.05',
    paymentTier: 'basis-order-t2', pricingModelVersion: 'basis-v1', breakdown: { gasEstimate: '30000' },
    simulation: { success: true, wouldRevert: false, from: RECIPIENT, to: WETH_ADDRESSES[8453], gasEstimate: '30000', functionName: 'deposit', abi: '[]', value: '0.001' },
    signature: 'executor-verifies-this-in-production', issuedAt: new Date().toISOString(),
  });
  cleanups.push(async () => { await app.close(); ledger.close(); for (const p of [db, `${db}-wal`, `${db}-shm`, jsonl]) if (existsSync(p)) unlinkSync(p); });
  return { app, calls: () => calls };
}

const validHeaders = { authorization: `Bearer ${SECRET}`, 'x-basis-ingress-source': 'keeperhub-private-workflow' };

describe('private order ingress', () => {
  it('rejects missing authentication before execution', async () => {
    const { app, calls } = await makeOrderApp();
    const response = await app.inject({ method: 'POST', url: '/orders', payload: { quoteId: 'q_safe' } });
    assert.equal(response.statusCode, 401); assert.equal(calls(), 0);
  });
  it('rejects invalid authentication before execution', async () => {
    const { app, calls } = await makeOrderApp();
    const response = await app.inject({ method: 'POST', url: '/orders', headers: { ...validHeaders, authorization: 'Bearer wrong' }, payload: { quoteId: 'q_safe' } });
    assert.equal(response.statusCode, 401); assert.equal(calls(), 0);
  });
  it('rejects missing trusted ingress source marker before execution', async () => {
    const { app, calls } = await makeOrderApp();
    const response = await app.inject({ method: 'POST', url: '/orders', headers: { authorization: `Bearer ${SECRET}` }, payload: { quoteId: 'q_safe' } });
    assert.equal(response.statusCode, 403); assert.equal(calls(), 0);
  });

  it('does not treat the former static payment-authority header as payment proof', async () => {
    const { app, calls } = await makeOrderApp();
    const response = await app.inject({
      method: 'POST', url: '/orders',
      headers: { authorization: `Bearer ${SECRET}`, 'x-basis-payment-authority': 'keeperhub-marketplace' },
      payload: { quoteId: 'q_safe' },
    });
    assert.equal(response.statusCode, 403); assert.equal(calls(), 0);
  });
  it('accepts a valid authenticated KeeperHub internal order', async () => {
    const { app, calls } = await makeOrderApp();
    const response = await app.inject({ method: 'POST', url: '/orders', headers: validHeaders, payload: { quoteId: 'q_safe' } });
    assert.equal(response.statusCode, 200); assert.equal(calls(), 1); assert.equal(response.json().executionId, 'exec_safe');
  });
});

describe('adapter safety policies', () => {
  it('rejects arbitrary WETH addresses and excessive amounts', () => {
    assert.throws(() => wethWrapAdapter.validateParams({ weth: TOKEN, amount: '1' }, 8453), /caller-selected/);
    assert.throws(() => wethWrapAdapter.validateParams({ amount: (MAX_WETH_AMOUNT_WEI + 1n).toString() }, 8453), /exceeds maximum/);
    const valid = wethWrapAdapter.validateParams({ amount: MAX_WETH_AMOUNT_WEI.toString() }, 8453);
    assert.equal(valid.weth.toLowerCase(), WETH_ADDRESSES[8453]!.toLowerCase());
  });
  it('formats wei without JavaScript Number precision loss', () => {
    assert.equal(weiToEtherString(9_007_199_254_740_993n), '0.009007199254740993');
  });
  it('rejects arbitrary tokens and enforces explicit recipient and amount policy', () => {
    const adapter = createErc20TransferAdapter([{ chainId: 8453, token: TOKEN, recipient: RECIPIENT, maxAmount: 100n }]);
    assert.throws(() => adapter.validateParams({ token: '0x3333333333333333333333333333333333333333', to: RECIPIENT, amount: '1' }, 8453), /not allowlisted/);
    assert.throws(() => adapter.validateParams({ token: TOKEN, to: RECIPIENT, amount: '101' }, 8453), /exceeds allowlisted maximum/);
    assert.equal(adapter.validateParams({ token: TOKEN, to: RECIPIENT, amount: '100' }, 8453).amount, 100n);
  });
});

describe('production configuration', () => {
  it('fails closed when the private ingress secret is absent', () => {
    assert.throws(() => loadEnv({ BASIS_ENV: 'production', KEEPERHUB_API_KEY: 'kh_prod', BASIS_SIGNING_KEY: 's'.repeat(32) }), /ORDER_INGRESS_SECRET/);
  });

  it('loads deterministic runtime configuration without any LLM provider', () => {
    const env = loadEnv({
      BASIS_ENV: 'production', KEEPERHUB_API_KEY: 'kh_prod',
      BASIS_SIGNING_KEY: 's'.repeat(32), ORDER_INGRESS_SECRET: 'i'.repeat(32),
    });
    assert.equal(env.environment, 'production');
    assert.equal(Object.keys(env).some((key) => /llm|openai|anthropic/i.test(key)), false);
  });

});