import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import { priceQuote, type QuoteInputs } from '../../src/quoter/price.ts';
import { buildFeeSamples } from '../../src/quoter/fee-history.ts';
import { PRIVATE_ROUTING_FEE_USD } from '../../src/config/policy.ts';

function makeFeeSamples(count = 20, baseFee = 30_000_000_000n, priorityFee = 2_000_000_000n) {
  const baseFees = Array.from({ length: count }, (_, i) => baseFee + BigInt(i) * 1_000_000_000n);
  const priorityFees = Array.from({ length: count }, () => priorityFee);
  return buildFeeSamples(baseFees, priorityFees, 1000n);
}

function makeInputs(overrides: Partial<QuoteInputs> = {}): QuoteInputs {
  return {
    gasEstimate: 200_000n,
    feeSamples: makeFeeSamples(),
    feePercentileTarget: 75,
    nativeAssetUsd: new Decimal('2500'),
    retryPremiumBps: 1000,
    targetMarginBps: 2000,
    fixedOverheadUsd: new Decimal('0.001'),
    privateRouting: false,
    pricingModelVersion: 'basis-v1',
    ...overrides,
  };
}

describe('quoter/price', () => {
  it('basic pricing with known inputs produces expected output', () => {
    const result = priceQuote(makeInputs());

    // Result should have all fields
    assert.ok(result.protectedGasPriceWei > 0n);
    assert.ok(result.marketExecutionCostUsd.gt(new Decimal(0)));
    assert.ok(result.riskCostUsd.gt(new Decimal(0)));
    assert.ok(result.rawPriceUsd.gt(new Decimal(0)));
    // payableTierUsd is the selected tier (may cap at max tier)
    assert.ok(result.payableTierUsd.gt(new Decimal(0)));
    assert.equal(result.pricingModelVersion, 'basis-v1');
    assert.ok(result.paymentTier.startsWith('basis-order-'));
  });

  it('different fee percentiles produce different prices (urgency pricing)', () => {
    const low = priceQuote(makeInputs({ feePercentileTarget: 50 }));
    const high = priceQuote(makeInputs({ feePercentileTarget: 99 }));

    // Higher percentile = higher gas price = higher cost
    assert.ok(high.protectedGasPriceWei >= low.protectedGasPriceWei);
    assert.ok(high.marketExecutionCostUsd.gte(low.marketExecutionCostUsd));
  });

  it('zero gas estimate produces minimal price (just overhead + margin)', () => {
    const result = priceQuote(makeInputs({ gasEstimate: 0n }));

    // With 0 gas, market execution cost should be 0
    assert.ok(result.marketExecutionCostUsd.eq(new Decimal(0)));
    assert.ok(result.riskCostUsd.eq(new Decimal(0)));
    assert.ok(result.targetMarginUsd.eq(new Decimal(0)));
    // Raw price should just be overhead
    assert.ok(result.rawPriceUsd.eq(new Decimal('0.001')));
    // Payable tier must still cover it
    assert.ok(result.payableTierUsd.gte(result.rawPriceUsd));
  });

  it('high gas estimate produces higher price', () => {
    const low = priceQuote(makeInputs({ gasEstimate: 100_000n }));
    const high = priceQuote(makeInputs({ gasEstimate: 10_000_000n }));

    assert.ok(high.rawPriceUsd.gt(low.rawPriceUsd));
    assert.ok(high.marketExecutionCostUsd.gt(low.marketExecutionCostUsd));
  });

  it('private routing adds the surcharge', () => {
    const withoutPrivate = priceQuote(makeInputs({ privateRouting: false }));
    const withPrivate = priceQuote(makeInputs({ privateRouting: true }));

    assert.ok(withoutPrivate.privateRoutingFeeUsd.eq(new Decimal(0)));
    assert.ok(withPrivate.privateRoutingFeeUsd.eq(PRIVATE_ROUTING_FEE_USD));
    assert.ok(withPrivate.rawPriceUsd.gt(withoutPrivate.rawPriceUsd));
  });

  it('determinism: same inputs → same result every time', () => {
    const inputs = makeInputs();
    const result1 = priceQuote(inputs);
    const result2 = priceQuote(inputs);

    assert.equal(result1.protectedGasPriceWei, result2.protectedGasPriceWei);
    assert.ok(result1.rawPriceUsd.eq(result2.rawPriceUsd));
    assert.ok(result1.payableTierUsd.eq(result2.payableTierUsd));
    assert.equal(result1.paymentTier, result2.paymentTier);
    assert.ok(result1.marketExecutionCostUsd.eq(result2.marketExecutionCostUsd));
    assert.ok(result1.riskCostUsd.eq(result2.riskCostUsd));
    assert.ok(result1.targetMarginUsd.eq(result2.targetMarginUsd));
  });

  it('payment tier selection works correctly', () => {
    // Very small price → tier 1 (0.01)
    const tiny = priceQuote(makeInputs({ gasEstimate: 0n }));
    assert.equal(tiny.paymentTier, 'basis-order-t1');
    // When rawPrice is within a tier, payable >= raw
    assert.ok(tiny.payableTierUsd.gte(tiny.rawPriceUsd));

    // Use inputs that produce a raw price between tier1 and tier2 (0.01 < raw <= 0.05)
    // Very low gas + very low ETH price to stay in tier range
    const small = priceQuote(makeInputs({
      gasEstimate: 1000n,
      nativeAssetUsd: new Decimal('1'),
      retryPremiumBps: 100,
      targetMarginBps: 100,
    }));
    // Raw price should be very low, within tier range
    assert.ok(small.payableTierUsd.gte(small.rawPriceUsd));
    // Tier rounding should be non-negative when within range
    assert.ok(small.tierRoundingUsd.gte(new Decimal(0)));
  });
});
