/**
 * Basis Historical Fee Backtest
 *
 * Collects real eth_feeHistory from Base mainnet and replays the pricing function
 * across many blocks to measure:
 * - Deadline tier coverage rate (would the protected price have been enough?)
 * - Overpricing distribution (how much extra did we charge vs actual?)
 * - Underpricing events (times actual exceeded our protected price)
 * - Margin distribution by tier
 */

import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { Decimal } from 'decimal.js';
import { priceQuote } from '../src/quoter/price.ts';
import { buildFeeSamples, feePercentile } from '../src/quoter/fee-history.ts';
import { DEADLINE_TIERS, RETRY_PREMIUM_BPS, TARGET_MARGIN_BPS, FIXED_OVERHEAD_USD, PRICING_MODEL_VERSION } from '../src/config/policy.ts';
import { writeFileSync } from 'fs';

const RPC_URL = process.env.RPC_URL_BASE || 'https://mainnet.base.org';
const GAS_ESTIMATE = 46000n; // Typical WETH wrap
const ETH_USD = new Decimal('3100');

async function main() {
  const client = createPublicClient({ chain: base, transport: http(RPC_URL) });

  console.log('=== Basis Historical Fee Backtest ===');
  console.log('Chain: Base mainnet');
  console.log('Gas estimate: 46,000 (WETH wrap)');
  console.log('ETH/USD: $3,100 (fixed for consistency)');
  console.log('');

  // Fetch fee history — 1024 blocks (max for eth_feeHistory)
  console.log('Fetching fee history (1024 blocks)...');
  const feeHistory = await client.getFeeHistory({
    blockCount: 1024,
    rewardPercentiles: [25, 50, 75, 95, 99],
  });

  const blockCount = feeHistory.reward?.length ?? 0;
  console.log(`Got ${blockCount} blocks of data`);
  console.log('');

  // Build samples
  const allSamples = [];
  for (let i = 0; i < blockCount; i++) {
    const baseFee = feeHistory.baseFeePerGas[i]!;
    const priority = feeHistory.reward![i]![2]!; // P75 priority
    allSamples.push({
      baseFeePerGas: baseFee,
      priorityFeePerGas: priority,
      effectiveGasPrice: baseFee + priority,
      blockNumber: BigInt(feeHistory.oldestBlock) + BigInt(i),
    });
  }

  // Sliding window backtest: for each block, use the previous 20 blocks as history,
  // price a quote, then check if the NEXT block's actual fee was covered
  const tiers = ['next-block', '5m', '1h', 'best-effort'] as const;
  const results: Record<string, { covered: number; total: number; overpriceRatios: number[] }> = {};
  for (const t of tiers) results[t] = { covered: 0, total: 0, overpriceRatios: [] };

  const windowSize = 20;
  const testBlocks = blockCount - windowSize - 1;

  console.log(`Replaying ${testBlocks} blocks...`);

  for (let i = windowSize; i < blockCount - 1; i++) {
    const historySamples = allSamples.slice(i - windowSize, i);
    const actualNextFee = allSamples[i + 1]!.effectiveGasPrice;

    for (const tier of tiers) {
      const policy = DEADLINE_TIERS[tier];
      const protectedPrice = feePercentile(historySamples, policy.feePercentile);

      results[tier]!.total++;

      if (protectedPrice >= actualNextFee) {
        results[tier]!.covered++;
        // Overprice ratio: how much extra we charged
        const ratio = actualNextFee > 0n
          ? Number(protectedPrice - actualNextFee) / Number(actualNextFee)
          : 0;
        results[tier]!.overpriceRatios.push(ratio);
      }
      // else: underpriced — actual exceeded our protection
    }
  }

  // Compute percentiles for overpricing
  function percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(Math.ceil(p / 100 * sorted.length) - 1, sorted.length - 1);
    return sorted[Math.max(0, idx)]!;
  }

  // Report
  console.log('');
  console.log('=== RESULTS ===');
  console.log(`Blocks tested: ${testBlocks}`);
  console.log('');
  console.log('Tier          | Coverage | Underprice | Overprice P50 | Overprice P95');
  console.log('──────────────┼──────────┼────────────┼───────────────┼──────────────');

  const report: Record<string, unknown> = { blocks: testBlocks, chain: 'base', tiers: {} };

  for (const tier of tiers) {
    const r = results[tier]!;
    const coverage = (r.covered / r.total * 100).toFixed(1);
    const underprice = r.total - r.covered;
    const op50 = (percentile(r.overpriceRatios, 50) * 100).toFixed(1);
    const op95 = (percentile(r.overpriceRatios, 95) * 100).toFixed(1);

    console.log(`${tier.padEnd(14)}| ${coverage.padStart(6)}% | ${String(underprice).padStart(10)} | ${op50.padStart(11)}% | ${op95.padStart(11)}%`);

    (report.tiers as Record<string, unknown>)[tier] = {
      coverage: parseFloat(coverage),
      underpriceCount: underprice,
      overpriceP50: parseFloat(op50),
      overpriceP95: parseFloat(op95),
      total: r.total,
    };
  }

  // Save report
  writeFileSync('evidence/backtest-report.json', JSON.stringify(report, null, 2));
  console.log('');
  console.log('Report saved to evidence/backtest-report.json');
}

main().catch(err => { console.error(err); process.exit(1); });
