import { describe, it, expect } from 'vitest';
import { canTransition, isTerminalStatus, DSR_STATUSES } from '../status-machine';

describe('isTerminalStatus', () => {
  it('given completed/failed/cancelled, should be terminal', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
  });

  it('given an in-flight status, should not be terminal', () => {
    expect(isTerminalStatus('pending')).toBe(false);
    expect(isTerminalStatus('queued')).toBe(false);
    expect(isTerminalStatus('in_progress')).toBe(false);
    expect(isTerminalStatus('blocked')).toBe(false);
  });
});

describe('canTransition', () => {
  it('given the normal happy path, should allow each forward step', () => {
    expect(canTransition('pending', 'queued')).toBe(true);
    expect(canTransition('queued', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'completed')).toBe(true);
  });

  it('given a failed attempt, should allow re-queue for retry', () => {
    expect(canTransition('failed', 'queued')).toBe(true);
    expect(canTransition('in_progress', 'failed')).toBe(true);
  });

  it('given a multi-member block, should allow in_progress -> blocked and recovery', () => {
    expect(canTransition('in_progress', 'blocked')).toBe(true);
    expect(canTransition('blocked', 'queued')).toBe(true);
  });

  it('given a terminal completed state, should reject any onward transition', () => {
    expect(canTransition('completed', 'in_progress')).toBe(false);
    expect(canTransition('completed', 'queued')).toBe(false);
    expect(canTransition('cancelled', 'queued')).toBe(false);
  });

  it('given a same-state transition, should reject it as a no-op', () => {
    expect(canTransition('in_progress', 'in_progress')).toBe(false);
  });

  it('should enumerate exactly the seven statuses', () => {
    expect([...DSR_STATUSES].sort()).toEqual(
      ['blocked', 'cancelled', 'completed', 'failed', 'in_progress', 'pending', 'queued'].sort()
    );
  });
});
