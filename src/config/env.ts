/** Fail-closed runtime configuration for Basis. */

export interface Erc20TransferAllowance {
  chainId: number;
  token: `0x${string}`;
  recipient: `0x${string}`;
  maxAmount: bigint;
}

export interface BasisEnv {
  keeperHubApiKey: string;
  keeperHubBaseUrl: string;
  rpcUrls: Record<number, string>;
  basisSigningKey: string;
  orderIngressSecret: string;
  erc20TransferAllowlist: Erc20TransferAllowance[];
  environment: 'local' | 'testnet' | 'production';
}

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const ENVIRONMENTS = new Set(['local', 'testnet', 'production']);

function parseErc20Allowlist(value: string | undefined): Erc20TransferAllowance[] {
  if (!value) return [];
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { throw new Error('ERC20_TRANSFER_ALLOWLIST must be valid JSON'); }
  if (!Array.isArray(raw)) throw new Error('ERC20_TRANSFER_ALLOWLIST must be a JSON array');

  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`ERC20_TRANSFER_ALLOWLIST[${index}] must be an object`);
    const item = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(item.chainId) || (item.chainId as number) <= 0) throw new Error(`ERC20_TRANSFER_ALLOWLIST[${index}].chainId is invalid`);
    if (typeof item.token !== 'string' || !ADDRESS.test(item.token)) throw new Error(`ERC20_TRANSFER_ALLOWLIST[${index}].token is invalid`);
    if (typeof item.recipient !== 'string' || !ADDRESS.test(item.recipient)) throw new Error(`ERC20_TRANSFER_ALLOWLIST[${index}].recipient is invalid`);
    if (typeof item.maxAmount !== 'string' || !/^\d+$/.test(item.maxAmount) || BigInt(item.maxAmount) <= 0n) {
      throw new Error(`ERC20_TRANSFER_ALLOWLIST[${index}].maxAmount must be a positive atomic-unit string`);
    }
    return {
      chainId: item.chainId as number,
      token: item.token.toLowerCase() as `0x${string}`,
      recipient: item.recipient.toLowerCase() as `0x${string}`,
      maxAmount: BigInt(item.maxAmount),
    };
  });
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): BasisEnv {
  const required = (key: string): string => {
    const val = source[key];
    if (!val) throw new Error(`Missing required env: ${key}`);
    return val;
  };
  const optional = (key: string, fallback: string): string => source[key] ?? fallback;

  const environment = optional('BASIS_ENV', 'testnet');
  if (!ENVIRONMENTS.has(environment)) throw new Error(`Invalid BASIS_ENV: ${environment}`);

  const basisSigningKey = required('BASIS_SIGNING_KEY');
  if (basisSigningKey.length < 32) throw new Error('BASIS_SIGNING_KEY must be at least 32 characters');

  const orderIngressSecret = required('ORDER_INGRESS_SECRET');
  if (orderIngressSecret.length < 32) throw new Error('ORDER_INGRESS_SECRET must be at least 32 characters');
  if (orderIngressSecret === basisSigningKey) throw new Error('ORDER_INGRESS_SECRET must differ from BASIS_SIGNING_KEY');

  return {
    keeperHubApiKey: required('KEEPERHUB_API_KEY'),
    keeperHubBaseUrl: optional('KEEPERHUB_BASE_URL', 'https://api.keeperhub.com'),
    rpcUrls: {
      8453: optional('RPC_URL_BASE', 'https://mainnet.base.org'),
      1: optional('RPC_URL_ETHEREUM', 'https://eth.llamarpc.com'),
      84532: optional('RPC_URL_BASE_SEPOLIA', 'https://sepolia.base.org'),
      11155111: optional('RPC_URL_SEPOLIA', 'https://rpc.sepolia.org'),
    },
    basisSigningKey,
    orderIngressSecret,
    erc20TransferAllowlist: parseErc20Allowlist(source['ERC20_TRANSFER_ALLOWLIST']),
    environment: environment as BasisEnv['environment'],
  };
}
