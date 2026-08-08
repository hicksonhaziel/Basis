/**
 * POST /quotes — Request a price quote for a job execution.
 */

import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { BasisExecutor } from '../../executor/execute.ts';
import type { Ledger } from '../../ledger/database.ts';

const QuoteRequestBody = Type.Object({
  jobType: Type.String({ minLength: 1 }),
  params: Type.Unknown(),
  chainId: Type.Integer({ minimum: 1 }),
  deadlineTier: Type.Union([
    Type.Literal('next-block'),
    Type.Literal('5m'),
    Type.Literal('1h'),
    Type.Literal('best-effort'),
  ]),
  privateRouting: Type.Optional(Type.Boolean()),
});

export function registerQuoteRoutes(
  app: FastifyInstance,
  executor: BasisExecutor,
  _ledger: Ledger,
): void {
  app.post('/quotes', {
    schema: {
      body: QuoteRequestBody,
    },
  }, async (request, reply) => {
    try {
      const { jobType, params, chainId, deadlineTier, privateRouting } = request.body as {
        jobType: string;
        params: unknown;
        chainId: number;
        deadlineTier: 'next-block' | '5m' | '1h' | 'best-effort';
        privateRouting?: boolean;
      };

      const quote = await executor.requestQuote({
        jobType,
        params,
        chainId,
        deadlineTier,
        privateRouting,
      });

      return reply.status(200).send(quote);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(400).send({ error: message });
    }
  });
}
