/**
 * KeeperHub API error types.
 * Note: No parameter properties — Node 22 strip-types doesn't support them.
 */

export class KeeperHubError extends Error {
  readonly statusCode: number;
  readonly body: unknown;

  constructor(message: string, statusCode: number, body: unknown) {
    super(message);
    this.name = 'KeeperHubError';
    this.statusCode = statusCode;
    this.body = body;
  }
}

export class SimulationRevertError extends KeeperHubError {
  readonly revertReason: string;
  readonly from: string;
  readonly to: string;

  constructor(revertReason: string, from: string, to: string, body: unknown) {
    super(`Simulation reverted: ${revertReason}`, 400, body);
    this.name = 'SimulationRevertError';
    this.revertReason = revertReason;
    this.from = from;
    this.to = to;
  }
}

export class InsufficientBalanceError extends SimulationRevertError {
  readonly balanceWei: string;
  readonly requiredWei: string;
  readonly shortfallWei: string;

  constructor(
    balanceWei: string,
    requiredWei: string,
    shortfallWei: string,
    from: string,
    to: string,
    body: unknown,
  ) {
    super(`Insufficient balance: have ${balanceWei}, need ${requiredWei}`, from, to, body);
    this.name = 'InsufficientBalanceError';
    this.balanceWei = balanceWei;
    this.requiredWei = requiredWei;
    this.shortfallWei = shortfallWei;
  }
}

export class IdempotencyConflictError extends KeeperHubError {
  readonly originalExecutionId: string | null;

  constructor(originalExecutionId: string | null, body: unknown) {
    super('Idempotency conflict: key used with different body', 409, body);
    this.name = 'IdempotencyConflictError';
    this.originalExecutionId = originalExecutionId;
  }
}

export class IdempotencyInProgressError extends KeeperHubError {
  readonly originalExecutionId: string | null;

  constructor(originalExecutionId: string | null, body: unknown) {
    super('Idempotency in progress: original request still running', 409, body);
    this.name = 'IdempotencyInProgressError';
    this.originalExecutionId = originalExecutionId;
  }
}

export class RateLimitError extends KeeperHubError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, body: unknown) {
    super(`Rate limited. Retry after ${retryAfterSeconds}s`, 429, body);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class WalletNotConfiguredError extends KeeperHubError {
  constructor(body: unknown) {
    super('Wallet not configured for this organization', 422, body);
    this.name = 'WalletNotConfiguredError';
  }
}
