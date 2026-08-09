import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from 'decimal.js';
import type { PublicClient } from 'viem';
import { assertPriceWithinDivergence, readNativeAssetUsd } from '../../src/quoter/fx.ts';

function oracleClient(updatedAt: number, answeredInRound = 10n): PublicClient {
  let call = 0;
  return {
    readContract: async () => {
      call++;
      return call === 1 ? 8 : [10n, 250_000_000_000n, 0n, BigInt(updatedAt), answeredInRound];
    },
  } as unknown as PublicClient;
}

describe('quoter/fx fail-closed validation', () => {
  it('rejects stale Chainlink prices', async () => {
    await assert.rejects(
      readNativeAssetUsd(oracleClient(Math.floor(Date.now() / 1000) - 3601), 8453, { maxStalenessSeconds: 3600 }),
      /price stale/,
    );
  });

  it('rejects incomplete Chainlink rounds', async () => {
    await assert.rejects(readNativeAssetUsd(oracleClient(Math.floor(Date.now() / 1000), 9n), 8453), /incomplete round/);
  });

  it('rejects excessive divergence from an independent reference', () => {
    assert.throws(() => assertPriceWithinDivergence(new Decimal('3000'), new Decimal('2500'), 500), /divergence/);
    assert.ok(assertPriceWithinDivergence(new Decimal('2525'), new Decimal('2500'), 500).eq(100));
  });
});
