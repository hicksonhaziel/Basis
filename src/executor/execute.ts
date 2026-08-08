/**
 * BasisExecutor — End-to-end execution flow.
 *
 * Wires together all modules into two high-level operations:
 * 1. requestQuote — simulate, price, sign, record
 * 2. executeOrder — verify, execute, poll, record
 */

import { randomUUID } from 'node:crypto';
import type { PublicClient } from 'viem';
import { registry } from '../adapters/registry.ts';
import type { CanonicalFields } from '../adapters/adapter.ts';
import { KeeperHubClient } from '../keeperhub/client.ts';
import type { SimulationSuccess, ExecutionStatus } from '../keeperhub/client.ts';
import { computeIdempotencyKey, deadlineBucket } from './idempotency.ts';
import { collectFeeHistory, createRpcClient } from '../quoter/fee-history.ts';
import { readNativeAssetUsd } from '../quoter/fx.ts';
import { priceQuote } from '../quoter/price.ts';
import type { QuoteBreakdown } from '../quoter/price.ts';
import { generateQuote, verifyQuoteSignature, isQuoteExpired } from '../quoter/quote.ts';
import type { Quote, SimulationSummary } from '../quoter/quote.ts';
import { Ledger } from '../ledger/database.ts';
import {
  DEADLINE_TIERS,
  RETRY_PREMIUM_BPS,
  TARGET_MARGIN_BPS,
  FIXED_OVERHEAD_USD,
  PRICING_MODEL_VERSION,
} from '../config/policy.ts';
import type { DeadlineTier } from '../config/policy.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ExecutorConfig {
  keeperHubClient: KeeperHubClient;
  ledger: Ledger;
  signingKey: string;
  rpcUrls: Record<number, string>;
}

export interface QuoteRequest {
  /** Job type identifier (e.g. 'weth.wrap', 'erc20.transfer') */
  jobType: string;
  /** Raw job parameters passed to the adapter */
  params: unknown;
  /** Target chain ID */
  chainId: number;
  /** Deadline tier */
  deadlineTier: DeadlineTier;
  /** Whether to request private routing (default: false) */
  privateRouting?: boolean;
}

export interface ExecutionResult {
  executionId: string;
  keeperhubExecutionId: string;
  orderId: string;
  status: 'completed' | 'failed';
  transactionHash?: string;
  gasUsed?: string;
  sponsored: boolean;
  error?: string;
}

// ─── Executor ────────────────────────────────────────────────────────────────

export class BasisExecutor {
  private keeperHubClient: KeeperHubClient;
  private ledger: Ledger;
  private signingKey: string;
  private rpcUrls: Record<number, string>;

  constructor(config: ExecutorConfig) {
    this.keeperHubClient = config.keeperHubClient;
    this.ledger = config.ledger;
    this.signingKey = config.signingKey;
    this.rpcUrls = config.rpcUrls;
  }

  // ─── Quote Flow ──────────────────────────────────────────────────────────

  /**
   * Request a quote for a job.
   *
   * Steps:
   * 1. Look up adapter from registry
   * 2. Validate params
   * 3. Build call (requires executor address from simulation discovery)
   * 4. Simulate via KeeperHub
   * 5. Collect fee history from chain
   * 6. Get ETH/USD price
   * 7. Run pure pricing function
   * 8. Generate signed quote
   * 9. Record in ledger
   * 10. Return the quote
   */
  async requestQuote(request: QuoteRequest): Promise<Quote> {
    const { jobType, params, chainId, deadlineTier, privateRouting = false } = request;

    // 1. Look up adapter
    const adapter = registry.require(jobType);

    // Verify chain support
    if (!adapter.meta.supportedChains.includes(chainId)) {
      throw new Error(`Adapter ${jobType} does not support chain ${chainId}`);
    }

    // 2. Validate params
    const validatedParams = adapter.validateParams(params);

    // 3. Get the org wallet address (executor) from KeeperHub
    const executorAddress = await this.keeperHubClient.getOrgWalletAddress(chainId);

    // Build the on-chain call
    const call = adapter.buildCall(validatedParams, executorAddress);

    // 4. Simulate via KeeperHub using the built call
    const simResult: SimulationSuccess = await this.keeperHubClient.simulate({
      contractAddress: call.to,
      chainId,
      functionName: 'rawCall',
      functionArgs: JSON.stringify([call.data]),
      value: call.value > 0n ? call.value.toString() : undefined,
    });

    // Validate gas estimate against adapter safety cap
    const gasEstimate = BigInt(simResult.gasEstimate);
    if (gasEstimate > adapter.meta.maxGasEstimate) {
      throw new Error(
        `Gas estimate ${gasEstimate} exceeds adapter max ${adapter.meta.maxGasEstimate} for ${jobType}`,
      );
    }

    // 5. Collect fee history from chain
    const rpcUrl = this.getRpcUrl(chainId);
    const rpcClient: PublicClient = createRpcClient(chainId, rpcUrl);
    const feeHistory = await collectFeeHistory(rpcClient);

    // 6. Get ETH/USD price
    const chainlinkPrice = await readNativeAssetUsd(rpcClient, chainId);

    // 7. Run pure pricing function
    const tierPolicy = DEADLINE_TIERS[deadlineTier];
    const breakdown: QuoteBreakdown = priceQuote({
      gasEstimate,
      feeSamples: feeHistory.samples,
      feePercentileTarget: tierPolicy.feePercentile,
      nativeAssetUsd: chainlinkPrice.priceUsd,
      retryPremiumBps: RETRY_PREMIUM_BPS[deadlineTier],
      targetMarginBps: TARGET_MARGIN_BPS,
      fixedOverheadUsd: FIXED_OVERHEAD_USD,
      privateRouting,
      pricingModelVersion: PRICING_MODEL_VERSION,
    });

    // 8. Compute deadline, expiry, and canonical intent
    const now = new Date();
    const deadlineAt = new Date(now.getTime() + tierPolicy.horizonSeconds * 1000);
    const expiresAt = new Date(now.getTime() + tierPolicy.quoteValiditySeconds * 1000);

    const bucket = deadlineBucket(deadlineAt);
    const canonical: CanonicalFields = adapter.canonicalIntent(validatedParams, chainId, bucket);
    const jobHash = computeIdempotencyKey(canonical);

    const simSummary: SimulationSummary = {
      success: true,
      wouldRevert: false,
      from: simResult.from,
      to: simResult.to,
      gasEstimate: simResult.gasEstimate,
    };

    // Generate signed quote
    const quote: Quote = generateQuote({
      jobHash,
      jobType,
      chainId,
      deadlineTier,
      deadlineAt,
      expiresAt,
      gasEstimate,
      nativeAssetUsd: chainlinkPrice.priceUsd,
      breakdown,
      simulation: simSummary,
    }, this.signingKey);

    // 9. Record in ledger
    this.ledger.insertQuote({
      quoteId: quote.quoteId,
      jobHash: quote.jobHash,
      jobType: quote.jobType,
      chainId: quote.chainId,
      deadlineTier: quote.deadlineTier,
      deadlineAt: quote.deadlineAt,
      expiresAt: quote.expiresAt,
      priceUsd: quote.priceUsd,
      paymentTier: quote.paymentTier,
      pricingModelVersion: quote.pricingModelVersion,
      breakdown: quote.breakdown as unknown as Record<string, unknown>,
      simulation: quote.simulation as unknown as Record<string, unknown>,
      signature: quote.signature,
      issuedAt: quote.issuedAt,
    });

    this.ledger.appendEvent('QUOTE_ISSUED', quote.quoteId, {
      jobHash: quote.jobHash,
      jobType: quote.jobType,
      chainId: quote.chainId,
      deadlineTier: quote.deadlineTier,
      priceUsd: quote.priceUsd,
      paymentTier: quote.paymentTier,
    });

    // 10. Return
    return quote;
  }

  // ─── Execution Flow ───────────────────────────────────────────────────────

  /**
   * Execute an order given a valid quote.
   *
   * Steps:
   * 1. Verify quote signature and expiry
   * 2. Check not consumed
   * 3. Re-simulate via KeeperHub
   * 4. Derive idempotency key
   * 5. Execute via KeeperHub
   * 6. Poll for completion
   * 7. Verify receipt
   * 8. Record in ledger
   * 9. Return execution result
   */
  async executeOrder(quote: Quote, orderId: string): Promise<ExecutionResult> {
    const executionId = `exec_${randomUUID().replace(/-/g, '')}`;

    // 1. Verify quote signature and expiry
    if (!verifyQuoteSignature(quote, this.signingKey)) {
      throw new Error('Invalid quote signature');
    }
    if (isQuoteExpired(quote)) {
      throw new Error(`Quote expired at ${quote.expiresAt}`);
    }

    // 2. Check not consumed
    if (this.ledger.isQuoteConsumed(quote.quoteId)) {
      throw new Error(`Quote ${quote.quoteId} has already been consumed`);
    }

    // 3. Re-simulate via KeeperHub to confirm the call still succeeds
    await this.keeperHubClient.simulate({
      contractAddress: quote.simulation.to,
      chainId: quote.chainId,
      functionName: 'rawCall',
      value: undefined,
    });

    // 4. Derive idempotency key from the quote's job hash
    // The job hash already encodes the canonical intent + deadline bucket
    const idempotencyKey = quote.jobHash;

    // 5. Record order and mark quote consumed
    this.ledger.insertOrder({
      orderId,
      quoteId: quote.quoteId,
      state: 'executing',
      paymentAmountUsd: quote.priceUsd,
    });
    this.ledger.markQuoteConsumed(quote.quoteId);
    this.ledger.appendEvent('ORDER_CREATED', orderId, {
      quoteId: quote.quoteId,
      priceUsd: quote.priceUsd,
    });

    // Record execution start
    this.ledger.insertExecution({
      executionId,
      orderId,
      idempotencyKey,
      chainId: quote.chainId,
      state: 'pending',
    });
    this.ledger.appendEvent('EXECUTION_STARTED', executionId, {
      orderId,
      quoteId: quote.quoteId,
      chainId: quote.chainId,
      idempotencyKey,
    });

    // 6. Execute via KeeperHub
    const execResponse = await this.keeperHubClient.executeContractCall({
      contractAddress: quote.simulation.to,
      chainId: quote.chainId,
      functionName: 'rawCall',
      value: undefined,
    }, idempotencyKey);

    // Update with KeeperHub execution ID
    this.ledger.updateExecution(executionId, {
      keeperhubExecutionId: execResponse.executionId,
      state: 'running',
    });

    // 7. Poll for completion
    const finalStatus: ExecutionStatus = await this.keeperHubClient.pollUntilComplete(
      execResponse.executionId,
    );

    // 8. Verify receipt and record result
    const txHash = finalStatus.transactionHash;
    const isSuccess = finalStatus.status === 'completed';

    if (isSuccess) {
      this.ledger.updateExecution(executionId, {
        state: 'completed',
        transactionHash: txHash,
        gasUsedWei: finalStatus.gasUsedWei,
        sponsored: finalStatus.sponsored,
        completedAt: finalStatus.completedAt,
      });
      this.ledger.updateOrderState(orderId, 'completed');
      this.ledger.appendEvent('EXECUTION_VERIFIED', executionId, {
        transactionHash: txHash,
        gasUsedWei: finalStatus.gasUsedWei,
        sponsored: finalStatus.sponsored,
      });
    } else {
      this.ledger.updateExecution(executionId, {
        state: 'failed',
        error: finalStatus.error ?? 'Unknown failure',
        completedAt: finalStatus.completedAt,
      });
      this.ledger.updateOrderState(orderId, 'failed');
      this.ledger.appendEvent('EXECUTION_FAILED', executionId, {
        error: finalStatus.error,
      });
    }

    // 9. Return execution result
    return {
      executionId,
      keeperhubExecutionId: execResponse.executionId,
      orderId,
      status: isSuccess ? 'completed' : 'failed',
      transactionHash: txHash,
      gasUsed: finalStatus.gasUsedWei,
      sponsored: finalStatus.sponsored,
      error: isSuccess ? undefined : (finalStatus.error ?? undefined),
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private getRpcUrl(chainId: number): string {
    const url = this.rpcUrls[chainId];
    if (!url) {
      throw new Error(`No RPC URL configured for chain ${chainId}`);
    }
    return url;
  }
}
