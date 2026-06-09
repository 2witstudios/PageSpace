import { describe, it, expect, beforeEach } from 'vitest';
import {
  AUTH_EXCHANGE_STATE_TTL_MS,
  generateAuthExchangeState,
  verifyAuthExchangeState,
  evaluateAuthExchangeBinding,
  beginAuthExchangeFlow,
  peekAuthExchangeState,
  clearAuthExchangeState,
} from '../auth-exchange-state';

describe('verifyAuthExchangeState (pure)', () => {
  it('returns true only for equal non-empty strings', () => {
    expect(verifyAuthExchangeState('abc123', 'abc123')).toBe(true);
  });

  it('returns false for mismatched values', () => {
    expect(verifyAuthExchangeState('abc123', 'abc124')).toBe(false);
    expect(verifyAuthExchangeState('abc', 'abcd')).toBe(false);
  });

  it('returns false when either side is empty/null/undefined', () => {
    expect(verifyAuthExchangeState('', '')).toBe(false);
    expect(verifyAuthExchangeState('abc', '')).toBe(false);
    expect(verifyAuthExchangeState('', 'abc')).toBe(false);
    expect(verifyAuthExchangeState(null, 'abc')).toBe(false);
    expect(verifyAuthExchangeState('abc', null)).toBe(false);
    expect(verifyAuthExchangeState(undefined, undefined)).toBe(false);
  });

  it('is not fooled by type coercion', () => {
    // @ts-expect-error intentionally passing a non-string
    expect(verifyAuthExchangeState(123, 123)).toBe(false);
  });
});

describe('evaluateAuthExchangeBinding (pure)', () => {
  it('rejects when no flow is in progress (unsolicited exchange)', () => {
    expect(evaluateAuthExchangeBinding('anything', null)).toEqual({
      accepted: false,
      reason: 'no-flow-in-progress',
    });
    expect(evaluateAuthExchangeBinding(null, null)).toEqual({
      accepted: false,
      reason: 'no-flow-in-progress',
    });
    expect(evaluateAuthExchangeBinding('anything', '')).toEqual({
      accepted: false,
      reason: 'no-flow-in-progress',
    });
  });

  it('accepts a flow-in-progress exchange that carries no state', () => {
    expect(evaluateAuthExchangeBinding(null, 'expected-state')).toEqual({
      accepted: true,
      reason: 'flow-in-progress-no-state',
    });
    expect(evaluateAuthExchangeBinding('', 'expected-state')).toEqual({
      accepted: true,
      reason: 'flow-in-progress-no-state',
    });
    expect(evaluateAuthExchangeBinding(undefined, 'expected-state')).toEqual({
      accepted: true,
      reason: 'flow-in-progress-no-state',
    });
  });

  it('accepts a matching state and rejects a mismatched state', () => {
    expect(evaluateAuthExchangeBinding('s1', 's1')).toEqual({
      accepted: true,
      reason: 'state-match',
    });
    expect(evaluateAuthExchangeBinding('attacker', 's1')).toEqual({
      accepted: false,
      reason: 'state-mismatch',
    });
  });
});

describe('auth-exchange flow store', () => {
  beforeEach(() => clearAuthExchangeState());

  it('generates high-entropy distinct states', () => {
    const a = generateAuthExchangeState();
    const b = generateAuthExchangeState();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toEqual(b);
  });

  it('peek returns null before any flow begins', () => {
    expect(peekAuthExchangeState()).toBeNull();
  });

  it('begin stores a state that peek returns within the TTL', () => {
    const now = 1_000_000;
    const state = beginAuthExchangeFlow(now);
    expect(peekAuthExchangeState(now)).toBe(state);
    expect(peekAuthExchangeState(now + AUTH_EXCHANGE_STATE_TTL_MS - 1)).toBe(state);
  });

  it('expires the stored state after the TTL', () => {
    const now = 1_000_000;
    beginAuthExchangeFlow(now);
    expect(peekAuthExchangeState(now + AUTH_EXCHANGE_STATE_TTL_MS)).toBeNull();
    // and stays cleared
    expect(peekAuthExchangeState(now)).toBeNull();
  });

  it('clear removes an in-progress flow (single-use consumption)', () => {
    const now = 1_000_000;
    beginAuthExchangeFlow(now);
    clearAuthExchangeState();
    expect(peekAuthExchangeState(now)).toBeNull();
  });

  it('begin overwrites any prior flow (last login wins)', () => {
    const now = 1_000_000;
    const first = beginAuthExchangeFlow(now);
    const second = beginAuthExchangeFlow(now);
    expect(second).not.toBe(first);
    expect(peekAuthExchangeState(now)).toBe(second);
  });
});
