import { decodeEventLog, type Hex } from 'viem';
import type { JobAdapter, DecodedLog, PostconditionCheck, AdapterRpc } from '../adapters/adapter.ts';
import type { CanonicalExecutionIntent } from './intent.ts';
import type { ExecutionStatus } from '../keeperhub/client.ts';
import { toJsonValue } from './intent.ts';

export class VerificationFailure extends Error {}
export class VerificationUncertain extends Error {}

export interface IndependentRpc extends AdapterRpc {
  getTransactionReceipt(input: { hash: Hex }): Promise<{ transactionHash: Hex; status: 'success' | 'reverted'; blockNumber: bigint; gasUsed: bigint; logs: Array<{ address: Hex; data: Hex; topics: readonly Hex[] }> }>;
  getTransaction(input: { hash: Hex }): Promise<{ hash: Hex; from: Hex; to: Hex | null; input: Hex; value: bigint }>;
}

export interface VerificationResult {
  transactionHash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
  decodedLogs: DecodedLog[];
  postconditions: PostconditionCheck[];
}

function decodeLogs(logs: Array<{ address: Hex; data: Hex; topics: readonly Hex[] }>, abiJson: string): DecodedLog[] {
  const abi = JSON.parse(abiJson) as readonly unknown[];
  const decoded: DecodedLog[] = [];
  for (const log of logs) {
    try {
      const event = decodeEventLog({ abi: abi as never, data: log.data, topics: log.topics as never, strict: true });
      decoded.push({ address: log.address, eventName: String(event.eventName), args: toJsonValue(event.args) as Record<string, unknown> });
    } catch { /* Unrelated logs are not postcondition evidence. */ }
  }
  return decoded;
}

export async function verifyExecution(
  status: ExecutionStatus,
  intent: CanonicalExecutionIntent,
  adapter: JobAdapter,
  validatedParams: unknown,
  rpc: IndependentRpc,
): Promise<VerificationResult> {
  if (status.status !== 'completed') throw new VerificationFailure(status.error ?? `KeeperHub execution status is ${status.status}`);
  if (!status.transactionHash) throw new VerificationUncertain('KeeperHub completed without a transaction hash');
  const txHash = status.transactionHash.toLowerCase();
  const applicable = status.receipts.filter((receipt) => receipt.chainId === intent.chainId);
  if (applicable.length === 0) throw new VerificationFailure('KeeperHub completed with no applicable receipts');
  if (applicable.some((receipt) => receipt.hash.toLowerCase() !== txHash)) throw new VerificationFailure('KeeperHub receipt and transaction hash disagree');
  if (applicable.some((receipt) => !receipt.verified)) throw new VerificationFailure('KeeperHub receipt is not verified');
  if (applicable.some((receipt) => receipt.receiptStatus !== 'success')) throw new VerificationFailure('KeeperHub receipt status is not successful');

  let receipt;
  let transaction;
  try {
    receipt = await rpc.getTransactionReceipt({ hash: status.transactionHash as Hex });
    transaction = await rpc.getTransaction({ hash: status.transactionHash as Hex });
  } catch (error) {
    throw new VerificationUncertain(`Independent RPC transaction unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!receipt || !transaction) throw new VerificationUncertain('Independent RPC transaction unavailable');
  if (receipt.transactionHash.toLowerCase() !== txHash || transaction.hash.toLowerCase() !== txHash) throw new VerificationFailure('RPC/KeeperHub transaction hash disagreement');
  if (receipt.status !== 'success') throw new VerificationFailure('Independent RPC receipt status is not successful');
  if (!status.sponsored) {
    if (transaction.from.toLowerCase() !== intent.executorAddress.toLowerCase()) throw new VerificationFailure('Independent transaction executor mismatch');
    if (transaction.to?.toLowerCase() !== intent.target.toLowerCase()) throw new VerificationFailure('Independent transaction target mismatch');
    if (transaction.input.toLowerCase() !== intent.calldata.toLowerCase()) throw new VerificationFailure('Independent transaction calldata mismatch');
    if (transaction.value !== BigInt(intent.nativeValueWei)) throw new VerificationFailure('Independent transaction value mismatch');
  }

  const decodedLogs = decodeLogs(receipt.logs, intent.abi);
  const adapterReceipt = {
    executorAddress: intent.executorAddress,
    transactionHash: status.transactionHash as Hex,
    status: 'success' as const,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    rawLogs: receipt.logs,
    logs: decodedLogs,
  };
  const postconditions = adapter.verifyPostconditions(validatedParams, adapterReceipt);
  if (adapter.verifyHistoricalReceipt) {
    postconditions.push(...await adapter.verifyHistoricalReceipt(validatedParams, adapterReceipt, rpc, { sponsored: status.sponsored }));
  }
  if (postconditions.length === 0 || postconditions.some((check) => !check.passed)) throw new VerificationFailure('Adapter postcondition verification failed');
  return { transactionHash: status.transactionHash as Hex, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, decodedLogs, postconditions };
}
