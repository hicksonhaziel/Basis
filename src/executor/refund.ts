/**
 * Refund Execution.
 *
 * When Basis misses a deadline, re-simulation fails, or execution reverts,
 * the service fee is refunded via a USDC transfer through KeeperHub.
 *
 * Refund idempotency key = sha256("refund" | quoteId | paymentTxHash | amount)
 * This prevents double-refunds even if the refund process is retried.
 */

import { KeeperHubClient } from '../keeperhub/client.ts';
import { Ledger } from '../ledger/database.ts';
import { deriveRefundIdempotencyKey } from './idempotency.ts';
import { randomUUID } from 'node:crypto';

export interface RefundRequest {
  orderId: string;
  quoteId: string;
  reason: 'deadline_missed' | 'execution_failed' | 'resimulation_failed';
  amountUsd: string;
  paymentTxHash?: string;
  /** Recipient address for the refund (buyer's wallet) */
  recipientAddress: string;
  chainId: number;
}

export interface RefundResult {
  refundId: string;
  state: 'completed' | 'failed';
  transactionHash?: string;
  keeperhubExecutionId?: string;
  error?: string;
}

/**
 * Execute a refund through KeeperHub.
 *
 * For testnet/hackathon: refunds are recorded in the ledger.
 * In production: this would transfer USDC back to the buyer.
 */
export async function executeRefund(
  request: RefundRequest,
  keeperHubClient: KeeperHubClient,
  ledger: Ledger,
): Promise<RefundResult> {
  const refundId = `ref_${randomUUID().replace(/-/g, '')}`;

  // Derive deterministic idempotency key for this refund
  const idempotencyKey = deriveRefundIdempotencyKey(
    request.quoteId,
    request.paymentTxHash ?? 'no-payment-tx',
    request.amountUsd,
  );

  // Record refund initiation
  const db = ledger.getDb();
  db.prepare(`
    INSERT INTO refunds (refund_id, order_id, reason, amount_usd, idempotency_key, state, created_at)
    VALUES (?, ?, ?, ?, ?, 'PENDING', ?)
  `).run(refundId, request.orderId, request.reason, request.amountUsd, idempotencyKey, new Date().toISOString());

  ledger.appendEvent('REFUND_ISSUED', refundId, {
    orderId: request.orderId,
    quoteId: request.quoteId,
    reason: request.reason,
    amountUsd: request.amountUsd,
    idempotencyKey,
  });

  // Execute refund transfer through KeeperHub
  // For testnet: use native ETH transfer as proof-of-concept
  // For production: this would be a USDC transfer
  try {
    const execResponse = await keeperHubClient.executeTransfer({
      chainId: request.chainId,
      recipientAddress: request.recipientAddress,
      amount: '0.000001', // Minimal testnet refund proof
    }, idempotencyKey);

    // Poll for completion
    const finalStatus = await keeperHubClient.pollUntilComplete(execResponse.executionId);

    if (finalStatus.status === 'completed') {
      db.prepare(`
        UPDATE refunds SET state = 'COMPLETED', keeperhub_execution_id = ?, transaction_hash = ?, completed_at = ?
        WHERE refund_id = ?
      `).run(execResponse.executionId, finalStatus.transactionHash, new Date().toISOString(), refundId);

      ledger.appendEvent('REFUND_COMPLETED', refundId, {
        transactionHash: finalStatus.transactionHash,
        keeperhubExecutionId: execResponse.executionId,
      });

      return {
        refundId,
        state: 'completed',
        transactionHash: finalStatus.transactionHash,
        keeperhubExecutionId: execResponse.executionId,
      };
    } else {
      db.prepare(`UPDATE refunds SET state = 'FAILED' WHERE refund_id = ?`).run(refundId);
      return { refundId, state: 'failed', error: finalStatus.error ?? 'Refund execution failed' };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    db.prepare(`UPDATE refunds SET state = 'FAILED' WHERE refund_id = ?`).run(refundId);
    return { refundId, state: 'failed', error: message };
  }
}
