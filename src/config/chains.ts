/**
 * Chain definitions.
 * Maps chain IDs to names, native asset, Chainlink feed addresses, and block times.
 */

export interface ChainConfig {
  chainId: number;
  name: string;
  nativeAsset: string;
  /** Chainlink ETH/USD aggregator proxy address */
  chainlinkEthUsd: `0x${string}`;
  /** Average block time in seconds */
  blockTimeSeconds: number;
  /** Whether this chain is a testnet */
  testnet: boolean;
}

export const CHAINS: Record<number, ChainConfig> = {
  1: {
    chainId: 1,
    name: 'ethereum',
    nativeAsset: 'ETH',
    chainlinkEthUsd: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    blockTimeSeconds: 12,
    testnet: false,
  },
  8453: {
    chainId: 8453,
    name: 'base',
    nativeAsset: 'ETH',
    chainlinkEthUsd: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
    blockTimeSeconds: 2,
    testnet: false,
  },
  11155111: {
    chainId: 11155111,
    name: 'sepolia',
    nativeAsset: 'ETH',
    chainlinkEthUsd: '0x694AA1769357215DE4FAC081bf1f309aDC325306',
    blockTimeSeconds: 12,
    testnet: true,
  },
  84532: {
    chainId: 84532,
    name: 'base-sepolia',
    nativeAsset: 'ETH',
    chainlinkEthUsd: '0x4aDC67D69a6e06BB41A67C8Ca8E9e0f523aB8c0A',
    blockTimeSeconds: 2,
    testnet: true,
  },
};

export function getChain(chainId: number): ChainConfig {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`Unsupported chain: ${chainId}`);
  return chain;
}
