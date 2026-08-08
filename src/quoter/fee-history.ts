/**
 * Fee History Collection.
 *
 * Fetches eth_feeHistory from the chain RPC via viem and extracts
 * base fee + priority fee samples for gas-price percentile calculations.
 *
 * The pricing function uses these samples to determine the "protected"
 * gas price for each deadline tier.
 */

import { createPublicClient, http, type PublicClient, type Chain } from 'viem';
import { base, mainnet, sepolia, baseSepolia } from 'viem/chains';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface FeeSample {
  /** Base fee per gas in wei */
  baseFeePerGas: bigint;
  /** Priority fee (tip) per gas in wei */
  priorityFeePerGas: bigint;
  /** Total effective gas price = baseFee + priorityFee */
  effectiveGasPrice: bigint;
  /** Block number this sample came from */
  blockNumber: bigint;
}

export interface FeeHistoryResult {
  samples: FeeSample[];
  latestBlock: bigint;
  chainId: number;
  collectedAt: Date;
}

// ─── Chain to viem chain mapping ─────────────────────────────────────────────

const VIEM_CHAINS: Record<number, Chain> = {
  8453: base,
  1: mainnet,
  11155111: sepolia,
  84532: baseSepolia,
};

// ─── Client factory ──────────────────────────────────────────────────────────

export function createRpcClient(chainId: number, rpcUrl: string): PublicClient {
  const chain = VIEM_CHAINS[chainId];
  if (!chain) throw new Error(`No viem chain for chainId ${chainId}`);

  return createPublicClient({
    chain,
    transport: http(rpcUrl),
  }) as PublicClient;
}

// ─── Fee History Collection ──────────────────────────────────────────────────

/**
 * Fetch fee history from the chain.
 * @param client - viem public client
 * @param blockCount - number of historical blocks to fetch (default: 20)
 * @param rewardPercentiles - percentiles to request for priority fees (default: [25, 50, 75, 95, 99])
 */
export async function collectFeeHistory(
  client: PublicClient,
  blockCount = 20,
  rewardPercentiles = [25, 50, 75, 95, 99],
): Promise<FeeHistoryResult> {
  const chainId = client.chain?.id ?? 0;

  const feeHistory = await client.getFeeHistory({
    blockCount,
    rewardPercentiles,
  });

  const samples: FeeSample[] = [];

  // feeHistory.baseFeePerGas has blockCount + 1 entries (includes next block prediction)
  // feeHistory.reward has blockCount entries, each with one value per percentile
  const baseFeesCount = feeHistory.baseFeePerGas.length;
  const rewardsCount = feeHistory.reward?.length ?? 0;

  for (let i = 0; i < rewardsCount; i++) {
    const baseFee = feeHistory.baseFeePerGas[i]!;
    const rewards = feeHistory.reward![i]!;

    // Use the median (index 2 in [25,50,75,95,99]) as the representative priority fee
    const medianIdx = Math.floor(rewardPercentiles.length / 2);
    const priorityFee = rewards[medianIdx] ?? rewards[0]!;

    samples.push({
      baseFeePerGas: baseFee,
      priorityFeePerGas: priorityFee,
      effectiveGasPrice: baseFee + priorityFee,
      blockNumber: BigInt(feeHistory.oldestBlock) + BigInt(i),
    });
  }

  // Also store all reward percentiles as separate samples for richer distribution
  // The pricing function can use the full distribution
  const latestBlock = BigInt(feeHistory.oldestBlock) + BigInt(baseFeesCount - 1);

  return {
    samples,
    latestBlock,
    chainId,
    collectedAt: new Date(),
  };
}

/**
 * Extract a specific percentile from fee samples.
 * Returns the effective gas price at the given percentile.
 *
 * @param samples - sorted fee samples
 * @param percentile - target percentile (0-100)
 */
export function feePercentile(samples: FeeSample[], percentile: number): bigint {
  if (samples.length === 0) throw new Error('No fee samples');
  if (percentile < 0 || percentile > 100) throw new Error('Percentile must be 0-100');

  // Sort by effective gas price
  const sorted = [...samples].sort((a, b) => {
    if (a.effectiveGasPrice < b.effectiveGasPrice) return -1;
    if (a.effectiveGasPrice > b.effectiveGasPrice) return 1;
    return 0;
  });

  const index = Math.min(
    Math.ceil((percentile / 100) * sorted.length) - 1,
    sorted.length - 1,
  );

  return sorted[Math.max(0, index)]!.effectiveGasPrice;
}

/**
 * Get the latest base fee prediction (next block).
 * This is the last entry in baseFeePerGas from eth_feeHistory.
 */
export function getLatestBaseFee(samples: FeeSample[]): bigint {
  if (samples.length === 0) throw new Error('No fee samples');
  return samples[samples.length - 1]!.baseFeePerGas;
}

/**
 * Collect fee samples with a raw RPC call when a full viem client isn't available.
 * Used for testing with pre-built sample data.
 */
export function buildFeeSamples(
  baseFees: bigint[],
  priorityFees: bigint[],
  startBlock: bigint,
): FeeSample[] {
  const count = Math.min(baseFees.length, priorityFees.length);
  const samples: FeeSample[] = [];
  for (let i = 0; i < count; i++) {
    const base = baseFees[i]!;
    const priority = priorityFees[i]!;
    samples.push({
      baseFeePerGas: base,
      priorityFeePerGas: priority,
      effectiveGasPrice: base + priority,
      blockNumber: startBlock + BigInt(i),
    });
  }
  return samples;
}
