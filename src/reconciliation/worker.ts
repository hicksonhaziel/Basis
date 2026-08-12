/** Deterministic execution recovery and reconciliation. No model calls or credentials outside this worker. */
import type { PublicClient } from 'viem';
import { registry } from '../adapters/registry.ts';
import { Ledger, type ExecutionRecord } from '../ledger/database.ts';
import { KeeperHubClient, type ExecutionStatus } from '../keeperhub/client.ts';
import { IdempotencyConflictError, IdempotencyInProgressError } from '../keeperhub/errors.ts';
import type { PersistedExecutionIntent } from '../executor/intent.ts';
import { assertRequestMatchesIntent, assertSimulationMatchesIntent, stableJson } from '../executor/intent.ts';
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

    const recoveryState = execution.state;
    const definitivelyPreSubmission = recoveryState === 'AUTHENTICATED_INGRESS' || recoveryState === 'RESIMULATING';
    const adapter = registry.require(intent.adapterName);
    let params: unknown;
    let outbound: ReturnType<typeof JSON.parse>;

    try {
      params = adapter.validatePersistedParams
        ? adapter.validatePersistedParams(intent.validatedParams, intent.chainId)
        : adapter.validateParams(intent.validatedParams, intent.chainId);
      const rebuiltCall = adapter.buildCall(params, intent.executorAddress);
      const rebuiltSimulation = adapter.buildSimulation(params);
      if (rebuiltCall.to.toLowerCase() !== intent.target.toLowerCase()
        || rebuiltCall.data.toLowerCase() !== intent.calldata.toLowerCase()
        || rebuiltCall.value.toString() !== intent.nativeValueWei) throw new Error('Recovered adapter call differs from persisted canonical intent');
      if (stableJson(rebuiltSimulation) !== stableJson({
        contractAddress: intent.target,
        functionName: intent.functionName,
        functionArgs: intent.functionArgs,
        abi: intent.abi,
        value: intent.keeperHubValue,
      })) throw new Error('Recovered adapter simulation differs from persisted canonical intent');
      outbound = JSON.parse(execution.outbound_request_json);
      assertRequestMatchesIntent(outbound, intent);
      if (execution.idempotency_key !== intent.idempotencyKey) throw new Error('Recovered idempotency key differs from persisted canonical intent');
    } catch (error) {
      this.rejectRecoveredSubmission(execution, definitivelyPreSubmission, 'RECOVERY_INTENT_INVALID', `recovery validation rejected before submission: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    // Crash recovery may repeat only the exact validated persisted request with the same idempotency key.
    if (execution.state === 'AUTHENTICATED_INGRESS') {
      this.ledger.transitionOrder(execution.order_id, 'RESIMULATING', 'startup recovery resumed validated admitted order');
      execution.state = 'RESIMULATING';
    }
    if (execution.state === 'RESIMULATING') {
      try {
        const simulated = await this.keeperHub.simulate(outbound);
        assertSimulationMatchesIntent(simulated, intent);
        if (BigInt(simulated.gasEstimate) > adapter.meta.maxGasEstimate) throw new Error('Recovery re-simulation exceeds adapter gas cap');
      } catch (error) {
        this.rejectRecoveredSubmission(execution, true, 'RESIMULATION_FAILED', `startup recovery re-simulation rejected before broadcast: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    // UNCERTAIN executions never enter this branch and are never submitted again.
    if ((execution.state === 'RESIMULATING' || execution.state === 'EXECUTING') && !keeperhubId) {
      try {
        await adapter.preSubmitPreflight?.(params, this.rpcClientFactory(intent.chainId));
      } catch (error) {
        this.rejectRecoveredSubmission(execution, definitivelyPreSubmission, 'PRE_SUBMIT_PREFLIGHT_FAILED', `recovery pre-submit policy rejected: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (execution.state === 'RESIMULATING') {
        this.ledger.transitionOrder(execution.order_id, 'EXECUTING', 'startup recovery exact re-simulation and adapter pre-submit policy matched validated persisted intent');
        execution.state = 'EXECUTING';
      }
      try {
        const response = await this.keeperHub.executeContractCall(outbound, execution.idempotency_key);
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

  private rejectRecoveredSubmission(execution: ExecutionRecord, definitivelyPreSubmission: boolean, reason: string, detail: string): void {
    if (!definitivelyPreSubmission) {
      if (execution.state !== 'UNCERTAIN') this.ledger.transitionOrder(execution.order_id, 'UNCERTAIN', `${detail}; original submission outcome may be ambiguous`);
      return;
    }
    if (execution.state === 'AUTHENTICATED_INGRESS') {
      this.ledger.transitionOrder(execution.order_id, 'RESIMULATING', 'startup recovery entered deterministic pre-submission rejection handling');
      execution.state = 'RESIMULATING';
    }
    const row = this.ledger.getDb().prepare('SELECT authority_kind FROM orders WHERE order_id=?').get(execution.order_id) as { authority_kind: string } | undefined;
    if (row?.authority_kind === 'MARKETPLACE_PAYMENT_AUTHORIZED') this.ledger.markRefundEligible(execution.order_id, reason, detail);
    else this.ledger.transitionOrder(execution.order_id, 'FAILED', `${detail}; no paid Marketplace authority`, 'reconciliation-worker');
  }

  private deadlineBacked(orderId: string): boolean {
    const row = this.ledger.getDb().prepare('SELECT q.deadline_tier FROM orders o JOIN quotes q ON q.quote_id=o.quote_id WHERE o.order_id=?').get(orderId) as { deadline_tier: string } | undefined;
    return row?.deadline_tier !== 'best-effort';
  }
}
