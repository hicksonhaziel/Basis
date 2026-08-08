/**
 * Basis environment configuration.
 * Loads from process.env — no .env file parsing library needed in Node 22.
 */

export interface BasisEnv {
  keeperHubApiKey: string;
  keeperHubBaseUrl: string;
  rpcUrls: Record<number, string>;
  basisSigningKey: string;
  environment: 'local' | 'testnet' | 'production';
}

export function loadEnv(): BasisEnv {
  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env: ${key}`);
    return val;
  };

  const optional = (key: string, fallback: string): string =>
    process.env[key] ?? fallback;

  return {
    keeperHubApiKey: required('KEEPERHUB_API_KEY'),
    keeperHubBaseUrl: optional('KEEPERHUB_BASE_URL', 'https://api.keeperhub.com'),
    rpcUrls: {
      8453: optional('RPC_URL_BASE', 'https://mainnet.base.org'),
      1: optional('RPC_URL_ETHEREUM', 'https://eth.llamarpc.com'),
      84532: optional('RPC_URL_BASE_SEPOLIA', 'https://sepolia.base.org'),
      11155111: optional('RPC_URL_SEPOLIA', 'https://rpc.sepolia.org'),
    },
    basisSigningKey: required('BASIS_SIGNING_KEY'),
    environment: (optional('BASIS_ENV', 'testnet') as BasisEnv['environment']),
  };
}
