/**
 * POST /orders — Submit an order against a valid quote.
 */

import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { BasisExecutor } from '../../executor/execute.ts';
import type { Ledger } from '../../ledger/database.ts';
import { verifyQuoteSignature, isQuoteExpired } from '../../quoter/quote.ts';
import type { Quote } from '../../quoter/quote.ts';

const OrderRequestBody = Type.Object({
  quoteId: Type.String({ minLength: 1 }),
  paymentTxHash: Type.Optional(Type.String()),
  paymentTier: Type.Optional(Type.String()),
});

export function registerOrderRoutes(
  app: FastifyInstance,
  executor: BasisExecutor,
  ledger: Ledger,
): void {
  app.post('/orders', {
    schema: {
      body: OrderRequestBody,
    },
  }, async (request, reply) => {
    try {
      const { quoteId, paymentTxHash } = request.body as {
        quoteId: string;
        paymentTxHash?: string;
      };

      // Retrieve quote from ledger
      const db = ledger.getDb();
      const quoteRow = db.prepare(
        'SELECT * FROM quotes WHERE quote_id = ?',
      ).get(quoteId) as Record<string, unknown> | undefined;

      if (!quoteRow) {
        return reply.status(400).send({ error: `Quote not found: ${quoteId}` });
      }

      // Reconstruct the Quote object for signature verification
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
        signature: quoteRow.signature as string,
        issuedAt: quoteRow.issued_at as string,
      };

      // Validate: not consumed
      if (quoteRow.consumed === 1) {
        return reply.status(409).send({ error: `Quote ${quoteId} has already been consumed` });
      }

      // Validate: not expired
      if (isQuoteExpired(quote)) {
        return reply.status(400).send({ error: `Quote expired at ${quote.expiresAt}` });
      }

      // Validate: payment tier matches (if buyer specifies it)
      const { paymentTier } = request.body as { quoteId: string; paymentTxHash?: string; paymentTier?: string };
      if (paymentTier && paymentTier !== quote.paymentTier) {
        return reply.status(400).send({
          error: `Payment tier mismatch: quote requires ${quote.paymentTier}, got ${paymentTier}`,
        });
      }

      // Validate: signature (uses signing key from env, executor handles this internally)
      // The executor.executeOrder will verify signature and expiry again as a safety check

      const orderId = `ord_${randomUUID().replace(/-/g, '')}`;

      const result = await executor.executeOrder(quote, orderId);

      if (result.status === 'completed') {
        return reply.status(200).send({
          orderId: result.orderId,
          status: result.status,
          transactionHash: result.transactionHash,
          executionId: result.executionId,
          gasUsed: result.gasUsed,
          sponsored: result.sponsored,
        });
      } else {
        return reply.status(202).send({
          orderId: result.orderId,
          status: result.status,
          executionId: result.executionId,
          error: result.error,
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';

      // Idempotency or consumed errors → 409
      if (message.includes('already been consumed') || message.includes('Idempotency')) {
        return reply.status(409).send({ error: message });
      }

      return reply.status(400).send({ error: message });
    }
  });
}
