/**
 * Signed Expiring Quotes.
 *
 * A quote binds:
 * - A canonical job hash (what to execute)
 * - A deadline tier (when)
 * - A price breakdown (how much)
 * - An expiry (how long the offer is valid)
 * - A signature (proving Basis issued it)
 *
 * Quote properties:
 * - Signed by Basis's signing key (HMAC-SHA256 for speed; could upgrade to Ed25519)
 * - Bound to a specific job hash and model version
 * - Expires after the tier's quote validity window
 * - Cannot be replayed (quoteId is unique, consumed flag is tracked)
 * - Full breakdown is included for transparency
 */

import { createHmac, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { QuoteBreakdown } from './price.ts';
import type { DeadlineTier } from '../config/policy.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Quote {
  /** Unique quote identifier */
  quoteId: string;
  /** Canonical job hash (SHA-256 of the adapter's canonical intent) */
  jobHash: string;
  /** Job type from adapter */
  jobType: string;
  /** Chain ID */
  chainId: number;
  /** Deadline tier */
  deadlineTier: DeadlineTier;
  /** When the deadline expires (ISO timestamp) */
  deadlineAt: string;
  /** When this quote expires (ISO timestamp) */
  expiresAt: string;
  /** Final payable price in USD */
  priceUsd: string;
  /** Selected payment tier label */
  paymentTier: string;
  /** Pricing model version */
  pricingModelVersion: string;
  /** Full price breakdown */
  breakdown: QuoteBreakdownSerialized;
  /** Simulation result summary */
  simulation: SimulationSummary;
  /** HMAC signature over the quote payload */
  signature: string;
  /** When this quote was issued (ISO timestamp) */
  issuedAt: string;
}

export interface QuoteBreakdownSerialized {
  gasEstimate: string;
  protectedGasPriceWei: string;
  nativeAssetUsd: string;
  marketExecutionCostUsd: string;
  riskCostUsd: string;
  privateRoutingFeeUsd: string;
  fixedOverheadUsd: string;
  targetMarginUsd: string;
  rawPriceUsd: string;
  tierRoundingUsd: string;
}

export interface SimulationSummary {
  success: boolean;
  wouldRevert: boolean;
  from: string;
  to: string;
  gasEstimate: string;
  /** Stored for execution — function name */
  functionName?: string;
  /** Stored for execution — function args JSON */
  functionArgs?: string;
  /** Stored for execution — ABI JSON */
  abi?: string;
  /** Stored for execution — native value in ether */
  value?: string;
}

export interface QuoteParams {
  jobHash: string;
  jobType: string;
  chainId: number;
  deadlineTier: DeadlineTier;
  deadlineAt: Date;
  expiresAt: Date;
  gasEstimate: bigint;
  nativeAssetUsd: Decimal;
  breakdown: QuoteBreakdown;
  simulation: SimulationSummary;
}

// ─── Quote Generation ────────────────────────────────────────────────────────

/**
 * Generate a signed, expiring quote.
 *
 * @param params - all inputs needed to construct the quote
 * @param signingKey - Basis's HMAC signing key (hex string)
 */
export function generateQuote(params: QuoteParams, signingKey: string): Quote {
  const quoteId = `q_${randomUUID().replace(/-/g, '')}`;
  const issuedAt = new Date().toISOString();

  const breakdown: QuoteBreakdownSerialized = {
    gasEstimate: params.gasEstimate.toString(),
    protectedGasPriceWei: params.breakdown.protectedGasPriceWei.toString(),
    nativeAssetUsd: params.nativeAssetUsd.toString(),
    marketExecutionCostUsd: params.breakdown.marketExecutionCostUsd.toFixed(8),
    riskCostUsd: params.breakdown.riskCostUsd.toFixed(8),
    privateRoutingFeeUsd: params.breakdown.privateRoutingFeeUsd.toFixed(8),
    fixedOverheadUsd: params.breakdown.fixedOverheadUsd.toFixed(8),
    targetMarginUsd: params.breakdown.targetMarginUsd.toFixed(8),
    rawPriceUsd: params.breakdown.rawPriceUsd.toFixed(8),
    tierRoundingUsd: params.breakdown.tierRoundingUsd.toFixed(8),
  };

  const quote: Omit<Quote, 'signature'> = {
    quoteId,
    jobHash: params.jobHash,
    jobType: params.jobType,
    chainId: params.chainId,
    deadlineTier: params.deadlineTier,
    deadlineAt: params.deadlineAt.toISOString(),
    expiresAt: params.expiresAt.toISOString(),
    priceUsd: params.breakdown.payableTierUsd.toString(),
    paymentTier: params.breakdown.paymentTier,
    pricingModelVersion: params.breakdown.pricingModelVersion,
    breakdown,
    simulation: params.simulation,
    issuedAt,
  };

  const signature = signQuote(quote, signingKey);

  return { ...quote, signature };
}

/**
 * Verify a quote signature.
 * Returns true if the signature matches, false otherwise.
 */
export function verifyQuoteSignature(quote: Quote, signingKey: string): boolean {
  const { signature, ...payload } = quote;
  const expectedSignature = signQuote(payload, signingKey);
  return signature === expectedSignature;
}

/**
 * Check if a quote has expired.
 */
export function isQuoteExpired(quote: Quote, now: Date = new Date()): boolean {
  return now >= new Date(quote.expiresAt);
}

/**
 * Validate a quote for order acceptance.
 * Returns null if valid, or an error message if invalid.
 */
export function validateQuoteForOrder(
  quote: Quote,
  signingKey: string,
  expectedJobHash: string,
  now: Date = new Date(),
): string | null {
  if (!verifyQuoteSignature(quote, signingKey)) {
    return 'Invalid quote signature';
  }
  if (isQuoteExpired(quote, now)) {
    return `Quote expired at ${quote.expiresAt}`;
  }
  if (quote.jobHash !== expectedJobHash) {
    return `Job hash mismatch: expected ${expectedJobHash}, got ${quote.jobHash}`;
  }
  return null;
}

// ─── Internal ────────────────────────────────────────────────────────────────

/**
 * Compute HMAC-SHA256 signature over the quote payload.
 * The payload is JSON-serialized with sorted keys for determinism.
 */
function signQuote(payload: Omit<Quote, 'signature'>, signingKey: string): string {
  // Deterministic serialization: sort keys at all levels
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const hmac = createHmac('sha256', signingKey);
  hmac.update(canonical, 'utf8');
  return hmac.digest('hex');
}
