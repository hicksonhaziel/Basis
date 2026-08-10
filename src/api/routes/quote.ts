/** POST /quote and /quotes — request a signed execution quote without execution. */
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BasisExecutor } from '../../executor/execute.ts';
import type { Ledger } from '../../ledger/database.ts';

const QuoteRequestBody = Type.Object({
  jobType: Type.String({ minLength: 1 }),
  params: Type.Unknown(),
  chainId: Type.Integer({ minimum: 1 }),
  deadlineTier: Type.Union([Type.Literal('next-block'), Type.Literal('5m'), Type.Literal('1h'), Type.Literal('best-effort')]),
  refundRecipient: Type.String({ pattern: '^0x[a-fA-F0-9]{40}$' }),
}, { additionalProperties: false });

export function registerQuoteRoutes(app: FastifyInstance, executor: BasisExecutor, _ledger: Ledger): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as {
        jobType: string; params: unknown; chainId: number;
        deadlineTier: 'next-block' | '5m' | '1h' | 'best-effort'; refundRecipient: string;
      };
      const quote = await executor.requestQuote(body);
      return reply.status(200).send(quote);
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
  };
  app.post('/quote', { schema: { body: QuoteRequestBody } }, handler);
  app.post('/quotes', { schema: { body: QuoteRequestBody } }, handler);
}
