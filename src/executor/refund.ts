/** Fixed-policy internal Base-USDC refund engine. Never exposed as a public adapter. */
import { decodeEventLog, parseAbiItem, type Hex } from 'viem';
import { KeeperHubClient, type ExecutionStatus, type ExecuteContractCallRequest } from '../keeperhub/client.ts';
import { IdempotencyConflictError, IdempotencyInProgressError } from '../keeperhub/errors.ts';
import { Ledger, type RefundRecord } from '../ledger/database.ts';
import { REFUND_CHAIN_ID, REFUND_POLICY_ID, REFUND_TOKEN_ADDRESS } from '../config/policy.ts';

const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

export interface RefundRpc {
  getTransactionReceipt(input: { hash: Hex }): Promise<{ transactionHash: Hex; status: 'success' | 'reverted'; blockNumber: bigint; gasUsed: bigint; logs: Array<{ address: Hex; data: Hex; topics: readonly Hex[] }> }>;
  getTransaction(input: { hash: Hex }): Promise<{ hash: Hex; from: Hex; to: Hex | null; input: Hex; value: bigint }>;
  getBlockNumber(): Promise<bigint>;
}
export interface RefundEngineConfig { enabled: boolean; confirmedWallet?: `0x${string}`; minimumConfirmations?: number; }

export class RefundEngine {
  private ledger: Ledger;
  private keeperHub: KeeperHubClient;
  private rpc: RefundRpc;
  private config: RefundEngineConfig;
  constructor(ledger: Ledger, keeperHub: KeeperHubClient, rpc: RefundRpc, config: RefundEngineConfig) {
    this.ledger = ledger; this.keeperHub = keeperHub; this.rpc = rpc; this.config = config;
  }

  async reconcileAll(): Promise<void> {
    for (const refund of this.ledger.getRecoverableRefunds()) await this.reconcile(refund);
  }

  async reconcile(input: RefundRecord): Promise<void> {
    let refund = this.ledger.getRefund(input.refund_id) ?? input;
    this.assertPolicy(refund);
    if (refund.state === 'REFUND_PENDING') {
      if (!this.config.enabled) return;
      refund = this.ledger.claimRefund(refund.refund_id) ?? this.ledger.getRefund(refund.refund_id)!;
      if (refund.state !== 'REFUND_SUBMITTING') return;
      const request = JSON.parse(refund.outbound_request_json) as ExecuteContractCallRequest;
      try {
        const simulation = await this.keeperHub.simulate(request);
        const sender = simulation.from.toLowerCase();
        if (simulation.to.toLowerCase() !== REFUND_TOKEN_ADDRESS || request.contractAddress.toLowerCase() !== REFUND_TOKEN_ADDRESS) throw new Error('Refund simulation target is not canonical Base USDC');
        if (this.config.confirmedWallet && sender !== this.config.confirmedWallet.toLowerCase()) throw new Error('Refund simulation sender differs from confirmed KeeperHub wallet');
        if (sender !== refund.expected_sender.toLowerCase()) throw new Error('Refund simulation sender differs from persisted expected sender');
        this.ledger.appendEvent('REFUND_SIMULATED', refund.refund_id, { sender, chainId: request.chainId, tokenAddress: request.contractAddress, wouldRevert: false });
      } catch (error) {
        this.ledger.updateRefundState(refund.refund_id, 'REFUND_FAILED', `refund simulation definitively failed before broadcast: ${message(error)}`, { errorReason: message(error) });
        return;
      }
      try {
        const response = await this.keeperHub.executeContractCall(request, refund.idempotency_key);
        refund = this.ledger.updateRefundState(refund.refund_id, 'REFUND_VERIFYING', 'KeeperHub refund execution ID persisted; independent verification required', { keeperhubExecutionId: response.executionId });
      } catch (error) {
        if (error instanceof IdempotencyInProgressError && error.originalExecutionId) {
          refund = this.ledger.updateRefundState(refund.refund_id, 'REFUND_VERIFYING', 'original KeeperHub refund execution recovered from idempotency-in-progress', { keeperhubExecutionId: error.originalExecutionId });
        } else if (error instanceof IdempotencyConflictError) {
          this.ledger.updateRefundState(refund.refund_id, 'REFUND_FAILED', 'KeeperHub rejected refund idempotency key as conflicting before acceptance', { errorReason: error.message });
          return;
        } else {
          this.ledger.updateRefundState(refund.refund_id, 'REFUND_UNCERTAIN', `refund submission outcome ambiguous: ${message(error)}`, { uncertaintyReason: message(error) });
          return;
        }
      }
    } else if (refund.state === 'REFUND_SUBMITTING') {
      // A process may have died after sending but before storing the response. Never rebroadcast.
      this.ledger.updateRefundState(refund.refund_id, 'REFUND_UNCERTAIN', 'refund worker restarted after possible submission without an execution ID; no rebroadcast', { uncertaintyReason: 'possible broadcast without persisted execution ID' });
      return;
    }

    refund = this.ledger.getRefund(refund.refund_id)!;
    if ((refund.state === 'REFUND_VERIFYING' || refund.state === 'REFUND_UNCERTAIN') && refund.keeperhub_execution_id) await this.verifyOriginal(refund);
  }

  private async verifyOriginal(refund: RefundRecord): Promise<void> {
    let status: ExecutionStatus;
    try { status = (await this.keeperHub.getExecutionStatus(refund.keeperhub_execution_id!)).status; }
    catch (error) {
      if (refund.state === 'REFUND_VERIFYING') this.ledger.updateRefundState(refund.refund_id, 'REFUND_UNCERTAIN', `refund status unavailable: ${message(error)}`, { uncertaintyReason: message(error) });
      return;
    }
    if (status.status === 'pending' || status.status === 'running') return;
    if (status.status === 'failed') {
      const applicable = status.receipts.filter((r) => r.chainId === REFUND_CHAIN_ID);
      if (applicable.length && applicable.every((r) => r.verified && r.receiptStatus === 'reverted')) {
        this.ledger.updateRefundState(refund.refund_id, 'REFUND_FAILED', 'independently classifiable KeeperHub receipt proves refund reverted', { errorReason: status.error ?? 'refund reverted' });
      } else if (refund.state === 'REFUND_VERIFYING') {
        this.ledger.updateRefundState(refund.refund_id, 'REFUND_UNCERTAIN', 'KeeperHub failed without definitive verified revert proof', { uncertaintyReason: status.error ?? 'failed without receipt proof' });
      }
      return;
    }
    try {
      const proof = await verifyRefund(status, refund, this.rpc, this.config.minimumConfirmations ?? 1);
      this.ledger.updateRefundState(refund.refund_id, 'REFUNDED', 'KeeperHub receipt, independent Base receipt, confirmation, and exact USDC Transfer verified', { transactionHash: proof.transactionHash, blockNumber: proof.blockNumber, gasUsed: proof.gasUsed, decodedTransfer: proof.transfer, verifiedAt: new Date().toISOString(), uncertaintyReason: null });
    } catch (error) {
      if (refund.state === 'REFUND_VERIFYING') this.ledger.updateRefundState(refund.refund_id, 'REFUND_UNCERTAIN', message(error), { uncertaintyReason: message(error) });
    }
  }

  private assertPolicy(refund: RefundRecord): void {
    if (refund.refund_policy_id !== REFUND_POLICY_ID || refund.chain_id !== REFUND_CHAIN_ID || refund.token_address.toLowerCase() !== REFUND_TOKEN_ADDRESS) throw new Error('Persisted refund violates active fixed policy');
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export async function verifyRefund(status: ExecutionStatus, refund: RefundRecord, rpc: RefundRpc, minimumConfirmations = 1) {
  if (status.status !== 'completed' || !status.transactionHash) throw new Error('KeeperHub refund is not completed with a transaction hash');
  const hash = status.transactionHash.toLowerCase();
  const receipts = status.receipts.filter((r) => r.chainId === REFUND_CHAIN_ID);
  if (receipts.length === 0) throw new Error('KeeperHub completed refund without an applicable receipt');
  if (receipts.some((r) => !r.verified || r.receiptStatus !== 'success' || r.hash.toLowerCase() !== hash)) throw new Error('KeeperHub refund receipt is unverified, unsuccessful, or mismatched');
  let receipt;
  try { receipt = await rpc.getTransactionReceipt({ hash: status.transactionHash as Hex }); await rpc.getTransaction({ hash: status.transactionHash as Hex }); }
  catch (error) { throw new Error(`Independent Base RPC refund transaction unavailable: ${message(error)}`); }
  if (receipt.transactionHash.toLowerCase() !== hash || receipt.status !== 'success') throw new Error('Independent Base refund receipt is unsuccessful or mismatched');
  const latest = await rpc.getBlockNumber();
  if (latest - receipt.blockNumber + 1n < BigInt(minimumConfirmations)) throw new Error('Refund receipt is not yet confirmed');
  const matches: Array<{ from: string; to: string; value: string; token: string }> = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== REFUND_TOKEN_ADDRESS) continue;
    try {
      const decoded = decodeEventLog({ abi: [TRANSFER_EVENT], data: log.data, topics: log.topics as never, strict: true });
      const args = decoded.args as { from: string; to: string; value: bigint };
      if (args.from.toLowerCase() === refund.expected_sender.toLowerCase() && args.to.toLowerCase() === refund.refund_recipient.toLowerCase() && args.value.toString() === refund.amount_atomic) {
        matches.push({ from: args.from.toLowerCase(), to: args.to.toLowerCase(), value: args.value.toString(), token: log.address.toLowerCase() });
      }
    } catch { /* unrelated canonical-token log */ }
  }
  if (matches.length !== 1) throw new Error(`Expected exactly one matching canonical USDC Transfer event, found ${matches.length}`);
  return { transactionHash: status.transactionHash, blockNumber: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), transfer: matches[0]! };
}
