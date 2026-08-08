/**
 * Pure Versioned Pricing Function.
 *
 * The core of Basis: a deterministic function that takes gas estimates,
 * fee samples, FX, risk parameters and returns a reproducible price.
 *
 * Properties:
 * - No network calls
 * - No storage access
 * - No clock dependency
 * - No randomness
 * - Same inputs → same price, always
 * - Every historical quote must replay through this function and produce the same price
 *
 * Formula:
 *   protectedGasPrice = percentile(feeSamples, deadlineTier)
 *   marketExecutionCostUSD = gasEstimate × protectedGasPrice × nativeAssetUsd / 1e18
 *   riskCostUSD = marketExecutionCostUSD × retryPremiumBps / 10000
 *   privateRoutingFeeUSD = privateRouting ? configuredFee : 0
 *   rawPrice = marketExecCost + riskCost + privateRoutingFee + overhead + margin
 *   payableTier = roundToTier(rawPrice)
 */

import { Decimal } from 'decimal.js';
import type { FeeSample } from './fee-history.ts';
import { feePercentile } from './fee-history.ts';
import { PRIVATE_ROUTING_FEE_USD, PAYMENT_TIERS, selectPaymentTier } from '../config/policy.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface QuoteInputs {
  /** Estimated gas units from KeeperHub simulation */
  gasEstimate: bigint;
  /** Historical fee samples for percentile calculation */
  feeSamples: FeeSample[];
  /** Deadline tier fee percentile (e.g. 99 for next-block, 50 for best-effort) */
  feePercentileTarget: number;
  /** ETH/USD price */
  nativeAssetUsd: Decimal;
  /** Retry premium in basis points */
  retryPremiumBps: number;
  /** Target margin in basis points */
  targetMarginBps: number;
  /** Fixed platform overhead in USD */
  fixedOverheadUsd: Decimal;
  /** Whether private routing is requested */
  privateRouting: boolean;
  /** Model version identifier */
  pricingModelVersion: string;
}

export interface QuoteBreakdown {
  /** Protected gas price from fee percentile, in wei */
  protectedGasPriceWei: bigint;
  /** Gas cost in USD at the protected gas price */
  marketExecutionCostUsd: Decimal;
  /** Risk surcharge (retries, failure probability) */
  riskCostUsd: Decimal;
  /** Private routing surcharge (0 if not requested) */
  privateRoutingFeeUsd: Decimal;
  /** Fixed overhead */
  fixedOverheadUsd: Decimal;
  /** Target margin in USD */
  targetMarginUsd: Decimal;
  /** Sum of all cost components before tier rounding */
  rawPriceUsd: Decimal;
  /** Tier rounding amount (quantization) */
  tierRoundingUsd: Decimal;
  /** Final payable amount (rounded to payment tier) */
  payableTierUsd: Decimal;
  /** Selected payment tier label */
  paymentTier: string;
  /** Pricing model version */
  pricingModelVersion: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** 1 ETH = 10^18 wei */
const WEI_PER_ETH = new Decimal('1000000000000000000');

// ─── Pure Pricing Function ───────────────────────────────────────────────────

/**
 * Compute a quote price from raw inputs.
 * This function is pure: no side effects, no external dependencies.
 * Calling it with the same inputs always returns the same result.
 */
export function priceQuote(inputs: QuoteInputs): QuoteBreakdown {
  const {
    gasEstimate,
    feeSamples,
    feePercentileTarget,
    nativeAssetUsd,
    retryPremiumBps,
    targetMarginBps,
    fixedOverheadUsd,
    privateRouting,
    pricingModelVersion,
  } = inputs;

  // 1. Determine protected gas price from fee samples at the tier's percentile
  const protectedGasPriceWei = feePercentile(feeSamples, feePercentileTarget);

  // 2. Market execution cost in USD
  //    = gasEstimate × protectedGasPrice(wei) × ethUsd / 1e18
  const gasCostWei = new Decimal(gasEstimate.toString()).mul(
    new Decimal(protectedGasPriceWei.toString()),
  );
  const marketExecutionCostUsd = gasCostWei.mul(nativeAssetUsd).div(WEI_PER_ETH);

  // 3. Risk cost = market execution cost × retry premium
  const riskCostUsd = marketExecutionCostUsd.mul(new Decimal(retryPremiumBps)).div(
    new Decimal(10000),
  );

  // 4. Private routing fee
  const privateRoutingFeeUsd = privateRouting
    ? PRIVATE_ROUTING_FEE_USD
    : new Decimal(0);

  // 5. Target margin = (marketExecCost + riskCost) × marginBps / 10000
  const costBase = marketExecutionCostUsd.add(riskCostUsd);
  const targetMarginUsd = costBase.mul(new Decimal(targetMarginBps)).div(new Decimal(10000));

  // 6. Raw price sum
  const rawPriceUsd = marketExecutionCostUsd
    .add(riskCostUsd)
    .add(privateRoutingFeeUsd)
    .add(fixedOverheadUsd)
    .add(targetMarginUsd);

  // 7. Round to payment tier
  const { tier, price: payableTierUsd } = selectPaymentTier(rawPriceUsd);
  const tierRoundingUsd = payableTierUsd.sub(rawPriceUsd);

  return {
    protectedGasPriceWei,
    marketExecutionCostUsd,
    riskCostUsd,
    privateRoutingFeeUsd,
    fixedOverheadUsd,
    targetMarginUsd,
    rawPriceUsd,
    tierRoundingUsd,
    payableTierUsd,
    paymentTier: tier,
    pricingModelVersion,
  };
}
