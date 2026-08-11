/** Chain-pinned, value-capped WETH wrap adapter. */
import { encodeFunctionData } from 'viem';
import type { JobAdapter, AdapterMeta, CallParams, SimulationParams, CanonicalFields, PostconditionCheck, PostconditionReceipt } from './adapter.ts';

export interface WethWrapParams { chainId: number; weth: `0x${string}`; amount: bigint; }
export const WETH_ADDRESSES: Record<number, `0x${string}`> = {
  1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  8453: '0x4200000000000000000000000000000000000006',
  11155111: '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9',
  84532: '0x4200000000000000000000000000000000000006',
};
export const MAX_WETH_AMOUNT_WEI = 10_000_000_000_000_000n; // 0.01 ETH
const ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [], outputs: [] },
  { name: 'Deposit', type: 'event', inputs: [{ name: 'dst', type: 'address', indexed: true }, { name: 'wad', type: 'uint256', indexed: false }] },
] as const;
const meta: AdapterMeta = { jobType: 'weth.wrap', version: '1.1.0', description: 'Wrap capped native ETH using chain-pinned WETH', mode: 'permissionless', maxGasEstimate: 60_000n, sendsNativeValue: true, supportedChains: Object.keys(WETH_ADDRESSES).map(Number) };

export function weiToEtherString(wei: bigint): string {
  const whole = wei / 1_000_000_000_000_000_000n;
  const fraction = (wei % 1_000_000_000_000_000_000n).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export const wethWrapAdapter: JobAdapter<WethWrapParams> = {
  meta,
  validateParams(raw: unknown, chainId?: number): WethWrapParams {
    if (!raw || typeof raw !== 'object') throw new Error('weth.wrap: params must be an object');
    const p = raw as Record<string, unknown>;
    if ('weth' in p) throw new Error('weth.wrap: caller-selected WETH address is not allowed');
    if (!chainId || !WETH_ADDRESSES[chainId]) throw new Error(`weth.wrap: unsupported chain ${chainId}`);
    let amount: bigint;
    try { amount = typeof p.amount === 'bigint' ? p.amount : typeof p.amount === 'string' && /^\d+$/.test(p.amount) ? BigInt(p.amount) : 0n; }
    catch { amount = 0n; }
    if (amount <= 0n) throw new Error('weth.wrap: amount must be a positive atomic-unit string or bigint');
    if (amount > MAX_WETH_AMOUNT_WEI) throw new Error(`weth.wrap: amount exceeds maximum ${MAX_WETH_AMOUNT_WEI}`);
    return { chainId, weth: WETH_ADDRESSES[chainId]!, amount };
  },
  validatePersistedParams(raw: unknown, chainId: number): WethWrapParams {
    if (!raw || typeof raw !== 'object') throw new Error('weth.wrap: persisted params must be an object');
    const p = raw as Record<string, unknown>; const pinned = WETH_ADDRESSES[chainId];
    if (!pinned || typeof p.weth !== 'string' || p.weth.toLowerCase() !== pinned.toLowerCase() || p.chainId !== chainId) throw new Error('weth.wrap: persisted chain-pinned policy fields mismatch');
    return wethWrapAdapter.validateParams({ amount: p.amount }, chainId);
  },
  buildCall(params, executorAddress): CallParams { return { to: params.weth, data: encodeFunctionData({ abi: ABI, functionName: 'deposit' }), value: params.amount, from: executorAddress }; },
  buildSimulation(params): SimulationParams { return { contractAddress: params.weth, functionName: 'deposit', abi: JSON.stringify(ABI), value: weiToEtherString(params.amount) }; },
  canonicalIntent(params, chainId, bucket): CanonicalFields { const canonical = [`weth.wrap@${meta.version}`, chainId, params.weth.toLowerCase(), 'deposit', '', params.amount, params.amount, bucket].join('|'); return { fields: ['adapterVersion','chainId','weth','functionSelector','recipient','amount','valueWei','deadlineBucket'], canonical }; },
  verifyPostconditions(params, receipt: PostconditionReceipt): PostconditionCheck[] { const log = receipt.logs.find((l) => l.eventName === 'Deposit' && l.address.toLowerCase() === params.weth.toLowerCase() && String(l.args['dst']).toLowerCase() === receipt.executorAddress.toLowerCase()); const checks: PostconditionCheck[] = [{ passed: !!log, check: 'Deposit event emitted by pinned WETH contract', detail: log ? `Deposit wad: ${log.args['wad']}` : 'No Deposit event found' }]; if (log) checks.push({ passed: BigInt(log.args['wad'] as string | bigint) === params.amount, check: 'Deposited amount matches requested amount' }); return checks; },
  describe: (params) => `WETH wrap: ${params.amount} wei on chain ${params.chainId}`,
};
