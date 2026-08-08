import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
  DEADLINE_TIERS,
  PAYMENT_TIERS,
  selectPaymentTier,
  PRICING_MODEL_VERSION,
} from '../../src/config/policy.ts';
import { CHAINS, getChain } from '../../src/config/chains.ts';

describe('config/policy', () => {
  it('defines four deadline tiers', () => {
    assert.deepEqual(Object.keys(DEADLINE_TIERS).sort(), [
      '1h',
      '5m',
      'best-effort',
      'next-block',
    ]);
  });

  it('fee percentiles increase with urgency', () => {
    assert.ok(DEADLINE_TIERS['next-block'].feePercentile > DEADLINE_TIERS['5m'].feePercentile);
    assert.ok(DEADLINE_TIERS['5m'].feePercentile > DEADLINE_TIERS['1h'].feePercentile);
    assert.ok(DEADLINE_TIERS['1h'].feePercentile > DEADLINE_TIERS['best-effort'].feePercentile);
  });

  it('defines four payment tiers in ascending order', () => {
    const values = Object.values(PAYMENT_TIERS);
    for (let i = 1; i < values.length; i++) {
      assert.ok(values[i]!.gt(values[i - 1]!));
    }
  });

  it('selectPaymentTier picks the cheapest tier that covers the price', () => {
    const { tier, price } = selectPaymentTier(new Decimal('0.03'));
    assert.equal(tier, 'basis-order-t2');
    assert.equal(price.toString(), '0.05');
  });

  it('selectPaymentTier uses highest tier if price exceeds all', () => {
    const { tier } = selectPaymentTier(new Decimal('999'));
    assert.equal(tier, 'basis-order-t4');
  });

  it('pricing model version is set', () => {
    assert.equal(PRICING_MODEL_VERSION, 'basis-v1');
  });
});

describe('config/chains', () => {
  it('supports four chains', () => {
    assert.equal(Object.keys(CHAINS).length, 4);
  });

  it('getChain returns correct chain', () => {
    const base = getChain(8453);
    assert.equal(base.name, 'base');
    assert.equal(base.nativeAsset, 'ETH');
    assert.equal(base.testnet, false);
  });

  it('getChain throws for unknown chain', () => {
    assert.throws(() => getChain(99999), /Unsupported chain/);
  });
});
