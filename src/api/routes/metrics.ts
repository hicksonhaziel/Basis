/**
 * GET /metrics — Aggregate ledger statistics.
 */

import type { FastifyInstance } from 'fastify';
import type { BasisExecutor } from '../../executor/execute.ts';
import type { Ledger } from '../../ledger/database.ts';

export function registerMetricsRoutes(
  app: FastifyInstance,
  _executor: BasisExecutor,
  ledger: Ledger,
): void {
  app.get('/metrics', async (_request, reply) => {
    const db = ledger.getDb();

    const totalQuotes = (db.prepare(
      'SELECT COUNT(*) as count FROM quotes',
    ).get() as { count: number }).count;

    const totalOrders = (db.prepare(
      'SELECT COUNT(*) as count FROM orders',
    ).get() as { count: number }).count;

    const executionStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) as failed
      FROM executions
    `).get() as { total: number; completed: number; failed: number };

    const totalRefunds = (db.prepare(
      'SELECT COUNT(*) as count FROM refunds',
    ).get() as { count: number }).count;

    const auditChainLength = ledger.getEventCount();
    const lastHash = ledger.getLastHash();

    return reply.status(200).send({
      quotes: {
        total: totalQuotes,
      },
      orders: {
        total: totalOrders,
      },
      executions: {
        total: executionStats.total,
        completed: executionStats.completed ?? 0,
        failed: executionStats.failed ?? 0,
      },
      refunds: {
        total: totalRefunds,
      },
      auditChain: {
        length: auditChainLength,
        lastHash,
      },
    });
  });
}
