/**
 * GET /orders/:id — Retrieve order status and execution details.
 */

import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { BasisExecutor } from '../../executor/execute.ts';
import type { Ledger } from '../../ledger/database.ts';

const OrderParams = Type.Object({
  id: Type.String({ minLength: 1 }),
});

export function registerStatusRoutes(
  app: FastifyInstance,
  _executor: BasisExecutor,
  ledger: Ledger,
): void {
  app.get('/orders/:id', {
    schema: {
      params: OrderParams,
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const db = ledger.getDb();

    // Look up order
    const order = db.prepare(
      'SELECT * FROM orders WHERE order_id = ?',
    ).get(id) as Record<string, unknown> | undefined;

    if (!order) {
      return reply.status(404).send({ error: `Order not found: ${id}` });
    }

    // Look up associated execution(s)
    const execution = db.prepare(
      'SELECT * FROM executions WHERE order_id = ? ORDER BY started_at DESC LIMIT 1',
    ).get(id) as Record<string, unknown> | undefined;

    return reply.status(200).send({
      orderId: order.order_id,
      quoteId: order.quote_id,
      state: order.state,
      authorityKind: order.authority_kind,
      paid: order.authority_kind === 'VERIFIED_MARKETPLACE_PAYMENT',
      paymentAmountUsd: order.payment_amount_usd,
      createdAt: order.created_at,
      updatedAt: order.updated_at,
      execution: execution ? {
        executionId: execution.execution_id,
        keeperhubExecutionId: execution.keeperhub_execution_id ?? null,
        idempotencyKey: execution.idempotency_key,
        chainId: execution.chain_id,
        state: execution.state,
        transactionHash: execution.transaction_hash ?? null,
        gasUsed: execution.gas_used ?? null,
        gasUsedWei: execution.gas_used_wei ?? null,
        sponsored: execution.sponsored === 1,
        startedAt: execution.started_at,
        completedAt: execution.completed_at ?? null,
        error: execution.error ?? null,
      } : null,
    });
  });
}
