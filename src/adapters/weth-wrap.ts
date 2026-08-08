/**
 * Adapter: weth.wrap
 *
 * Deterministic contract-write benchmark.
 * Wraps native ETH into WETH by calling deposit() with value.
 *
 * This is a benchmark adapter. It generates repeatable data for pricing tests.
 * Uses Basis-owned ETH.
 */

import { encodeFunctionData } from 'viem';
import type {
  JobAdapter,
  AdapterMeta,
  CallParams,
  CanonicalFields,
  PostconditionCheck,
  PostconditionReceipt,
} from './adapter.ts';

export interface WethWrapParams {
  /** WETH contract address */
  weth: `0x${string}`;
  /** Amount of ETH to wrap, in wei */
  amount: bigint;
}

/** Well-known WETH addresses by chain */
export const WETH_ADDRESSES: Record<number, `0x${string}`> = {
  1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  8453: '0x4200000000000000000000000000000000000006',
  11155111: '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9',
  84532: '0x4200000000000000000000000000000000000006',
};

const WETH_DEPOSIT_ABI = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
] as const;

const meta: AdapterMeta = {
  jobType: 'weth.wrap',
  version: '1.0.0',
  description: 'Wrap native ETH into WETH via deposit()',
  mode: 'permissionless',
  maxGasEstimate: 60_000n,
  sendsNativeValue: true,
  supportedChains: [1, 8453, 11155111, 84532],
};

export const wethWrapAdapter: JobAdapter<WethWrapParams> = {
  meta,

  validateParams(raw: unknown): WethWrapParams {
    if (!raw || typeof raw !== 'object') {
      throw new Error('weth.wrap: params must be an object');
    }
    const p = raw as Record<string, unknown>;

    let weth: `0x${string}`;
    if (typeof p.weth === 'string' && p.weth.match(/^0x[a-fA-F0-9]{40}$/)) {
      weth = p.weth.toLowerCase() as `0x${string}`;
    } else if (typeof p.chainId === 'number' && WETH_ADDRESSES[p.chainId]) {
      weth = WETH_ADDRESSES[p.chainId]!;
    } else {
      throw new Error('weth.wrap: weth must be a valid address, or provide chainId for default');
    }

    let amount: bigint;
    if (typeof p.amount === 'bigint') {
      amount = p.amount;
    } else if (typeof p.amount === 'string') {
      amount = BigInt(p.amount);
    } else {
      throw new Error('weth.wrap: amount must be a bigint or numeric string');
    }

    if (amount <= 0n) {
      throw new Error('weth.wrap: amount must be positive');
    }

    return { weth, amount };
  },

  buildCall(params: WethWrapParams, executorAddress: `0x${string}`): CallParams {
    const data = encodeFunctionData({
      abi: WETH_DEPOSIT_ABI,
      functionName: 'deposit',
    });

    return {
      to: params.weth,
      data,
      value: params.amount,
      from: executorAddress,
    };
  },

  canonicalIntent(params: WethWrapParams, chainId: number, deadlineBucket: string): CanonicalFields {
    const canonical = [
      `weth.wrap@${meta.version}`,
      chainId.toString(),
      params.weth,
      'deposit',
      '', // no target recipient; wraps to msg.sender
      params.amount.toString(),
      params.amount.toString(), // value == amount for deposit
      deadlineBucket,
    ].join('|');

    return {
      fields: ['adapterVersion', 'chainId', 'weth', 'functionSelector', 'recipient', 'amount', 'valueWei', 'deadlineBucket'],
      canonical,
    };
  },

  verifyPostconditions(params: WethWrapParams, receipt: PostconditionReceipt): PostconditionCheck[] {
    const checks: PostconditionCheck[] = [];

    // WETH emits a Deposit event: Deposit(address indexed dst, uint wad)
    const depositLog = receipt.logs.find(
      (log) =>
        log.eventName === 'Deposit' &&
        log.address.toLowerCase() === params.weth.toLowerCase(),
    );

    checks.push({
      passed: !!depositLog,
      check: 'Deposit event emitted by WETH contract',
      detail: depositLog
        ? `Deposit wad: ${depositLog.args['wad']}`
        : 'No Deposit event found',
    });

    if (depositLog) {
      const wad = BigInt(depositLog.args['wad'] as string | bigint);
      checks.push({
        passed: wad === params.amount,
        check: 'Deposited amount matches requested amount',
        detail: `Expected ${params.amount}, got ${wad}`,
      });
    }

    return checks;
  },

  describe(params: WethWrapParams): string {
    return `WETH wrap: ${params.amount} wei → ${params.weth}`;
  },
};
