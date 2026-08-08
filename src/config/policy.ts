/**
 * Basis policy configuration.
 * Deadline tiers, retry premiums, margin targets, fixed overheads, payment tiers.
 */

import { Decimal } from 'decimal.js';

export type DeadlineTier = 'next-block' | '5m' | '1h' | 'best-effort';

export interface TierPolicy {
  /** Fee percentile to use for gas-price protection */
  feePercentile: number;
  /** Maximum horizon in seconds */
  horizonSeconds: number;
  /** Quote validity window in seconds */
  quoteValiditySeconds: number;
  /** Maximum retry count */
  maxRetries: number;
}

export const DEADLINE_TIERS: Record<DeadlineTier, TierPolicy> = {
  'next-block': {
    feePercentile: 99,
    horizonSeconds: 15,
    quoteValiditySeconds: 15,
    maxRetries: 1,
  },
  '5m': {
    feePercentile: 95,
    horizonSeconds: 300,
    quoteValiditySeconds: 30,
    maxRetries: 3,
  },
  '1h': {
    feePercentile: 75,
    horizonSeconds: 3600,
    quoteValiditySeconds: 120,
    maxRetries: 5,
  },
  'best-effort': {
    feePercentile: 50,
    horizonSeconds: 14400,
    quoteValiditySeconds: 300,
    maxRetries: 10,
  },
};

/** Retry premium in basis points, per tier */
export const RETRY_PREMIUM_BPS: Record<DeadlineTier, number> = {
  'next-block': 2000, // 20%
  '5m': 1500,         // 15%
  '1h': 1000,         // 10%
  'best-effort': 500, //  5%
};

/** Target margin in basis points */
export const TARGET_MARGIN_BPS = 2000; // 20%

/** Fixed platform overhead in USD */
export const FIXED_OVERHEAD_USD = new Decimal('0.001');

/** Private routing surcharge in USD */
export const PRIVATE_ROUTING_FEE_USD = new Decimal('0.01');

/** Payment tiers — maps tier label to fixed USDC price */
export const PAYMENT_TIERS: Record<string, Decimal> = {
  'basis-order-t1': new Decimal('0.01'),
  'basis-order-t2': new Decimal('0.05'),
  'basis-order-t3': new Decimal('0.25'),
  'basis-order-t4': new Decimal('1.00'),
};

/** Select the cheapest tier that covers the raw quote */
export function selectPaymentTier(rawPriceUsd: Decimal): { tier: string; price: Decimal } {
  const sorted = Object.entries(PAYMENT_TIERS).sort(([, a], [, b]) => a.cmp(b));
  for (const [tier, price] of sorted) {
    if (price.gte(rawPriceUsd)) {
      return { tier, price };
    }
  }
  // If all tiers are too cheap, use the highest
  const last = sorted[sorted.length - 1]!;
  return { tier: last[0], price: last[1] };
}

/** Pricing model version identifier */
export const PRICING_MODEL_VERSION = 'basis-v1';
