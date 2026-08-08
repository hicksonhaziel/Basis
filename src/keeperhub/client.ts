/**
 * KeeperHub Direct Execution API Client.
 *
 * Wraps the KeeperHub REST API with typed methods for:
 * - Simulation (dry-run)
 * - Contract call execution
 * - Transfer execution
 * - Execution status polling
 * - Org wallet discovery
 *
 * Base URL: https://app.keeperhub.com
 * Auth: Bearer kh_... (org API key)
 */

import {
  KeeperHubError,
  SimulationRevertError,
  InsufficientBalanceError,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  RateLimitError,
  WalletNotConfiguredError,
} from './errors.ts';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SimulateContractCallRequest {
  contractAddress: string;
  chainId: number;
  functionName: string;
  functionArgs?: string;
  abi?: string;
  value?: string;
  gasLimitMultiplier?: string;
}

export interface SimulationSuccess {
  success: true;
  status: 'simulated';
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  gasEstimate: string;
  simulatedReturnValue: unknown;
  wouldRevert: false;
}

export interface SimulationRevert {
  success: false;
  status: 'simulated';
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  wouldRevert: true;
  revertReason: string;
  error: string;
  code?: 'insufficient_balance';
  balanceWei?: string;
  requiredWei?: string;
  shortfallWei?: string;
  nativeSymbol?: string;
}

export type SimulationResult = SimulationSuccess | SimulationRevert;

export interface ExecuteContractCallRequest {
  contractAddress: string;
  chainId: number;
  functionName: string;
  functionArgs?: string;
  abi?: string;
  value?: string;
  gasLimitMultiplier?: string;
}

export interface ExecuteTransferRequest {
  chainId: number;
  recipientAddress: string;
  amount: string;
  tokenAddress?: string;
  tokenConfig?: string;
  gasLimitMultiplier?: string;
}

export interface ExecutionResponse {
  executionId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  transactionHash?: string;
  transactionLink?: string;
  idempotentReplay?: boolean;
}

export interface Receipt {
  hash: string;
  chainId: number;
  verified: boolean;
  receiptStatus: 'success' | 'reverted' | 'safe_inner_failure' | 'not_found' | 'timeout';
  blockNumber: number;
  gasUsed: string;
  verifiedAt: string;
}

export interface ExecutionStatus {
  executionId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  type: string;
  transactionHash?: string;
  transactionLink?: string;
  sponsored: boolean;
  receipts: Receipt[];
  gasUsedWei?: string;
  result?: unknown;
  error?: string | null;
  createdAt: string;
  completedAt?: string;
  idempotentReplay?: boolean;
}

export interface PollOptions {
  /** Maximum time to wait in ms (default 120_000) */
  timeoutMs?: number;
  /** Called after each poll with current status */
  onPoll?: (status: ExecutionStatus) => void;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class KeeperHubClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: { baseUrl: string; apiKey: string }) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
  }

  // ─── Simulation ──────────────────────────────────────────────────────────

  /**
   * Simulate a contract call without broadcasting.
   * Returns the simulation result including gas estimate and from address.
   * Throws SimulationRevertError if the call would revert.
   */
  async simulate(req: SimulateContractCallRequest): Promise<SimulationSuccess> {
    const body = { ...req, simulate: true };
    const res = await this.post('/api/execute/contract-call', body);

    if (res.status === 200) {
      const data = (await res.json()) as SimulationSuccess;
      return data;
    }

    if (res.status === 400) {
      const data = (await res.json()) as SimulationRevert;
      if (data.wouldRevert) {
        if (data.code === 'insufficient_balance') {
          throw new InsufficientBalanceError(
            data.balanceWei ?? '0',
            data.requiredWei ?? '0',
            data.shortfallWei ?? '0',
            data.from,
            data.to,
            data,
          );
        }
        throw new SimulationRevertError(data.revertReason, data.from, data.to, data);
      }
    }

    await this.handleCommonErrors(res);
    throw new KeeperHubError(`Unexpected response: ${res.status}`, res.status, await res.text());
  }

  /**
   * Discover the org wallet address by running a simulation.
   * Uses WETH deposit (a write function) because view-only calls don't return
   * the simulation envelope with the `from` field.
   * The simulation will fail (insufficient balance is fine) — we just need the `from`.
   */
  async getOrgWalletAddress(chainId: number): Promise<`0x${string}`> {
    const WETH: Record<number, string> = {
      8453: '0x4200000000000000000000000000000000000006',
      1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      11155111: '0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9',
      84532: '0x4200000000000000000000000000000000000006',
    };

    const weth = WETH[chainId];
    if (!weth) throw new Error(`No WETH address known for chain ${chainId}`);

    try {
      const result = await this.simulate({
        contractAddress: weth,
        chainId,
        functionName: 'deposit',
        abi: JSON.stringify([{
          name: 'deposit',
          type: 'function',
          stateMutability: 'payable',
          inputs: [],
          outputs: [],
        }]),
        value: '0.0000001',
      });
      return result.from;
    } catch (err: unknown) {
      // InsufficientBalanceError or SimulationRevertError still carries `from`
      if (err instanceof SimulationRevertError) {
        return err.from as `0x${string}`;
      }
      throw err;
    }
  }

  // ─── Execution ───────────────────────────────────────────────────────────

  /**
   * Execute a contract call with idempotency key.
   */
  async executeContractCall(
    req: ExecuteContractCallRequest,
    idempotencyKey: string,
  ): Promise<ExecutionResponse> {
    const res = await this.post('/api/execute/contract-call', req, {
      'Idempotency-Key': idempotencyKey,
    });

    if (res.status === 200 || res.status === 202) {
      return (await res.json()) as ExecutionResponse;
    }

    if (res.status === 409) {
      const data = (await res.json()) as { code?: string; originalExecutionId?: string };
      if (data.code === 'idempotency_in_progress') {
        throw new IdempotencyInProgressError(data);
      }
      if (data.code === 'idempotency_conflict') {
        throw new IdempotencyConflictError(data.originalExecutionId ?? null, data);
      }
    }

    await this.handleCommonErrors(res);
    throw new KeeperHubError(`Unexpected response: ${res.status}`, res.status, await res.text());
  }

  /**
   * Execute a native/ERC-20 transfer with idempotency key.
   */
  async executeTransfer(
    req: ExecuteTransferRequest,
    idempotencyKey: string,
  ): Promise<ExecutionResponse> {
    const res = await this.post('/api/execute/transfer', req, {
      'Idempotency-Key': idempotencyKey,
    });

    if (res.status === 200 || res.status === 202) {
      return (await res.json()) as ExecutionResponse;
    }

    if (res.status === 409) {
      const data = (await res.json()) as { code?: string; originalExecutionId?: string };
      if (data.code === 'idempotency_in_progress') {
        throw new IdempotencyInProgressError(data);
      }
      if (data.code === 'idempotency_conflict') {
        throw new IdempotencyConflictError(data.originalExecutionId ?? null, data);
      }
    }

    await this.handleCommonErrors(res);
    throw new KeeperHubError(`Unexpected response: ${res.status}`, res.status, await res.text());
  }

  // ─── Status & Polling ────────────────────────────────────────────────────

  /**
   * Get execution status by ID.
   * Returns the poll interval hint from the response header.
   */
  async getExecutionStatus(executionId: string): Promise<{
    status: ExecutionStatus;
    pollIntervalHint: number;
  }> {
    const res = await this.get(`/api/execute/${executionId}/status`);

    if (res.status === 200) {
      const status = (await res.json()) as ExecutionStatus;
      const hint = parseInt(res.headers.get('X-Poll-Interval-Hint') ?? '2', 10);
      return { status, pollIntervalHint: hint };
    }

    await this.handleCommonErrors(res);
    throw new KeeperHubError(`Unexpected response: ${res.status}`, res.status, await res.text());
  }

  /**
   * Poll execution status until terminal state (completed/failed) or timeout.
   * Honors X-Poll-Interval-Hint between polls.
   */
  async pollUntilComplete(executionId: string, options: PollOptions = {}): Promise<ExecutionStatus> {
    const { timeoutMs = 120_000, onPoll } = options;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const { status, pollIntervalHint } = await this.getExecutionStatus(executionId);
      onPoll?.(status);

      if (status.status === 'completed' || status.status === 'failed') {
        return status;
      }

      // pollIntervalHint === 0 means terminal, but we double check above
      const waitMs = Math.min(pollIntervalHint * 1000, deadline - Date.now());
      if (waitMs <= 0) break;
      await this.sleep(waitMs);
    }

    // Final check before timeout
    const { status } = await this.getExecutionStatus(executionId);
    if (status.status === 'completed' || status.status === 'failed') {
      return status;
    }

    throw new KeeperHubError(
      `Execution ${executionId} did not reach terminal state within ${timeoutMs}ms`,
      0,
      { executionId, lastStatus: status.status },
    );
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private async post(
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
  }

  private async get(path: string): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
    });
  }

  private async handleCommonErrors(res: Response): Promise<never> {
    const body = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }

    if (res.status === 401) {
      throw new KeeperHubError('Invalid or missing API key', 401, parsed);
    }
    if (res.status === 422) {
      const obj = parsed as { code?: string };
      if (obj?.code === 'WALLET_NOT_CONFIGURED') {
        throw new WalletNotConfiguredError(parsed);
      }
    }
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '60', 10);
      throw new RateLimitError(retryAfter, parsed);
    }

    throw new KeeperHubError(
      `KeeperHub API error: ${res.status}`,
      res.status,
      parsed,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
