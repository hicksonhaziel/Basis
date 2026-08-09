/**
 * Refund execution is intentionally disabled.
 *
 * The state machine may enter REFUND_PENDING, but no transfer is attempted until a
 * real paid workflow, verified settlement metadata, recipient binding, token policy,
 * exact amount accounting, and independent refund verification are implemented.
 */
import type { KeeperHubClient } from '../keeperhub/client.ts';
import type { Ledger } from '../ledger/database.ts';

export interface RefundRequest {
  orderId: string;
  quoteId: string;
  reason: 'deadline_missed' | 'execution_failed' | 'resimulation_failed';
  amountUsd: string;
  recipientAddress: string;
  chainId: number;
}

export interface RefundResult {
  refundId: string;
  state: 'disabled';
  error: string;
}

export async function executeRefund(
  _request: RefundRequest,
  _keeperHubClient: KeeperHubClient,
  _ledger: Ledger,
): Promise<RefundResult> {
  throw new Error('Refund execution is disabled until verified marketplace payment settlement is implemented');
}
