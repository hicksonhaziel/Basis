/** Explicitly allowlisted ERC-20 transfer adapter; disabled when no policy is supplied. */
import { encodeFunctionData } from 'viem';
import type { Erc20TransferAllowance } from '../config/env.ts';
import type { JobAdapter, AdapterMeta, CallParams, SimulationParams, CanonicalFields, PostconditionCheck, PostconditionReceipt } from './adapter.ts';
export interface Erc20TransferParams { chainId: number; token: `0x${string}`; to: `0x${string}`; amount: bigint; }
const ABI = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'Transfer', type: 'event', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] },
] as const;

export function createErc20TransferAdapter(allowlist: readonly Erc20TransferAllowance[]): JobAdapter<Erc20TransferParams> {
  const chains = [...new Set(allowlist.map((a) => a.chainId))];
  const meta: AdapterMeta = { jobType: 'erc20.transfer', version: '1.1.0', description: 'Policy-bound transfer of Basis-owned benchmark tokens', mode: 'permissionless', maxGasEstimate: 100_000n, sendsNativeValue: false, supportedChains: chains.length ? chains : [1] };
  return {
    meta,
    validateParams(raw: unknown, chainId?: number): Erc20TransferParams {
      if (!raw || typeof raw !== 'object') throw new Error('erc20.transfer: params must be an object');
      const p = raw as Record<string, unknown>;
      if (!chainId) throw new Error('erc20.transfer: chain is required');
      if (typeof p.token !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(p.token)) throw new Error('erc20.transfer: token must be a valid address');
      if (typeof p.to !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(p.to)) throw new Error('erc20.transfer: to must be a valid address');
      if ((typeof p.amount !== 'string' || !/^\d+$/.test(p.amount)) && typeof p.amount !== 'bigint') throw new Error('erc20.transfer: amount must be an atomic-unit string or bigint');
      const token = p.token.toLowerCase() as `0x${string}`;
      const to = p.to.toLowerCase() as `0x${string}`;
      const amount = BigInt(p.amount as string | bigint);
      if (amount <= 0n) throw new Error('erc20.transfer: amount must be positive');
      const policy = allowlist.find((a) => a.chainId === chainId && a.token === token && a.recipient === to);
      if (!policy) throw new Error('erc20.transfer: token and recipient are not allowlisted for this chain');
      if (amount > policy.maxAmount) throw new Error(`erc20.transfer: amount exceeds allowlisted maximum ${policy.maxAmount}`);
      return { chainId, token, to, amount };
    },
    buildCall(params, executorAddress): CallParams { return { to: params.token, data: encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [params.to, params.amount] }), value: 0n, from: executorAddress }; },
    buildSimulation(params): SimulationParams { return { contractAddress: params.token, functionName: 'transfer', functionArgs: JSON.stringify([params.to, params.amount.toString()]), abi: JSON.stringify(ABI) }; },
    canonicalIntent(params, chainId, bucket): CanonicalFields { return { fields: ['adapterVersion','chainId','token','functionSelector','to','amount','valueWei','deadlineBucket'], canonical: [`erc20.transfer@${meta.version}`,chainId,params.token,'transfer',params.to,params.amount,'0',bucket].join('|') }; },
    verifyPostconditions(params, receipt: PostconditionReceipt): PostconditionCheck[] { const log = receipt.logs.find((l) => l.eventName === 'Transfer' && l.address.toLowerCase() === params.token && String(l.args['from']).toLowerCase() === receipt.executorAddress.toLowerCase() && String(l.args['to']).toLowerCase() === params.to); return [{ passed: !!log && BigInt(log.args['value'] as string | bigint) === params.amount, check: 'Allowlisted Transfer event recipient and amount match', detail: log ? `Transfer value: ${log.args['value']}` : 'No matching Transfer event found' }]; },
    describe: (params) => `Allowlisted ERC-20 transfer: ${params.amount} ${params.token} to ${params.to}`,
  };
}

/** Safe default for imports/tests: no token or recipient is authorized. */
export const erc20TransferAdapter = createErc20TransferAdapter([]);
