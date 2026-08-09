import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import {
  generateQuote,
  verifyQuoteSignature,
  isQuoteExpired,
  validateQuoteForOrder,
  type QuoteParams,
  type Quote,
} from '../../src/quoter/quote.ts';
import type { QuoteBreakdown } from '../../src/quoter/price.ts';

const SIGNING_KEY = 'a'.repeat(64);
const WRONG_KEY = 'b'.repeat(64);

function makeBreakdown(): QuoteBreakdown {
  return {
    protectedGasPriceWei: 32_000_000_000n,
    marketExecutionCostUsd: new Decimal('0.016'),
    riskCostUsd: new Decimal('0.0016'),
    privateRoutingFeeUsd: new Decimal('0'),
    marketplaceFeeUsd: new Decimal('0.009471428571428571'),
    marketplaceFeeBps: 3000,
    fixedOverheadUsd: new Decimal('0.001'),
    targetMarginUsd: new Decimal('0.0035'),
    rawPriceUsd: new Decimal('0.0221'),
    tierRoundingUsd: new Decimal('0.0279'),
    payableTierUsd: new Decimal('0.05'),
    paymentTier: 'basis-order-t2',
    pricingModelVersion: 'basis-v2',
  };
}

function makeQuoteParams(overrides: Partial<QuoteParams> = {}): QuoteParams {
  const now = new Date();
  return {
    jobHash: 'abc123def456'.repeat(5).slice(0, 64),
    jobType: 'erc20.transfer',
    chainId: 8453,
    deadlineTier: '5m',
    deadlineAt: new Date(now.getTime() + 300_000),
    expiresAt: new Date(now.getTime() + 30_000),
    gasEstimate: 200_000n,
    nativeAssetUsd: new Decimal('2500'),
    breakdown: makeBreakdown(),
    simulation: {
      success: true,
      wouldRevert: false,
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      gasEstimate: '200000',
    },
    intent: {
      adapterName: 'erc20.transfer',
      adapterVersion: '1.1.0',
      chainId: 8453,
      target: '0x2222222222222222222222222222222222222222',
      functionName: 'transfer',
      functionArgs: '[]',
      abi: '[]',
      calldata: '0x',
      nativeValueWei: '0',
      executorAddress: '0x1111111111111111111111111111111111111111',
      deadlineAt: new Date(now.getTime() + 300_000).toISOString(),
      validatedParams: {},
    },
    oracleEvidence: {
      source: 'chainlink',
      observedAt: now.toISOString(),
      feedUpdatedAt: now.toISOString(),
      referencePriceUsd: '2500',
      divergenceBps: '0.00',
    },
    ...overrides,
  };
}

describe('quoter/quote', () => {
  it('quote generation produces unique IDs', () => {
    const params = makeQuoteParams();
    const q1 = generateQuote(params, SIGNING_KEY);
    const q2 = generateQuote(params, SIGNING_KEY);

    assert.notEqual(q1.quoteId, q2.quoteId);
    assert.ok(q1.quoteId.startsWith('q_'));
    assert.ok(q2.quoteId.startsWith('q_'));
  });

  it('signature verification with correct key passes', () => {
    const quote = generateQuote(makeQuoteParams(), SIGNING_KEY);
    assert.equal(verifyQuoteSignature(quote, SIGNING_KEY), true);
  });

  it('signature verification with wrong key fails', () => {
    const quote = generateQuote(makeQuoteParams(), SIGNING_KEY);
    assert.equal(verifyQuoteSignature(quote, WRONG_KEY), false);
  });

  it('signature verification rejects tampering in every nested signed area', () => {
    const mutations: Array<(quote: Quote) => void> = [
      (quote) => { quote.intent.validatedParams = { recipient: { address: '0x3333333333333333333333333333333333333333' } }; },
      (quote) => { quote.simulation.gasEstimate = '999999'; },
      (quote) => { quote.breakdown.marketplaceFeeUsd = '0.00000000'; },
      (quote) => { quote.oracleEvidence.source = 'explicit-non-production-fallback'; },
    ];
    for (const mutate of mutations) {
      const quote = generateQuote(makeQuoteParams(), SIGNING_KEY);
      mutate(quote);
      assert.equal(verifyQuoteSignature(quote, SIGNING_KEY), false);
    }
  });

  it('requires exact integrity formats and a well-formed timing-safe MAC', () => {
    const quote = generateQuote(makeQuoteParams(), SIGNING_KEY);
    quote.signatureFormat = 'hmac-sha256:v1' as Quote['signatureFormat'];
    assert.equal(verifyQuoteSignature(quote, SIGNING_KEY), false);
    quote.signature = 'not-a-mac';
    assert.equal(verifyQuoteSignature(quote, SIGNING_KEY), false);
  });

  it('canonical signatures are invariant to nested object key insertion order', () => {
    const params = makeQuoteParams();
    params.intent.validatedParams = { outer: { alpha: 1, beta: 2 } };
    const quote = generateQuote(params, SIGNING_KEY);
    quote.intent.validatedParams = { outer: { beta: 2, alpha: 1 } };
    assert.equal(verifyQuoteSignature(quote, SIGNING_KEY), true);
  });

  it('expired quote detection works', () => {
    const params = makeQuoteParams({
      expiresAt: new Date(Date.now() - 60_000), // expired 1 minute ago
    });
    const quote = generateQuote(params, SIGNING_KEY);
    assert.equal(isQuoteExpired(quote), true);
  });

  it('non-expired quote detection works', () => {
    const params = makeQuoteParams({
      expiresAt: new Date(Date.now() + 60_000), // expires in 1 minute
    });
    const quote = generateQuote(params, SIGNING_KEY);
    assert.equal(isQuoteExpired(quote), false);
  });

  it('validateQuoteForOrder catches all failure cases', () => {
    const params = makeQuoteParams({
      expiresAt: new Date(Date.now() + 60_000),
    });
    const quote = generateQuote(params, SIGNING_KEY);
    const expectedJobHash = params.jobHash;
    const now = new Date();

    // Wrong signing key → invalid signature
    const sigErr = validateQuoteForOrder(quote, WRONG_KEY, expectedJobHash, now);
    assert.ok(sigErr !== null);
    assert.ok(sigErr!.includes('Invalid quote signature'));

    // Expired quote
    const futureDate = new Date(Date.now() + 120_000);
    const expErr = validateQuoteForOrder(quote, SIGNING_KEY, expectedJobHash, futureDate);
    assert.ok(expErr !== null);
    assert.ok(expErr!.includes('Quote expired'));

    // Job hash mismatch
    const wrongHash = 'f'.repeat(64);
    const hashErr = validateQuoteForOrder(quote, SIGNING_KEY, wrongHash, now);
    assert.ok(hashErr !== null);
    assert.ok(hashErr!.includes('Job hash mismatch'));
  });

  it('validateQuoteForOrder passes valid quote', () => {
    const params = makeQuoteParams({
      expiresAt: new Date(Date.now() + 60_000),
    });
    const quote = generateQuote(params, SIGNING_KEY);
    const result = validateQuoteForOrder(quote, SIGNING_KEY, params.jobHash, new Date());
    assert.equal(result, null);
  });
});
