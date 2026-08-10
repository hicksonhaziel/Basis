/** Fail-closed runtime configuration for Basis. */

import { REFUND_POLICY_ID, REFUND_TOKEN_ADDRESS } from './policy.ts';

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
  paidWorkflowCredentials: {
    'basis-order-t1': string;
    'basis-order-t2': string;
    'basis-order-t3': string;
    'basis-order-t4': string;
  };
  erc20TransferAllowlist: Erc20TransferAllowance[];
  environment: 'local' | 'testnet' | 'production';
  oracleMaxStalenessSeconds: number;
  oracleMaxDivergenceBps: number;
  oracleReference?: { priceUsd: string; updatedAt: number };
  allowTestFxFallback: boolean;
  testFxFallbackUsd?: string;
  refundsEnabled: boolean;
  refundPolicyId: typeof REFUND_POLICY_ID;
  refundWallet?: `0x${string}`;
  refundMinimumConfirmations: number;
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

  const paidWorkflowCredentials = {
    'basis-order-t1': required('BASIS_ORDER_T1_SECRET'),
    'basis-order-t2': required('BASIS_ORDER_T2_SECRET'),
    'basis-order-t3': required('BASIS_ORDER_T3_SECRET'),
    'basis-order-t4': required('BASIS_ORDER_T4_SECRET'),
  };
  for (const [tier, secret] of Object.entries(paidWorkflowCredentials)) {
    if (Buffer.byteLength(secret) < 32) throw new Error(`${tier} secret must contain at least 32 bytes`);
    if (secret === basisSigningKey) throw new Error(`${tier} secret must differ from BASIS_SIGNING_KEY`);
  }
  if (new Set(Object.values(paidWorkflowCredentials)).size !== 4) throw new Error('Paid workflow secrets must be distinct');

  const positiveInteger = (key: string, fallback: string): number => {
    const value = Number(optional(key, fallback));
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
    return value;
  };
  const oracleMaxStalenessSeconds = positiveInteger('ORACLE_MAX_STALENESS_SECONDS', '3600');
  const oracleMaxDivergenceBps = positiveInteger('ORACLE_MAX_DIVERGENCE_BPS', '500');
  const referencePrice = source['ORACLE_REFERENCE_ETH_USD'];
  const referenceUpdatedAt = source['ORACLE_REFERENCE_UPDATED_AT'];
  let oracleReference: BasisEnv['oracleReference'];
  if (referencePrice || referenceUpdatedAt) {
    if (!referencePrice || !referenceUpdatedAt || !/^\d+(\.\d+)?$/.test(referencePrice)) throw new Error('Oracle reference price and timestamp must both be valid');
    const updatedAt = Number(referenceUpdatedAt);
    if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) throw new Error('ORACLE_REFERENCE_UPDATED_AT must be a unix timestamp');
    oracleReference = { priceUsd: referencePrice, updatedAt };
  }
  if (environment === 'production' && !oracleReference) throw new Error('Production requires an independent oracle reference price and timestamp');
  const allowTestFxFallback = source['ALLOW_TEST_FX_FALLBACK'] === 'true';
  if (environment === 'production' && allowTestFxFallback) throw new Error('Production cannot enable test FX fallback');
  const testFxFallbackUsd = source['TEST_FX_FALLBACK_USD'];
  if (allowTestFxFallback && (!testFxFallbackUsd || !/^\d+(\.\d+)?$/.test(testFxFallbackUsd))) throw new Error('Explicit test FX fallback requires TEST_FX_FALLBACK_USD');
  const refundsEnabled = source['BASIS_REFUNDS_ENABLED'] === 'true';
  let refundWallet: `0x${string}` | undefined;
  if (refundsEnabled) {
    if (source['BASIS_REFUND_POLICY_ID'] !== REFUND_POLICY_ID) throw new Error(`BASIS_REFUND_POLICY_ID must equal ${REFUND_POLICY_ID}`);
    if (source['BASE_USDC_ADDRESS']?.toLowerCase() !== REFUND_TOKEN_ADDRESS) throw new Error('BASE_USDC_ADDRESS must match canonical Base USDC policy');
    if (!source['RPC_URL_BASE']) throw new Error('Refund broadcasting requires explicit RPC_URL_BASE for independent verification');
    const wallet = source['KEEPERHUB_WALLET_ADDRESS'];
    if (!wallet || !ADDRESS.test(wallet)) throw new Error('Refund broadcasting requires valid KEEPERHUB_WALLET_ADDRESS');
    refundWallet = wallet.toLowerCase() as `0x${string}`;
  }
  const refundMinimumConfirmations = positiveInteger('BASIS_REFUND_MIN_CONFIRMATIONS', '1');

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
    paidWorkflowCredentials,
    erc20TransferAllowlist: parseErc20Allowlist(source['ERC20_TRANSFER_ALLOWLIST']),
    environment: environment as BasisEnv['environment'],
    oracleMaxStalenessSeconds,
    oracleMaxDivergenceBps,
    oracleReference,
    allowTestFxFallback,
    testFxFallbackUsd,
    refundsEnabled,
    refundPolicyId: REFUND_POLICY_ID,
    refundWallet,
    refundMinimumConfirmations,
  };
}
