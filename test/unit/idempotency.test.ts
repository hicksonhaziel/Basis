import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeIdempotencyKey,
  deriveRefundIdempotencyKey,
  deadlineBucket,
  escapeCanonicalField,
  canonicalAmount,
  canonicalAddress,
} from '../../src/executor/idempotency.ts';
import type { CanonicalFields } from '../../src/adapters/adapter.ts';

describe('executor/idempotency', () => {
  it('same canonical fields → same key', () => {
    const fields: CanonicalFields = {
      fields: ['chainId', 'to', 'amount'],
      canonical: 'erc20.transfer@1.0.0|8453|0xabc|1000000',
    };
    const key1 = computeIdempotencyKey(fields);
    const key2 = computeIdempotencyKey(fields);
    assert.equal(key1, key2);
  });

  it('different canonical fields → different key', () => {
    const fields1: CanonicalFields = {
      fields: ['chainId', 'to', 'amount'],
      canonical: 'erc20.transfer@1.0.0|8453|0xabc|1000000',
    };
    const fields2: CanonicalFields = {
      fields: ['chainId', 'to', 'amount'],
      canonical: 'erc20.transfer@1.0.0|8453|0xabc|2000000',
    };
    const key1 = computeIdempotencyKey(fields1);
    const key2 = computeIdempotencyKey(fields2);
    assert.notEqual(key1, key2);
  });

  it('key is 64 hex chars (SHA-256)', () => {
    const fields: CanonicalFields = {
      fields: ['chainId', 'to', 'amount'],
      canonical: 'erc20.transfer@1.0.0|8453|0xabc|1000000',
    };
    const key = computeIdempotencyKey(fields);
    assert.equal(key.length, 64);
    assert.match(key, /^[0-9a-f]{64}$/);
  });

  it('deadline bucket format is correct (ISO truncated to hour)', () => {
    const date = new Date('2026-08-08T12:34:56.789Z');
    const bucket = deadlineBucket(date);
    assert.equal(bucket, '2026-08-08T12');
    assert.equal(bucket.length, 13);
  });

  it('refund key is different from execution key', () => {
    const canonical: CanonicalFields = {
      fields: ['chainId', 'to', 'amount'],
      canonical: 'erc20.transfer@1.0.0|8453|0xabc|1000000',
    };
    const executionKey = computeIdempotencyKey(canonical);
    const refundKey = deriveRefundIdempotencyKey('q_abc123', '0xtxhash', '1000000');
    assert.notEqual(executionKey, refundKey);
    // Refund key is also 64 hex
    assert.equal(refundKey.length, 64);
    assert.match(refundKey, /^[0-9a-f]{64}$/);
  });

  it('escapeCanonicalField handles pipe and percent', () => {
    assert.equal(escapeCanonicalField('hello|world'), 'hello%7Cworld');
    assert.equal(escapeCanonicalField('100%'), '100%25');
    assert.equal(escapeCanonicalField('a|b%c'), 'a%7Cb%25c');
    assert.equal(escapeCanonicalField('no-special'), 'no-special');
  });

  it('canonicalAmount rejects negative values', () => {
    assert.throws(() => canonicalAmount(-1n), /non-negative/);
    assert.throws(() => canonicalAmount('-1'), /non-negative/);

    // Valid amounts work
    assert.equal(canonicalAmount(0n), '0');
    assert.equal(canonicalAmount(1000000n), '1000000');
    assert.equal(canonicalAmount('999'), '999');
  });
});
