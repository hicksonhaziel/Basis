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
  /** Independently supplied reference price used to reject excessive divergence. */
  referencePriceUsd?: Decimal;
  /** Maximum absolute divergence from the independent reference (default: 500 = 5%). */
  maxDivergenceBps?: number;
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
  const { maxStalenessSeconds = 3600, referencePriceUsd, maxDivergenceBps = 500 } = options;
  const chain = getChain(chainId);
  const feedAddress = chain.chainlinkEthUsd;

  // Read decimals
  const feedDecimals = await client.readContract({
    address: feedAddress,
    abi: AGGREGATOR_V3_ABI,
    functionName: 'decimals',
  });

  // Read latest round data
  const [roundId, answer, , updatedAt, answeredInRound] = await client.readContract({
    address: feedAddress,
    abi: AGGREGATOR_V3_ABI,
    functionName: 'latestRoundData',
  });

  // Validate non-zero answer
  if (answer <= 0n) {
    throw new Error(`Chainlink returned non-positive price: ${answer} on chain ${chainId}`);
  }

  if (updatedAt === 0n || answeredInRound < roundId) {
    throw new Error(`Chainlink returned incomplete round ${roundId} on chain ${chainId}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const age = now - Number(updatedAt);
  if (age < 0) throw new Error(`Chainlink price timestamp is in the future on chain ${chainId}`);
  if (age > maxStalenessSeconds) {
    throw new Error(
      `Chainlink price stale: ${age}s old (max ${maxStalenessSeconds}s) on chain ${chainId}`,
    );
  }

  // Convert to Decimal
  const priceUsd = new Decimal(answer.toString()).div(
    new Decimal(10).pow(Number(feedDecimals)),
  );
  if (referencePriceUsd) assertPriceWithinDivergence(priceUsd, referencePriceUsd, maxDivergenceBps);

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

export function assertPriceWithinDivergence(
  primary: Decimal,
  reference: Decimal,
  maxDivergenceBps: number,
): Decimal {
  if (!primary.isPositive() || !reference.isPositive()) throw new Error('Oracle prices must be positive');
  if (!Number.isInteger(maxDivergenceBps) || maxDivergenceBps < 0) throw new Error('Invalid maximum oracle divergence');
  const divergenceBps = primary.sub(reference).abs().div(reference).mul(10_000);
  if (divergenceBps.gt(maxDivergenceBps)) {
    throw new Error(`Oracle price divergence ${divergenceBps.toFixed(2)}bps exceeds ${maxDivergenceBps}bps`);
  }
  return divergenceBps;
}
