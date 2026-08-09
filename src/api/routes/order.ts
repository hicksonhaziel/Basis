/** POST /orders — authenticated private-workflow ingress. This endpoint does not prove payment. */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { BasisExecutor } from '../../executor/execute.ts';
import type { Ledger } from '../../ledger/database.ts';
import { isQuoteExpired } from '../../quoter/quote.ts';
import type { Quote } from '../../quoter/quote.ts';

const INGRESS_SOURCE = 'keeperhub-private-workflow';
const OrderRequestBody = Type.Object({ quoteId: Type.String({ minLength: 1 }) }, { additionalProperties: false });

function secretMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

export function registerOrderRoutes(
  app: FastifyInstance,
  executor: BasisExecutor,
  ledger: Ledger,
  orderIngressSecret: string,
): void {
  if (orderIngressSecret.length < 32) throw new Error('Order ingress secret must be at least 32 characters');

  app.post('/orders', { schema: { body: OrderRequestBody } }, async (request, reply) => {
    if (!secretMatches(request.headers.authorization, orderIngressSecret)) {
      return reply.status(401).send({ error: 'Unauthorized order ingress' });
    }
    if (request.headers['x-basis-ingress-source'] !== INGRESS_SOURCE) {
      return reply.status(403).send({ error: 'Missing trusted private-workflow ingress marker; this marker is not payment proof' });
    }

    try {
      const { quoteId } = request.body as { quoteId: string };
      const quoteRow = ledger.getDb().prepare('SELECT * FROM quotes WHERE quote_id = ?').get(quoteId) as Record<string, unknown> | undefined;
      if (!quoteRow) return reply.status(400).send({ error: `Quote not found: ${quoteId}` });

      const quote: Quote = {
        quoteId: quoteRow.quote_id as string,
        jobHash: quoteRow.job_hash as string,
        jobType: quoteRow.job_type as string,
        chainId: quoteRow.chain_id as number,
        deadlineTier: quoteRow.deadline_tier as Quote['deadlineTier'],
        deadlineAt: quoteRow.deadline_at as string,
        expiresAt: quoteRow.expires_at as string,
        priceUsd: quoteRow.price_usd as string,
        paymentTier: quoteRow.payment_tier as string,
        pricingModelVersion: quoteRow.pricing_model_version as string,
        breakdown: JSON.parse(quoteRow.breakdown_json as string),
        simulation: JSON.parse(quoteRow.simulation_json as string),
        intent: JSON.parse(quoteRow.intent_json as string),
        signature: quoteRow.signature as string,
        issuedAt: quoteRow.issued_at as string,
      };

      if (quoteRow.consumed === 1) return reply.status(409).send({ error: `Quote ${quoteId} has already been consumed` });
      if (isQuoteExpired(quote)) return reply.status(400).send({ error: `Quote expired at ${quote.expiresAt}` });

      const result = await executor.executeOrder(quote, `ord_${randomUUID().replace(/-/g, '')}`);
      return reply.status(result.status === 'SUCCEEDED' ? 200 : 202).send({
        orderId: result.orderId,
        status: result.status,
        transactionHash: result.transactionHash,
        executionId: result.executionId,
        gasUsed: result.gasUsed,
        sponsored: result.sponsored,
        error: result.error,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (message.includes('already been consumed') || message.includes('Idempotency')) return reply.status(409).send({ error: message });
      return reply.status(400).send({ error: message });
    }
  });
}
