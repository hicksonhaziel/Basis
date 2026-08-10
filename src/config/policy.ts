/**
 * Basis policy configuration.
 * Deadline tiers, margin targets, fixed overheads, marketplace fee, and payment tiers.
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
}

export const DEADLINE_TIERS: Record<DeadlineTier, TierPolicy> = {
  'next-block': {
    feePercentile: 99,
    horizonSeconds: 15,
    quoteValiditySeconds: 15,
  },
  '5m': {
    feePercentile: 95,
    horizonSeconds: 300,
    quoteValiditySeconds: 30,
  },
  '1h': {
    feePercentile: 75,
    horizonSeconds: 3600,
    quoteValiditySeconds: 120,
  },
  'best-effort': {
    feePercentile: 50,
    horizonSeconds: 14400,
    quoteValiditySeconds: 300,
  },
};

/** Target margin in basis points */
export const TARGET_MARGIN_BPS = 2000; // 20%

/** Fixed platform overhead in USD */
export const FIXED_OVERHEAD_USD = new Decimal('0.001');

export const MARKETPLACE_FEE_BPS = 3000;

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
  const maximum = sorted[sorted.length - 1]!;
  throw new Error(`Raw price $${rawPriceUsd.toString()} exceeds maximum payment tier $${maximum[1].toString()}`);
}

/** Pricing model version identifier */
export const PRICING_MODEL_VERSION = 'basis-v2';

/** Phase 5 fixed gross-service-fee refund rail. */
export const REFUND_POLICY_ID = 'basis-refund-v1-base-usdc' as const;
export const REFUND_CHAIN_ID = 8453 as const;
export const REFUND_TOKEN_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
export const REFUND_TOKEN_DECIMALS = 6 as const;
export const REFUND_TIER_TERMS = {
  'basis-order-t1': { amountUsd: '0.01', atomicAmount: 10_000n },
  'basis-order-t2': { amountUsd: '0.05', atomicAmount: 50_000n },
  'basis-order-t3': { amountUsd: '0.25', atomicAmount: 250_000n },
  'basis-order-t4': { amountUsd: '1.00', atomicAmount: 1_000_000n },
} as const;
export type PaidTier = keyof typeof REFUND_TIER_TERMS;

export function refundTermsForTier(tier: string) {
  const terms = REFUND_TIER_TERMS[tier as PaidTier];
  if (!terms) throw new Error(`Unsupported refundable Marketplace tier: ${tier}`);
  return {
    refundPolicyId: REFUND_POLICY_ID,
    refundChainId: REFUND_CHAIN_ID,
    refundTokenAddress: REFUND_TOKEN_ADDRESS,
    grossRefundAmountUsd: terms.amountUsd,
    refundAmountAtomic: terms.atomicAmount.toString(),
  } as const;
}

/** best-effort has a scheduling preference, not a contractual timing guarantee. */
export function hasContractualDeadline(tier: DeadlineTier): boolean {
  return tier !== 'best-effort';
}
