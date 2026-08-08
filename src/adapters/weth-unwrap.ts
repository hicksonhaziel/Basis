/**
 * Adapter: weth.unwrap
 *
 * Unwrap WETH back to native ETH. This is a permissionless protocol action —
 * the WETH contract's withdraw() function can be called by any holder.
 *
 * Demonstrates: Basis executing a real protocol state transition (WETH→ETH)
 * on behalf of a buyer who doesn't want to manage gas or execution.
 */

import { encodeFunctionData } from 'viem';
import type {
  JobAdapter,
  AdapterMeta,
  CallParams,
  SimulationParams,
  CanonicalFields,
  PostconditionCheck,
  PostconditionReceipt,
} from './adapter.ts';
import { WETH_ADDRESSES } from './weth-wrap.ts';

export interface WethUnwrapParams {
  /** WETH contract address */
  weth: `0x${string}`;
  /** Amount to unwrap, in wei */
  amount: bigint;
}

const WETH_WITHDRAW_ABI = [
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
] as const;

const meta: AdapterMeta = {
  jobType: 'weth.unwrap',
  version: '1.0.0',
  description: 'Unwrap WETH back to native ETH via withdraw()',
  mode: 'permissionless',
  maxGasEstimate: 60_000n,
  sendsNativeValue: false,
  supportedChains: [1, 8453, 11155111, 84532],
};

export const wethUnwrapAdapter: JobAdapter<WethUnwrapParams> = {
  meta,

  validateParams(raw: unknown): WethUnwrapParams {
    if (!raw || typeof raw !== 'object') throw new Error('weth.unwrap: params must be an object');
    const p = raw as Record<string, unknown>;

    let weth: `0x${string}`;
    if (typeof p.weth === 'string' && p.weth.match(/^0x[a-fA-F0-9]{40}$/)) {
      weth = p.weth.toLowerCase() as `0x${string}`;
    } else if (typeof p.chainId === 'number' && WETH_ADDRESSES[p.chainId]) {
      weth = WETH_ADDRESSES[p.chainId]!;
    } else {
      throw new Error('weth.unwrap: weth must be a valid address, or provide chainId for default');
    }

    let amount: bigint;
    if (typeof p.amount === 'bigint') amount = p.amount;
    else if (typeof p.amount === 'string') amount = BigInt(p.amount);
    else throw new Error('weth.unwrap: amount must be a bigint or numeric string');

    if (amount <= 0n) throw new Error('weth.unwrap: amount must be positive');
    return { weth, amount };
  },

  buildCall(params: WethUnwrapParams, executorAddress: `0x${string}`): CallParams {
    const data = encodeFunctionData({
      abi: WETH_WITHDRAW_ABI,
      functionName: 'withdraw',
      args: [params.amount],
    });
    return { to: params.weth, data, value: 0n, from: executorAddress };
  },

  buildSimulation(params: WethUnwrapParams): SimulationParams {
    return {
      contractAddress: params.weth,
      functionName: 'withdraw',
      functionArgs: JSON.stringify([params.amount.toString()]),
      abi: JSON.stringify(WETH_WITHDRAW_ABI),
    };
  },

  canonicalIntent(params: WethUnwrapParams, chainId: number, deadlineBucket: string): CanonicalFields {
    const canonical = [
      `weth.unwrap@${meta.version}`,
      chainId.toString(),
      params.weth,
      'withdraw',
      '',
      params.amount.toString(),
      '0',
      deadlineBucket,
    ].join('|');
    return {
      fields: ['adapterVersion', 'chainId', 'weth', 'functionSelector', 'recipient', 'amount', 'valueWei', 'deadlineBucket'],
      canonical,
    };
  },

  verifyPostconditions(params: WethUnwrapParams, receipt: PostconditionReceipt): PostconditionCheck[] {
    const withdrawLog = receipt.logs.find(
      (log) => log.eventName === 'Withdrawal' && log.address.toLowerCase() === params.weth.toLowerCase(),
    );
    return [{
      passed: !!withdrawLog,
      check: 'Withdrawal event emitted by WETH contract',
      detail: withdrawLog ? `Withdrawal wad: ${withdrawLog.args['wad']}` : 'No Withdrawal event found',
    }];
  },

  describe(params: WethUnwrapParams): string {
    return `WETH unwrap: ${params.amount} wei from ${params.weth}`;
  },
};
