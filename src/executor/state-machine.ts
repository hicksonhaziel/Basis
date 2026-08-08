/**
 * Order State Machine.
 *
 * States:
 *   QUOTED → PAID → EXECUTING → SETTLED | FAILED | LATE → REFUND_PENDING → REFUNDED
 *
 * Transitions are explicit — invalid transitions throw.
 */

export type OrderState =
  | 'QUOTED'
  | 'PAID'
  | 'EXECUTING'
  | 'SETTLED'
  | 'FAILED'
  | 'LATE'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'EXPIRED'
  | 'REJECTED_AFTER_PAYMENT';

const VALID_TRANSITIONS: Record<OrderState, OrderState[]> = {
  QUOTED: ['PAID', 'EXPIRED'],
  PAID: ['EXECUTING', 'REJECTED_AFTER_PAYMENT'],
  EXECUTING: ['SETTLED', 'FAILED', 'LATE'],
  SETTLED: [],
  FAILED: ['REFUND_PENDING'],
  LATE: ['REFUND_PENDING'],
  REJECTED_AFTER_PAYMENT: ['REFUND_PENDING'],
  REFUND_PENDING: ['REFUNDED'],
  REFUNDED: [],
  EXPIRED: [],
};

/**
 * Check if a state transition is valid.
 */
export function canTransition(from: OrderState, to: OrderState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Transition an order state. Throws if the transition is invalid.
 */
export function transition(from: OrderState, to: OrderState): OrderState {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid state transition: ${from} → ${to}`);
  }
  return to;
}

/**
 * Check if an order is in a terminal state (no further transitions possible).
 */
export function isTerminal(state: OrderState): boolean {
  return VALID_TRANSITIONS[state]?.length === 0;
}

/**
 * Check if an order is refundable (can move to REFUND_PENDING).
 */
export function isRefundable(state: OrderState): boolean {
  return canTransition(state, 'REFUND_PENDING');
}

/**
 * Determine if execution missed its deadline.
 */
export function checkDeadline(deadlineAt: string, completedAt: string | null): boolean {
  if (!completedAt) return false;
  return new Date(completedAt) > new Date(deadlineAt);
}
