/** Tier-authenticated callback for the four paid KeeperHub Marketplace wrappers. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { BasisExecutor } from '../../executor/execute.ts';
import type { Ledger } from '../../ledger/database.ts';
import { isQuoteExpired, verifyQuoteSignature, validateSignedRefundTerms, type Quote } from '../../quoter/quote.ts';

export type PaidTier = 'basis-order-t1' | 'basis-order-t2' | 'basis-order-t3' | 'basis-order-t4';
export type TierCredentials = Record<PaidTier, string>;

const OrderRequestBody = Type.Object(
  { quoteId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

function credentialTier(header: string | undefined, credentials: TierCredentials): PaidTier | null {
  if (!header?.startsWith('Bearer ')) return null;
  const supplied = Buffer.from(header.slice(7));
  let matched: PaidTier | null = null;
  for (const [tier, secret] of Object.entries(credentials) as Array<[PaidTier, string]>) {
    const expected = Buffer.from(secret);
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) matched = tier;
  }
  return matched;
}

function quoteFromRow(row: Record<string, unknown>): Quote {
  return {
    canonicalizationFormat: row.canonicalization_format as Quote['canonicalizationFormat'],
    signatureFormat: row.signature_format as Quote['signatureFormat'],
    quoteId: row.quote_id as string,
    jobHash: row.job_hash as string,
    jobType: row.job_type as string,
    chainId: row.chain_id as number,
    deadlineTier: row.deadline_tier as Quote['deadlineTier'],
    deadlineAt: row.deadline_at as string,
    expiresAt: row.expires_at as string,
    priceUsd: row.price_usd as string,
    paymentTier: row.payment_tier as string,
    pricingModelVersion: row.pricing_model_version as string,
    breakdown: JSON.parse(row.breakdown_json as string),
    simulation: JSON.parse(row.simulation_json as string),
    intent: JSON.parse(row.intent_json as string),
    oracleEvidence: JSON.parse(row.oracle_evidence_json as string),
    refundRecipient: row.refund_recipient as `0x${string}`,
    refundPolicyId: row.refund_policy_id as string,
    refundChainId: row.refund_chain_id as number,
    refundTokenAddress: row.refund_token_address as `0x${string}`,
    grossRefundAmountUsd: row.gross_refund_amount_usd as string,
    refundAmountAtomic: row.refund_amount_atomic as string,
    signature: row.signature as string,
    issuedAt: row.issued_at as string,
  };
}

function stableOrderId(quoteId: string): string {
  return `ord_${createHash('sha256').update(`keeperhub-marketplace:${quoteId}`).digest('hex').slice(0, 32)}`;
}

export function registerOrderRoutes(
  app: FastifyInstance,
  executor: BasisExecutor,
  ledger: Ledger,
  credentials: TierCredentials,
  signingKey: string,
): void {
  for (const [tier, secret] of Object.entries(credentials)) {
    if (Buffer.byteLength(secret) < 32) throw new Error(`${tier} credential must contain at least 32 bytes`);
  }
  if (new Set(Object.values(credentials)).size !== 4) throw new Error('Paid tier workflow credentials must be distinct');

  app.post('/orders', {
    schema: { body: OrderRequestBody },
    preValidation: async (request, reply) => {
      const body = request.body as Record<string, unknown> | null;
      if (!body || Object.keys(body).length !== 1 || typeof body.quoteId !== 'string') {
        return reply.status(400).send({ error: 'Paid order callback accepts only quoteId' });
      }
    },
  }, async (request, reply) => {
    if (request.headers['x-basis-payment-authority'] !== undefined || request.headers['x-basis-ingress-source'] !== undefined) {
      return reply.status(400).send({ error: 'Legacy payment/source headers are not accepted as payment proof' });
    }
    const authenticatedTier = credentialTier(request.headers.authorization, credentials);
    if (!authenticatedTier) return reply.status(401).send({ error: 'Invalid paid workflow credential' });

    try {
      const { quoteId } = request.body as { quoteId: string };
      const quoteRow = ledger.getDb().prepare('SELECT * FROM quotes WHERE quote_id=?').get(quoteId) as Record<string, unknown> | undefined;
      if (!quoteRow) return reply.status(400).send({ error: `Quote not found: ${quoteId}` });
      const quote = quoteFromRow(quoteRow);
      if (!verifyQuoteSignature(quote, signingKey)) return reply.status(400).send({ error: 'Invalid quote signature' });
      if (isQuoteExpired(quote)) return reply.status(400).send({ error: `Quote expired at ${quote.expiresAt}` });
      if (quote.paymentTier !== authenticatedTier) {
        return reply.status(403).send({ error: `Authenticated workflow tier ${authenticatedTier} cannot authorize ${quote.paymentTier}` });
      }
      const refundError = validateSignedRefundTerms(quote);
      if (refundError) return reply.status(400).send({ error: refundError });
      if (quote.priceUsd !== quote.grossRefundAmountUsd) return reply.status(400).send({ error: 'Signed quote price and gross refundable tier amount differ' });
      if (!quote.refundRecipient) return reply.status(400).send({ error: 'Signed refundRecipient is required' });

      const existing = ledger.getDb().prepare('SELECT order_id,state FROM orders WHERE quote_id=?').get(quoteId) as { order_id: string; state: string } | undefined;
      if (existing) return reply.status(202).send({ orderId: existing.order_id, state: existing.state, duplicate: true });

      const orderId = stableOrderId(quoteId);
      const execution = executor.executeOrder(quote, orderId, 'MARKETPLACE_PAYMENT_AUTHORIZED', authenticatedTier);
      const admitted = ledger.getDb().prepare('SELECT order_id,state FROM orders WHERE quote_id=?').get(quoteId) as { order_id: string; state: string } | undefined;
      if (!admitted) await execution;
      else void execution.catch((error: unknown) => app.log.error({ err: error, orderId }, 'Asynchronous paid order execution failed'));

      const accepted = admitted ?? ledger.getDb().prepare('SELECT order_id,state FROM orders WHERE quote_id=?').get(quoteId) as { order_id: string; state: string } | undefined;
      if (!accepted) throw new Error('Asynchronous execution could not be started');
      return reply.status(202).send({ orderId: accepted.order_id, state: accepted.state, duplicate: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const existing = ledger.getDb().prepare('SELECT order_id,state FROM orders WHERE quote_id=?').get((request.body as { quoteId: string }).quoteId) as { order_id: string; state: string } | undefined;
      if (existing) return reply.status(202).send({ orderId: existing.order_id, state: existing.state, duplicate: true });
      return reply.status(400).send({ error: message });
    }
  });
}
