import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, transition } from '../../src/executor/state-machine.ts';

describe('canonical execution state machine', () => {
  it('accepts the deterministic success lifecycle', () => {
    const path = ['AUTHENTICATED_INGRESS', 'RESIMULATING', 'EXECUTING', 'VERIFYING', 'SUCCEEDED'] as const;
    let state: any = 'QUOTED';
    for (const next of path) { assert.equal(canTransition(state, next), true); state = transition(state, next); }
    assert.equal(state, 'SUCCEEDED');
  });

  it('accepts explicit uncertainty and refund branches', () => {
    assert.equal(canTransition('EXECUTING', 'UNCERTAIN'), true);
    assert.equal(canTransition('UNCERTAIN', 'VERIFYING'), true);
    assert.equal(canTransition('VERIFYING', 'FAILED'), true);
    assert.equal(canTransition('FAILED', 'REFUND_PENDING'), true);
    assert.equal(canTransition('REFUND_PENDING', 'REFUND_SUBMITTING'), true);
    assert.equal(canTransition('REFUND_SUBMITTING', 'REFUND_VERIFYING'), true);
    assert.equal(canTransition('REFUND_VERIFYING', 'REFUND_UNCERTAIN'), true);
    assert.equal(canTransition('REFUND_UNCERTAIN', 'REFUND_VERIFYING'), true);
  });

  it('rejects invalid shortcuts and transitions from terminal states', () => {
    assert.throws(() => transition('AUTHENTICATED_INGRESS', 'SUCCEEDED'), /Invalid state transition/);
    assert.throws(() => transition('UNCERTAIN', 'EXECUTING'), /Invalid state transition/);
    assert.throws(() => transition('SUCCEEDED', 'EXECUTING'), /Invalid state transition/);
  });
});
