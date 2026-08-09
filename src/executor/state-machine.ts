/** Canonical deterministic order/execution lifecycle. */

export type OrderState =
  | 'QUOTED'
  | 'AUTHENTICATED_INGRESS'
  | 'PAID'
  | 'RESIMULATING'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'LATE'
  | 'UNCERTAIN'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'REFUND_UNCERTAIN'
  | 'EXPIRED';

const VALID_TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  QUOTED: ['AUTHENTICATED_INGRESS', 'PAID', 'EXPIRED'],
  AUTHENTICATED_INGRESS: ['RESIMULATING'],
  PAID: ['RESIMULATING'],
  RESIMULATING: ['EXECUTING', 'REFUND_PENDING', 'FAILED'],
  EXECUTING: ['VERIFYING', 'FAILED', 'UNCERTAIN'],
  VERIFYING: ['SUCCEEDED', 'FAILED', 'LATE', 'UNCERTAIN'],
  SUCCEEDED: [],
  FAILED: ['REFUND_PENDING'],
  LATE: ['REFUND_PENDING'],
  UNCERTAIN: ['VERIFYING', 'FAILED'],
  REFUND_PENDING: ['REFUNDED', 'REFUND_UNCERTAIN'],
  REFUNDED: [],
  REFUND_UNCERTAIN: [],
  EXPIRED: [],
};

export function canTransition(from: OrderState, to: OrderState): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function transition(from: OrderState, to: OrderState): OrderState {
  if (!canTransition(from, to)) throw new Error(`Invalid state transition: ${from} → ${to}`);
  return to;
}

export function isTerminal(state: OrderState): boolean {
  return VALID_TRANSITIONS[state].length === 0;
}

export function isRefundable(state: OrderState): boolean {
  return canTransition(state, 'REFUND_PENDING');
}

export function checkDeadline(deadlineAt: string, completedAt: string | null): boolean {
  return completedAt !== null && new Date(completedAt).getTime() > new Date(deadlineAt).getTime();
}

export function assertOrderState(value: string): asserts value is OrderState {
  if (!(value in VALID_TRANSITIONS)) throw new Error(`Unknown order state: ${value}`);
}
