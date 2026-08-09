/** Deterministic quote and execution orchestration. No model or agent participates. */
import { randomUUID } from 'node:crypto';
import type { PublicClient } from 'viem';
import { registry } from '../adapters/registry.ts';
import type { CanonicalFields } from '../adapters/adapter.ts';
import { KeeperHubClient, type ExecutionStatus, type SimulationSuccess } from '../keeperhub/client.ts';
import { KeeperHubError, IdempotencyConflictError, IdempotencyInProgressError } from '../keeperhub/errors.ts';
import { computeIdempotencyKey, deadlineBucket } from './idempotency.ts';
import { collectFeeHistory, createRpcClient } from '../quoter/fee-history.ts';
import { Decimal } from 'decimal.js';
import { readNativeAssetUsd, buildChainlinkPrice, assertPriceWithinDivergence } from '../quoter/fx.ts';
import { priceQuote, type QuoteBreakdown } from '../quoter/price.ts';
import { generateQuote, verifyQuoteSignature, isQuoteExpired, type Quote, type SimulationSummary } from '../quoter/quote.ts';
import { Ledger } from '../ledger/database.ts';
import { DEADLINE_TIERS, TARGET_MARGIN_BPS, FIXED_OVERHEAD_USD, PRICING_MODEL_VERSION, type DeadlineTier } from '../config/policy.ts';
import { assertRequestMatchesIntent, assertSimulationMatchesIntent, keeperHubRequest, stableJson, toJsonValue, type CanonicalExecutionIntent, type PersistedExecutionIntent } from './intent.ts';
import { verifyExecution, VerificationFailure, VerificationUncertain, type IndependentRpc } from './verify.ts';
import type { OrderState } from './state-machine.ts';

export interface ExecutorConfig {
  keeperHubClient: KeeperHubClient;
  ledger: Ledger;
  signingKey: string;
  rpcUrls: Record<number, string>;
  rpcClientFactory?: (chainId: number, rpcUrl: string) => PublicClient;
  environment?: 'local' | 'testnet' | 'production';
  oracleMaxStalenessSeconds?: number;
  oracleMaxDivergenceBps?: number;
  oracleReference?: { priceUsd: string; updatedAt: number };
  allowTestFxFallback?: boolean;
  testFxFallbackUsd?: string;
}
export interface QuoteRequest { jobType: string; params: unknown; chainId: number; deadlineTier: DeadlineTier; }
export interface ExecutionResult { executionId: string; keeperhubExecutionId?: string; orderId: string; status: OrderState; transactionHash?: string; gasUsed?: string; sponsored: boolean; error?: string; deadlineHit?: boolean; }

export class BasisExecutor {
  private keeperHubClient: KeeperHubClient;
  private ledger: Ledger;
  private signingKey: string;
  private rpcUrls: Record<number, string>;
  private rpcClientFactory: (chainId: number, rpcUrl: string) => PublicClient;
  private config: ExecutorConfig;

  constructor(config: ExecutorConfig) {
    this.config = config;
    this.keeperHubClient = config.keeperHubClient;
    this.ledger = config.ledger;
    this.signingKey = config.signingKey;
    this.rpcUrls = config.rpcUrls;
    this.rpcClientFactory = config.rpcClientFactory ?? createRpcClient;
  }

  async requestQuote(request: QuoteRequest): Promise<Quote> {
    const { jobType, params, chainId, deadlineTier } = request;
    const adapter = registry.require(jobType);
    if (!adapter.meta.supportedChains.includes(chainId)) throw new Error(`Adapter ${jobType} does not support chain ${chainId}`);
    const validatedParams = adapter.validateParams(params, chainId);
    const executorAddress = await this.keeperHubClient.getOrgWalletAddress(chainId);
    const simulationRequest = adapter.buildSimulation(validatedParams);
    const call = adapter.buildCall(validatedParams, executorAddress);
    if (call.to.toLowerCase() !== simulationRequest.contractAddress.toLowerCase()) throw new Error('Adapter call and simulation target mismatch');

    const simulation = await this.keeperHubClient.simulate({ ...simulationRequest, chainId });
    const gasEstimate = BigInt(simulation.gasEstimate);
    if (gasEstimate > adapter.meta.maxGasEstimate) throw new Error(`Gas estimate ${gasEstimate} exceeds adapter max ${adapter.meta.maxGasEstimate} for ${jobType}`);

    const rpcClient = this.createRpc(chainId);
    const feeHistory = await collectFeeHistory(rpcClient);
    const reference = this.config.oracleReference;
    const maxStaleness = this.config.oracleMaxStalenessSeconds ?? 3600;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (reference && (nowSeconds - reference.updatedAt < 0 || nowSeconds - reference.updatedAt > maxStaleness)) {
      throw new Error('Independent oracle reference is stale or future-dated');
    }
    let chainlinkPrice;
    let oracleEvidence;
    try {
      chainlinkPrice = await readNativeAssetUsd(rpcClient, chainId, {
        maxStalenessSeconds: maxStaleness,
        referencePriceUsd: reference ? new Decimal(reference.priceUsd) : undefined,
        maxDivergenceBps: this.config.oracleMaxDivergenceBps ?? 500,
      });
      const divergence = reference
        ? assertPriceWithinDivergence(chainlinkPrice.priceUsd, new Decimal(reference.priceUsd), this.config.oracleMaxDivergenceBps ?? 500)
        : undefined;
      oracleEvidence = {
        source: 'chainlink' as const,
        observedAt: new Date().toISOString(),
        feedUpdatedAt: new Date(chainlinkPrice.updatedAt * 1000).toISOString(),
        ...(reference ? { referencePriceUsd: reference.priceUsd, divergenceBps: divergence!.toFixed(2) } : {}),
      };
    } catch (error) {
      if (this.config.environment === 'production' || !this.config.allowTestFxFallback || !this.config.testFxFallbackUsd) throw error;
      chainlinkPrice = buildChainlinkPrice(this.config.testFxFallbackUsd, chainId);
      oracleEvidence = { source: 'explicit-non-production-fallback' as const, observedAt: new Date().toISOString() };
    }
    const policy = DEADLINE_TIERS[deadlineTier];
    const breakdown: QuoteBreakdown = priceQuote({ gasEstimate, feeSamples: feeHistory.samples, feePercentileTarget: policy.feePercentile, nativeAssetUsd: chainlinkPrice.priceUsd, targetMarginBps: TARGET_MARGIN_BPS, fixedOverheadUsd: FIXED_OVERHEAD_USD, pricingModelVersion: PRICING_MODEL_VERSION });
    const now = new Date();
    const deadlineAt = new Date(now.getTime() + policy.horizonSeconds * 1000);
    const expiresAt = new Date(now.getTime() + policy.quoteValiditySeconds * 1000);
    const canonical: CanonicalFields = adapter.canonicalIntent(validatedParams, chainId, deadlineBucket(deadlineAt));
    const jobHash = computeIdempotencyKey(canonical);
    const intent: CanonicalExecutionIntent = {
      adapterName: adapter.meta.jobType,
      adapterVersion: adapter.meta.version,
      chainId,
      target: call.to,
      functionName: simulationRequest.functionName,
      functionArgs: simulationRequest.functionArgs,
      abi: simulationRequest.abi,
      calldata: call.data,
      nativeValueWei: call.value.toString(),
      keeperHubValue: simulationRequest.value,
      executorAddress,
      deadlineAt: deadlineAt.toISOString(),
      validatedParams: toJsonValue(validatedParams),
    };
    const simSummary: SimulationSummary = { success: true, wouldRevert: false, from: simulation.from, to: simulation.to, gasEstimate: simulation.gasEstimate, functionName: simulationRequest.functionName, functionArgs: simulationRequest.functionArgs, abi: simulationRequest.abi, value: simulationRequest.value };
    const quote = generateQuote({ jobHash, jobType, chainId, deadlineTier, deadlineAt, expiresAt, gasEstimate, nativeAssetUsd: chainlinkPrice.priceUsd, breakdown, simulation: simSummary, intent, oracleEvidence }, this.signingKey);
    this.ledger.insertQuote({ quoteId: quote.quoteId, jobHash: quote.jobHash, jobType: quote.jobType, chainId: quote.chainId, deadlineTier: quote.deadlineTier, deadlineAt: quote.deadlineAt, expiresAt: quote.expiresAt, priceUsd: quote.priceUsd, paymentTier: quote.paymentTier, pricingModelVersion: quote.pricingModelVersion, breakdown: quote.breakdown as unknown as Record<string, unknown>, simulation: quote.simulation as unknown as Record<string, unknown>, intent: quote.intent as unknown as Record<string, unknown>, oracleEvidence: quote.oracleEvidence as unknown as Record<string, unknown>, canonicalizationFormat: quote.canonicalizationFormat, signatureFormat: quote.signatureFormat, signature: quote.signature, issuedAt: quote.issuedAt });
    this.ledger.appendEvent('QUOTE_ISSUED', quote.quoteId, { jobHash, jobType, chainId, deadlineTier, priceUsd: quote.priceUsd, paymentTier: quote.paymentTier });
    return quote;
  }

  async executeOrder(quote: Quote, orderId: string): Promise<ExecutionResult> {
    const executionId = `exec_${randomUUID().replace(/-/g, '')}`;
    if (!verifyQuoteSignature(quote, this.signingKey)) throw new Error('Invalid quote signature');
    if (isQuoteExpired(quote)) throw new Error(`Quote expired at ${quote.expiresAt}`);
    this.assertQuoteIntent(quote);
    const adapter = registry.require(quote.jobType);
    const params = adapter.validateParams(quote.intent.validatedParams, quote.chainId);
    const rebuiltCall = adapter.buildCall(params, quote.intent.executorAddress);
    const rebuiltSimulation = adapter.buildSimulation(params);
    if (rebuiltCall.to.toLowerCase() !== quote.intent.target.toLowerCase() || rebuiltCall.data.toLowerCase() !== quote.intent.calldata.toLowerCase() || rebuiltCall.value.toString() !== quote.intent.nativeValueWei) throw new Error('Adapter call differs from signed canonical intent');
    if (stableJson(rebuiltSimulation) !== stableJson({ contractAddress: quote.intent.target, functionName: quote.intent.functionName, functionArgs: quote.intent.functionArgs, abi: quote.intent.abi, value: quote.intent.keeperHubValue })) throw new Error('Adapter simulation request differs from signed canonical intent');
    if (BigInt(quote.breakdown.gasEstimate) > adapter.meta.maxGasEstimate) throw new Error(`Quoted gas estimate exceeds adapter max for ${quote.jobType}`);

    const idempotencyKey = quote.jobHash;
    const intent: PersistedExecutionIntent = { ...quote.intent, quoteId: quote.quoteId, orderId, idempotencyKey };
    const outbound = keeperHubRequest(intent);
    assertRequestMatchesIntent(outbound, intent);
    this.ledger.admitOrder({ quoteId: quote.quoteId, orderId, executionId, authorityKind: 'AUTHENTICATED_PRIVATE_WORKFLOW', paymentAmountUsd: quote.priceUsd, idempotencyKey, chainId: quote.chainId, intent, outboundRequest: outbound });
    this.ledger.transitionOrder(orderId, 'RESIMULATING', 'authenticated private ingress admitted; payment not asserted');

    let resimulation: SimulationSuccess;
    try {
      resimulation = await this.keeperHubClient.simulate(outbound);
      assertSimulationMatchesIntent(resimulation, intent);
      if (BigInt(resimulation.gasEstimate) > adapter.meta.maxGasEstimate) throw new Error(`Re-simulation gas estimate ${resimulation.gasEstimate} exceeds adapter max ${adapter.meta.maxGasEstimate}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ledger.transitionOrder(orderId, 'REFUND_PENDING', `re-simulation rejected: ${message}; no refund is executed in this phase`);
      return { executionId, orderId, status: 'REFUND_PENDING', sponsored: false, error: message };
    }

    this.ledger.transitionOrder(orderId, 'EXECUTING', 'exact re-simulation matched signed canonical intent');
    let keeperhubExecutionId: string;
    let idempotentReplay = false;
    try {
      const response = await this.keeperHubClient.executeContractCall(outbound, idempotencyKey);
      keeperhubExecutionId = response.executionId;
      idempotentReplay = response.idempotentReplay === true;
    } catch (error) {
      if (error instanceof IdempotencyInProgressError && error.originalExecutionId) {
        keeperhubExecutionId = error.originalExecutionId;
        idempotentReplay = true;
      } else if (error instanceof IdempotencyConflictError) {
        this.ledger.transitionOrder(orderId, 'FAILED', 'KeeperHub idempotency conflict; fail closed');
        this.ledger.transitionOrder(orderId, 'REFUND_PENDING', 'verified submission conflict; refund execution disabled in this phase');
        return { executionId, orderId, status: 'REFUND_PENDING', sponsored: false, error: error.message };
      } else {
        this.ledger.transitionOrder(orderId, 'UNCERTAIN', `submission result ambiguous: ${error instanceof Error ? error.message : String(error)}`);
        return { executionId, orderId, status: 'UNCERTAIN', sponsored: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    this.ledger.recordSubmission(executionId, keeperhubExecutionId, idempotentReplay);

    let finalStatus: ExecutionStatus;
    try { finalStatus = await this.keeperHubClient.pollUntilComplete(keeperhubExecutionId); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.ledger.transitionOrder(orderId, 'UNCERTAIN', `KeeperHub polling ambiguous: ${message}`);
      return { executionId, keeperhubExecutionId, orderId, status: 'UNCERTAIN', sponsored: false, error: message };
    }
    if (finalStatus.status === 'failed') {
      this.ledger.transitionOrder(orderId, 'FAILED', `KeeperHub reported failed: ${finalStatus.error ?? 'unknown error'}`);
      this.ledger.transitionOrder(orderId, 'REFUND_PENDING', 'verified execution failure; refund execution disabled in this phase');
      return { executionId, keeperhubExecutionId, orderId, status: 'REFUND_PENDING', sponsored: finalStatus.sponsored, error: finalStatus.error ?? undefined };
    }

    this.ledger.transitionOrder(orderId, 'VERIFYING', 'KeeperHub terminal status received; independent verification required');
    try {
      const verified = await verifyExecution(finalStatus, intent, adapter, params, this.createRpc(quote.chainId) as unknown as IndependentRpc);
      this.ledger.recordReceipt({ executionId, transactionHash: verified.transactionHash, chainId: quote.chainId, keeperHubVerified: true, independentVerified: true, receiptStatus: 'success', blockNumber: verified.blockNumber, gasUsed: verified.gasUsed, decodedLogs: verified.decodedLogs, postconditions: verified.postconditions });
      this.ledger.updateExecution(executionId, { transactionHash: verified.transactionHash, gasUsed: verified.gasUsed.toString(), gasUsedWei: finalStatus.gasUsedWei, sponsored: finalStatus.sponsored, completedAt: finalStatus.completedAt ?? new Date().toISOString() });
      const late = new Date(finalStatus.completedAt ?? Date.now()).getTime() > new Date(quote.deadlineAt).getTime();
      if (late) {
        this.ledger.transitionOrder(orderId, 'LATE', 'independently verified success completed after contractual deadline');
        this.ledger.appendEvent('EXECUTION_VERIFIED', executionId, { transactionHash: verified.transactionHash, blockNumber: verified.blockNumber.toString(), postconditions: verified.postconditions, deadlineHit: false });
        this.ledger.transitionOrder(orderId, 'REFUND_PENDING', 'deadline missed; refund execution disabled in this phase');
        return { executionId, keeperhubExecutionId, orderId, status: 'REFUND_PENDING', transactionHash: verified.transactionHash, gasUsed: verified.gasUsed.toString(), sponsored: finalStatus.sponsored, deadlineHit: false };
      }
      this.ledger.transitionOrder(orderId, 'SUCCEEDED', 'KeeperHub receipt, independent RPC receipt, exact transaction, and adapter postconditions verified');
      this.ledger.appendEvent('EXECUTION_VERIFIED', executionId, { transactionHash: verified.transactionHash, blockNumber: verified.blockNumber.toString(), postconditions: verified.postconditions, verificationSource: 'keeperhub+independent-rpc', deadlineHit: true });
      return { executionId, keeperhubExecutionId, orderId, status: 'SUCCEEDED', transactionHash: verified.transactionHash, gasUsed: verified.gasUsed.toString(), sponsored: finalStatus.sponsored, deadlineHit: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof VerificationUncertain) {
        this.ledger.transitionOrder(orderId, 'UNCERTAIN', message);
        return { executionId, keeperhubExecutionId, orderId, status: 'UNCERTAIN', sponsored: finalStatus.sponsored, error: message };
      }
      if (error instanceof VerificationFailure) {
        this.ledger.transitionOrder(orderId, 'FAILED', message);
        this.ledger.appendEvent('EXECUTION_FAILED', executionId, { error: message });
        this.ledger.transitionOrder(orderId, 'REFUND_PENDING', 'deterministically verified execution failure; refund execution disabled in this phase');
        return { executionId, keeperhubExecutionId, orderId, status: 'REFUND_PENDING', sponsored: finalStatus.sponsored, error: message };
      }
      throw error;
    }
  }

  private assertQuoteIntent(quote: Quote): void {
    const intent = quote.intent;
    if (!intent) throw new Error('Quote lacks canonical execution intent');
    if (intent.adapterName !== quote.jobType || intent.chainId !== quote.chainId || intent.deadlineAt !== quote.deadlineAt) throw new Error('Quote metadata differs from signed canonical intent');
    const adapter = registry.require(quote.jobType);
    if (intent.adapterVersion !== adapter.meta.version || !adapter.meta.supportedChains.includes(intent.chainId)) throw new Error('Signed intent adapter version or chain is not active');
    if (quote.simulation.to.toLowerCase() !== intent.target.toLowerCase() || quote.simulation.functionName !== intent.functionName || quote.simulation.functionArgs !== intent.functionArgs || quote.simulation.abi !== intent.abi || quote.simulation.value !== intent.keeperHubValue) throw new Error('Signed simulation summary differs from canonical intent');
  }

  private createRpc(chainId: number): PublicClient {
    const url = this.rpcUrls[chainId]; if (!url) throw new Error(`No RPC URL configured for chain ${chainId}`);
    return this.rpcClientFactory(chainId, url);
  }
}
