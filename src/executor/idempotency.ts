/**
 * Canonical Intent Hashing and Idempotency Key Derivation.
 *
 * The idempotency key is derived from economic intent, not from an attempt.
 * Same job + same deadline bucket → same key → safe to retry without double-execution.
 *
 * Key derivation follows KeeperHub's documented canonicalization rules:
 * - Numeric chain ID in decimal form
 * - Lowercase addresses
 * - Integer atomic-unit amounts; never floating point
 * - ABI arguments encoded deterministically
 * - Pipe-delimited canonical string
 * - SHA-256 hash of UTF-8 bytes → lowercase hex
 */

import { createHash } from 'node:crypto';
import type { CanonicalFields } from '../adapters/adapter.ts';

/**
 * Derive a deadline bucket from a timestamp.
 * Buckets group by hour so recurring work within the same hour shares a key
 * but the same job in the next hour gets a fresh key.
 *
 * Format: ISO-8601 truncated to the hour: "2026-08-08T12"
 */
export function deadlineBucket(deadlineAt: Date): string {
  return deadlineAt.toISOString().slice(0, 13);
}

/**
 * Compute the SHA-256 idempotency key from canonical intent fields.
 * Returns the lowercase hex digest suitable for the Idempotency-Key header.
 */
export function computeIdempotencyKey(canonical: CanonicalFields): string {
  const hash = createHash('sha256');
  hash.update(canonical.canonical, 'utf8');
  return hash.digest('hex');
}

/**
 * Full idempotency key derivation from adapter output.
 * This is the main function callers should use.
 */
export function deriveIdempotencyKey(
  canonical: CanonicalFields,
): string {
  return computeIdempotencyKey(canonical);
}

export interface RefundIdempotencyFields {
  refundPolicyId: string;
  orderId: string;
  quoteId: string;
  chainId: number;
  tokenAddress: string;
  refundRecipient: string;
  atomicAmount: string;
}

export function deriveRefundIdempotencyKey(fields: RefundIdempotencyFields): string {
  const amount = canonicalAmount(fields.atomicAmount);
  const canonical = [
    'refund', escapeCanonicalField(fields.refundPolicyId), escapeCanonicalField(fields.orderId),
    escapeCanonicalField(fields.quoteId), String(fields.chainId), canonicalAddress(fields.tokenAddress),
    canonicalAddress(fields.refundRecipient), amount,
  ].join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Escape special characters in opaque identifiers for canonical strings.
 * Percent-encode `%` as `%25` and `|` as `%7C`.
 */
export function escapeCanonicalField(value: string): string {
  return value.replace(/%/g, '%25').replace(/\|/g, '%7C');
}

/**
 * Canonicalize an address: lowercase, no whitespace.
 */
export function canonicalAddress(addr: string): string {
  return addr.toLowerCase().trim();
}

/**
 * Canonicalize an amount: must be a non-negative integer string.
 * Rejects floating point, negative values, and non-numeric strings.
 */
export function canonicalAmount(amount: bigint | string): string {
  const val = typeof amount === 'bigint' ? amount : BigInt(amount);
  if (val < 0n) throw new Error('Canonical amount must be non-negative');
  return val.toString();
}
