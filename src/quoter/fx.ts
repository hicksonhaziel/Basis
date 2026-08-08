/**
 * Chainlink Native Asset / USD Price Feed Reader.
 *
 * Reads the latest ETH/USD price from Chainlink aggregator contracts on-chain.
 * Uses viem to make a direct contract call — no API key needed.
 *
 * The Chainlink aggregator returns:
 * - answer: int256 (price with 8 decimal places for ETH/USD)
 * - updatedAt: uint256 (timestamp of the last update)
 *
 * We validate staleness: if the price is older than maxStalenessSeconds,
 * we throw rather than using a stale price.
 */

import { type PublicClient } from 'viem';
import { Decimal } from 'decimal.js';
import { getChain } from '../config/chains.ts';

// ─── Chainlink ABI (only what we need) ──────────────────────────────────────

const AGGREGATOR_V3_ABI = [
  {
    name: 'latestRoundData',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChainlinkPrice {
  /** Price as a Decimal (e.g. 3124.22) */
  priceUsd: Decimal;
  /** Raw answer from the contract */
  rawAnswer: bigint;
  /** Number of decimals in the raw answer */
  decimals: number;
  /** When the price was last updated (unix timestamp) */
  updatedAt: number;
  /** The round ID */
  roundId: bigint;
  /** Chain ID this was read from */
  chainId: number;
}

export interface ChainlinkOptions {
  /** Maximum staleness in seconds before throwing (default: 3600 = 1 hour) */
  maxStalenessSeconds?: number;
}

// ─── Reader ──────────────────────────────────────────────────────────────────

/**
 * Read the latest ETH/USD price from Chainlink.
 *
 * @param client - viem PublicClient connected to the correct chain
 * @param chainId - which chain to read from (determines feed address)
 * @param options - staleness check configuration
 */
export async function readNativeAssetUsd(
  client: PublicClient,
  chainId: number,
  options: ChainlinkOptions = {},
): Promise<ChainlinkPrice> {
  const { maxStalenessSeconds = 3600 } = options;
  const chain = getChain(chainId);
  const feedAddress = chain.chainlinkEthUsd;

  // Read decimals
  const feedDecimals = await client.readContract({
    address: feedAddress,
    abi: AGGREGATOR_V3_ABI,
    functionName: 'decimals',
  });

  // Read latest round data
  const [roundId, answer, , updatedAt] = await client.readContract({
    address: feedAddress,
    abi: AGGREGATOR_V3_ABI,
    functionName: 'latestRoundData',
  });

  // Validate non-zero answer
  if (answer <= 0n) {
    throw new Error(`Chainlink returned non-positive price: ${answer} on chain ${chainId}`);
  }

  // Validate staleness
  const now = Math.floor(Date.now() / 1000);
  const age = now - Number(updatedAt);
  if (age > maxStalenessSeconds) {
    throw new Error(
      `Chainlink price stale: ${age}s old (max ${maxStalenessSeconds}s) on chain ${chainId}`,
    );
  }

  // Convert to Decimal
  const priceUsd = new Decimal(answer.toString()).div(
    new Decimal(10).pow(Number(feedDecimals)),
  );

  return {
    priceUsd,
    rawAnswer: answer,
    decimals: Number(feedDecimals),
    updatedAt: Number(updatedAt),
    roundId,
    chainId,
  };
}

/**
 * Create a ChainlinkPrice from known values (for testing / offline use).
 * Skips staleness validation.
 */
export function buildChainlinkPrice(
  priceUsd: string | number,
  chainId: number = 8453,
): ChainlinkPrice {
  const price = new Decimal(priceUsd);
  const decimals = 8;
  const rawAnswer = BigInt(price.mul(new Decimal(10).pow(decimals)).toFixed(0));

  return {
    priceUsd: price,
    rawAnswer,
    decimals,
    updatedAt: Math.floor(Date.now() / 1000),
    roundId: 0n,
    chainId,
  };
}
