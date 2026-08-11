/** Deterministic execution recovery and reconciliation. No model calls or credentials outside this worker. */
import type { PublicClient } from 'viem';
import { registry } from '../adapters/registry.ts';
import { Ledger, type ExecutionRecord } from '../ledger/database.ts';
import { KeeperHubClient, type ExecutionStatus } from '../keeperhub/client.ts';
import { IdempotencyConflictError, IdempotencyInProgressError } from '../keeperhub/errors.ts';
import type { PersistedExecutionIntent } from '../executor/intent.ts';
import { assertSimulationMatchesIntent } from '../executor/intent.ts';
import type { IndependentRpc } from '../executor/verify.ts';
import { verifyExecution, VerificationFailure, VerificationUncertain } from '../executor/verify.ts';

import { RefundEngine } from '../executor/refund.ts';

export class ReconciliationWorker {
  private readonly ledger: Ledger;
  private readonly keeperHub: KeeperHubClient;
  private readonly rpcClientFactory: (chainId: number) => PublicClient;

  private readonly refundEngine?: RefundEngine;

  constructor(ledger: Ledger, keeperHub: KeeperHubClient, rpcClientFactory: (chainId: number) => PublicClient, refundEngine?: RefundEngine) {
    this.ledger = ledger;
    this.keeperHub = keeperHub;
    this.rpcClientFactory = rpcClientFactory;
    this.refundEngine = refundEngine;
  }

  async runOnce(includeCrashRecovery = true): Promise<void> {
    for (const execution of this.ledger.getRecoverableExecutions(includeCrashRecovery)) await this.reconcile(execution);
    await this.refundEngine?.reconcileAll();
  }

  async reconcile(execution: ExecutionRecord): Promise<void> {
    const intent = JSON.parse(execution.canonical_intent_json) as PersistedExecutionIntent;
    let keeperhubId = execution.keeperhub_execution_id;

    // Crash recovery may repeat only the exact persisted request with the same idempotency key.

    if (execution.state === 'AUTHENTICATED_INGRESS') {
      this.ledger.transitionOrder(execution.order_id, 'RESIMULATING', 'startup recovery resumed admitted order');
      execution.state = 'RESIMULATING';
    }
    if (execution.state === 'RESIMULATING') {
      const adapter = registry.require(intent.adapterName);
      try {
        const simulated = await this.keeperHub.simulate(JSON.parse(execution.outbound_request_json));
        assertSimulationMatchesIntent(simulated, intent);
        if (BigInt(simulated.gasEstimate) > adapter.meta.maxGasEstimate) throw new Error('Recovery re-simulation exceeds adapter gas cap');
        this.ledger.transitionOrder(execution.order_id, 'EXECUTING', 'startup recovery exact re-simulation matched persisted intent');
        execution.state = 'EXECUTING';
      } catch (error) {
        this.eligibleIfPaid(execution.order_id, 'RESIMULATION_FAILED', `startup recovery re-simulation rejected before broadcast: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    // UNCERTAIN executions never enter this branch and are never submitted again.
    if (execution.state === 'EXECUTING' && !keeperhubId) {
      try {
        const response = await this.keeperHub.executeContractCall(JSON.parse(execution.outbound_request_json), execution.idempotency_key);
        keeperhubId = response.executionId;
        this.ledger.recordSubmission(execution.execution_id, keeperhubId, response.idempotentReplay === true);
      } catch (error) {
        if (error instanceof IdempotencyInProgressError && error.originalExecutionId) {
          keeperhubId = error.originalExecutionId;
          this.ledger.recordSubmission(execution.execution_id, keeperhubId, true);
        } else if (error instanceof IdempotencyConflictError) {
          this.fail(execution.order_id, `KeeperHub idempotency conflict during crash recovery: ${error.message}`);
          return;
        } else {
          this.ledger.transitionOrder(execution.order_id, 'UNCERTAIN', `crash recovery could not recover original submission: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
      }
    }

    if (!keeperhubId) return; // UNCERTAIN without an execution ID is deliberately never rebroadcast.
    let status: ExecutionStatus;
    try { status = (await this.keeperHub.getExecutionStatus(keeperhubId)).status; }
    catch { return; }
    if (status.status === 'pending' || status.status === 'running') return;
    if (status.status === 'failed') { this.fail(execution.order_id, `KeeperHub deterministically reported failed: ${status.error ?? 'unknown'}`); return; }

    if (execution.state === 'EXECUTING' || execution.state === 'UNCERTAIN') this.ledger.transitionOrder(execution.order_id, 'VERIFYING', 'reconciliation obtained terminal KeeperHub status');
    const adapter = registry.require(intent.adapterName);
    const params = adapter.validatePersistedParams
      ? adapter.validatePersistedParams(intent.validatedParams, intent.chainId)
      : adapter.validateParams(intent.validatedParams, intent.chainId);
    try {
      const verified = await verifyExecution(status, intent, adapter, params, this.rpcClientFactory(intent.chainId) as unknown as IndependentRpc);
      this.ledger.recordReceipt({ executionId: execution.execution_id, transactionHash: verified.transactionHash, chainId: intent.chainId, keeperHubVerified: true, independentVerified: true, receiptStatus: 'success', blockNumber: verified.blockNumber, gasUsed: verified.gasUsed, decodedLogs: verified.decodedLogs, postconditions: verified.postconditions });
      this.ledger.updateExecution(execution.execution_id, { transactionHash: verified.transactionHash, gasUsed: verified.gasUsed.toString(), gasUsedWei: status.gasUsedWei, sponsored: status.sponsored, completedAt: status.completedAt ?? new Date().toISOString() });
      const late = this.deadlineBacked(execution.order_id) && new Date(status.completedAt ?? Date.now()).getTime() > new Date(intent.deadlineAt).getTime();
      if (late) {
        this.ledger.transitionOrder(execution.order_id, 'LATE', 'reconciliation verified success after deadline');
        this.ledger.appendEvent('EXECUTION_VERIFIED', execution.execution_id, { transactionHash: verified.transactionHash, verificationSource: 'keeperhub+independent-rpc', deadlineHit: false });
        this.eligibleIfPaid(execution.order_id, 'CONTRACTUAL_DEADLINE_MISSED', 'reconciliation independently verified success after contractual deadline');
      } else {
        this.ledger.transitionOrder(execution.order_id, 'SUCCEEDED', 'reconciliation independently verified receipt and adapter postconditions');
        this.ledger.appendEvent('EXECUTION_VERIFIED', execution.execution_id, { transactionHash: verified.transactionHash, verificationSource: 'keeperhub+independent-rpc', deadlineHit: true });
      }
    } catch (error) {
      if (error instanceof VerificationUncertain) {
        this.ledger.transitionOrder(execution.order_id, 'UNCERTAIN', error.message);
      } else if (error instanceof VerificationFailure) {
        this.fail(execution.order_id, error.message);
      } else throw error;
    }
  }

  private fail(orderId: string, reason: string): void {
    this.ledger.transitionOrder(orderId, 'FAILED', reason);
    this.eligibleIfPaid(orderId, 'DEFINITIVE_EXECUTION_FAILURE', reason);
  }

  private eligibleIfPaid(orderId: string, reason: string, detail: string): void {
    const row = this.ledger.getDb().prepare('SELECT authority_kind FROM orders WHERE order_id=?').get(orderId) as { authority_kind: string } | undefined;
    if (row?.authority_kind === 'MARKETPLACE_PAYMENT_AUTHORIZED') this.ledger.markRefundEligible(orderId, reason, detail);
  }

  private deadlineBacked(orderId: string): boolean {
    const row = this.ledger.getDb().prepare('SELECT q.deadline_tier FROM orders o JOIN quotes q ON q.quote_id=o.quote_id WHERE o.order_id=?').get(orderId) as { deadline_tier: string } | undefined;
    return row?.deadline_tier !== 'best-effort';
  }
}
