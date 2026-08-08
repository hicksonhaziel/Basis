/**
 * Adapter: erc20.transfer
 *
 * Canonical low-complexity gas benchmark using Basis-owned test funds.
 * Transfers an ERC-20 token from the Basis execution wallet to a recipient.
 *
 * This is a benchmark adapter, not the primary product. It generates repeatable
 * data for pricing and reliability tests.
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

export interface Erc20TransferParams {
  /** ERC-20 token contract address */
  token: `0x${string}`;
  /** Recipient address */
  to: `0x${string}`;
  /** Amount in atomic units (wei/smallest unit) */
  amount: bigint;
}

const ERC20_TRANSFER_ABI = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

const meta: AdapterMeta = {
  jobType: 'erc20.transfer',
  version: '1.0.0',
  description: 'Transfer ERC-20 tokens from Basis execution wallet',
  mode: 'permissionless',
  maxGasEstimate: 100_000n,
  sendsNativeValue: false,
  supportedChains: [1, 8453, 11155111, 84532],
};

export const erc20TransferAdapter: JobAdapter<Erc20TransferParams> = {
  meta,

  validateParams(raw: unknown): Erc20TransferParams {
    if (!raw || typeof raw !== 'object') {
      throw new Error('erc20.transfer: params must be an object');
    }
    const p = raw as Record<string, unknown>;

    if (typeof p.token !== 'string' || !p.token.match(/^0x[a-fA-F0-9]{40}$/)) {
      throw new Error('erc20.transfer: token must be a valid address');
    }
    if (typeof p.to !== 'string' || !p.to.match(/^0x[a-fA-F0-9]{40}$/)) {
      throw new Error('erc20.transfer: to must be a valid address');
    }

    let amount: bigint;
    if (typeof p.amount === 'bigint') {
      amount = p.amount;
    } else if (typeof p.amount === 'string') {
      amount = BigInt(p.amount);
    } else {
      throw new Error('erc20.transfer: amount must be a bigint or numeric string');
    }

    if (amount <= 0n) {
      throw new Error('erc20.transfer: amount must be positive');
    }

    return {
      token: p.token.toLowerCase() as `0x${string}`,
      to: p.to.toLowerCase() as `0x${string}`,
      amount,
    };
  },

  buildCall(params: Erc20TransferParams, executorAddress: `0x${string}`): CallParams {
    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [params.to, params.amount],
    });

    return {
      to: params.token,
      data,
      value: 0n,
      from: executorAddress,
    };
  },

  canonicalIntent(params: Erc20TransferParams, chainId: number, deadlineBucket: string): CanonicalFields {
    const canonical = [
      `erc20.transfer@${meta.version}`,
      chainId.toString(),
      params.token,
      'transfer',
      params.to,
      params.amount.toString(),
      '0', // value wei
      deadlineBucket,
    ].join('|');

    return {
      fields: ['adapterVersion', 'chainId', 'token', 'functionSelector', 'to', 'amount', 'valueWei', 'deadlineBucket'],
      canonical,
    };
  },

  verifyPostconditions(params: Erc20TransferParams, receipt: PostconditionReceipt): PostconditionCheck[] {
    const checks: PostconditionCheck[] = [];

    // Check for Transfer event
    const transferLog = receipt.logs.find(
      (log) =>
        log.eventName === 'Transfer' &&
        (log.args['to'] as string)?.toLowerCase() === params.to.toLowerCase() &&
        log.address.toLowerCase() === params.token.toLowerCase(),
    );

    checks.push({
      passed: !!transferLog,
      check: 'Transfer event emitted to correct recipient',
      detail: transferLog
        ? `Transfer to ${params.to}, amount: ${transferLog.args['value']}`
        : 'No matching Transfer event found',
    });

    // If transfer event found, verify amount
    if (transferLog) {
      const eventAmount = BigInt(transferLog.args['value'] as string | bigint);
      checks.push({
        passed: eventAmount === params.amount,
        check: 'Transfer amount matches requested amount',
        detail: `Expected ${params.amount}, got ${eventAmount}`,
      });
    }

    return checks;
  },

  describe(params: Erc20TransferParams): string {
    return `ERC-20 transfer: ${params.amount} of ${params.token} → ${params.to}`;
  },
};
