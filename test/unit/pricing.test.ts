import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { priceQuote, type QuoteInputs } from '../../src/quoter/price.ts';
import { buildFeeSamples } from '../../src/quoter/fee-history.ts';
import { MARKETPLACE_FEE_BPS } from '../../src/config/policy.ts';

function makeFeeSamples(count = 20, baseFee = 30_000_000n, priorityFee = 2_000_000n) {
  return buildFeeSamples(Array.from({ length: count }, (_, i) => baseFee + BigInt(i) * 1_000_000n), Array.from({ length: count }, () => priorityFee), 1000n);
}
function makeInputs(overrides: Partial<QuoteInputs> = {}): QuoteInputs {
  return { gasEstimate: 200_000n, feeSamples: makeFeeSamples(), feePercentileTarget: 75, nativeAssetUsd: new Decimal('2500'), targetMarginBps: 2000, fixedOverheadUsd: new Decimal('0.001'), pricingModelVersion: 'basis-v2', ...overrides };
}

describe('quoter/price', () => {
  it('prices deterministically and discloses the real marketplace fee', () => {
    const first = priceQuote(makeInputs());
    const second = priceQuote(makeInputs());
    assert.equal(first.marketplaceFeeBps, MARKETPLACE_FEE_BPS);
    assert.ok(first.marketplaceFeeUsd.gt(0));
    assert.ok(first.riskCostUsd.eq(0));
    assert.ok(first.privateRoutingFeeUsd.eq(0));
    assert.ok(first.rawPriceUsd.eq(second.rawPriceUsd));
    assert.equal(first.paymentTier, second.paymentTier);
  });

  it('grosses seller-required cost up so 70% of raw price covers it', () => {
    const result = priceQuote(makeInputs());
    const sellerRequired = result.marketExecutionCostUsd.add(result.fixedOverheadUsd).add(result.targetMarginUsd);
    assert.ok(result.rawPriceUsd.mul('0.70').eq(sellerRequired));
    assert.ok(result.marketplaceFeeUsd.eq(result.rawPriceUsd.mul('0.30')));
  });

  it('higher fee percentiles and gas estimates increase price', () => {
    const lowUrgency = priceQuote(makeInputs({ feePercentileTarget: 50 }));
    const highUrgency = priceQuote(makeInputs({ feePercentileTarget: 99 }));
    assert.ok(highUrgency.protectedGasPriceWei >= lowUrgency.protectedGasPriceWei);
    const lowGas = priceQuote(makeInputs({ gasEstimate: 100_000n }));
    const highGas = priceQuote(makeInputs({ gasEstimate: 1_000_000n }));
    assert.ok(highGas.rawPriceUsd.gt(lowGas.rawPriceUsd));
  });

  it('zero gas still grosses overhead up for the marketplace fee', () => {
    const result = priceQuote(makeInputs({ gasEstimate: 0n }));
    assert.ok(result.marketExecutionCostUsd.eq(0));
    assert.ok(result.targetMarginUsd.eq(0));
    assert.ok(result.rawPriceUsd.eq(new Decimal('0.001').div('0.70')));
    assert.ok(result.payableTierUsd.gte(result.rawPriceUsd));
  });

  it('rejects raw prices above the largest payment tier', () => {
    assert.throws(() => priceQuote(makeInputs({ gasEstimate: 10_000_000n })), /exceeds maximum payment tier/);
  });
});
