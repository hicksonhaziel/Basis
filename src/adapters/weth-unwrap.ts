/** Chain-pinned, amount-capped WETH unwrap adapter. */
import { encodeFunctionData } from 'viem';
import type { JobAdapter, AdapterMeta, CallParams, SimulationParams, CanonicalFields, PostconditionCheck, PostconditionReceipt } from './adapter.ts';
import { WETH_ADDRESSES, MAX_WETH_AMOUNT_WEI } from './weth-wrap.ts';
export interface WethUnwrapParams { chainId: number; weth: `0x${string}`; amount: bigint; }
const ABI = [
  { name: 'withdraw', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'wad', type: 'uint256' }], outputs: [] },
  { name: 'Withdrawal', type: 'event', inputs: [{ name: 'src', type: 'address', indexed: true }, { name: 'wad', type: 'uint256', indexed: false }] },
] as const;
const meta: AdapterMeta = { jobType: 'weth.unwrap', version: '1.1.0', description: 'Unwrap capped WETH using chain-pinned contract', mode: 'permissionless', maxGasEstimate: 60_000n, sendsNativeValue: false, supportedChains: Object.keys(WETH_ADDRESSES).map(Number) };
export const wethUnwrapAdapter: JobAdapter<WethUnwrapParams> = {
  meta,
  validateParams(raw: unknown, chainId?: number): WethUnwrapParams {
    if (!raw || typeof raw !== 'object') throw new Error('weth.unwrap: params must be an object');
    const p = raw as Record<string, unknown>;
    if ('weth' in p) throw new Error('weth.unwrap: caller-selected WETH address is not allowed');
    if (!chainId || !WETH_ADDRESSES[chainId]) throw new Error(`weth.unwrap: unsupported chain ${chainId}`);
    let amount: bigint;
    try { amount = typeof p.amount === 'bigint' ? p.amount : typeof p.amount === 'string' && /^\d+$/.test(p.amount) ? BigInt(p.amount) : 0n; } catch { amount = 0n; }
    if (amount <= 0n) throw new Error('weth.unwrap: amount must be a positive atomic-unit string or bigint');
    if (amount > MAX_WETH_AMOUNT_WEI) throw new Error(`weth.unwrap: amount exceeds maximum ${MAX_WETH_AMOUNT_WEI}`);
    return { chainId, weth: WETH_ADDRESSES[chainId]!, amount };
  },
  buildCall(params, executorAddress): CallParams { return { to: params.weth, data: encodeFunctionData({ abi: ABI, functionName: 'withdraw', args: [params.amount] }), value: 0n, from: executorAddress }; },
  buildSimulation(params): SimulationParams { return { contractAddress: params.weth, functionName: 'withdraw', functionArgs: JSON.stringify([params.amount.toString()]), abi: JSON.stringify(ABI) }; },
  canonicalIntent(params, chainId, bucket): CanonicalFields { return { fields: ['adapterVersion','chainId','weth','functionSelector','recipient','amount','valueWei','deadlineBucket'], canonical: [`weth.unwrap@${meta.version}`,chainId,params.weth.toLowerCase(),'withdraw','',params.amount,'0',bucket].join('|') }; },
  verifyPostconditions(params, receipt: PostconditionReceipt): PostconditionCheck[] { const log = receipt.logs.find((l) => l.eventName === 'Withdrawal' && l.address.toLowerCase() === params.weth.toLowerCase() && String(l.args['src']).toLowerCase() === receipt.executorAddress.toLowerCase()); return [{ passed: !!log && BigInt(log.args['wad'] as string | bigint) === params.amount, check: 'Withdrawal event and amount match pinned WETH contract', detail: log ? `Withdrawal wad: ${log.args['wad']}` : 'No Withdrawal event found' }]; },
  describe: (params) => `WETH unwrap: ${params.amount} wei on chain ${params.chainId}`,
};
