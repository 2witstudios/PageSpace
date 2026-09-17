/**
 * ADR 0007 — the browser-door sign-in decision. Typed internally so the route
 * can audit the real reason; collapsed to ONE constant shape on the wire so
 * an unknown secret, a revoked agent, a suspended agent and a locked agent
 * are indistinguishable to the caller.
 */
import { describe, it, expect } from 'vitest';
import {
  decideAgentSignin,
  collapseAgentSigninDecision,
  AGENT_SIGNIN_WIRE_ERROR,
  type AgentSigninLookup,
} from '../signin-decision';

const NOW = new Date('2026-09-14T12:00:00.000Z');

function found(overrides: Partial<Extract<AgentSigninLookup, { found: true }>> = {}): AgentSigninLookup {
  return { found: true, revokedAt: null, suspendedAt: null, lockedUntil: null, ...overrides };
}

describe('decideAgentSignin', () => {
  it('returns ok for a found account with no revocation, suspension or active lock', () => {
    expect(decideAgentSignin({ account: found(), now: NOW })).toEqual({ status: 'ok' });
  });

  it('returns not_found when the hash lookup missed', () => {
    expect(decideAgentSignin({ account: { found: false }, now: NOW })).toEqual({ status: 'not_found' });
  });

  it('returns revoked when revokedAt is set', () => {
    expect(decideAgentSignin({ account: found({ revokedAt: new Date(NOW.getTime() - 1) }), now: NOW })).toEqual({
      status: 'revoked',
    });
  });

  it('returns suspended when suspendedAt is set', () => {
    expect(decideAgentSignin({ account: found({ suspendedAt: new Date(NOW.getTime() - 1) }), now: NOW })).toEqual({
      status: 'suspended',
    });
  });

  it('returns locked while lockedUntil is strictly in the future', () => {
    expect(decideAgentSignin({ account: found({ lockedUntil: new Date(NOW.getTime() + 1) }), now: NOW })).toEqual({
      status: 'locked',
    });
  });

  it('a lock that expires exactly at now is not a lock (ok)', () => {
    expect(decideAgentSignin({ account: found({ lockedUntil: new Date(NOW.getTime()) }), now: NOW })).toEqual({
      status: 'ok',
    });
  });

  it('a lock in the past is not a lock (ok)', () => {
    expect(decideAgentSignin({ account: found({ lockedUntil: new Date(NOW.getTime() - 1) }), now: NOW })).toEqual({
      status: 'ok',
    });
  });

  it('precedence: revoked beats suspended beats locked', () => {
    const all = found({ revokedAt: NOW, suspendedAt: NOW, lockedUntil: new Date(NOW.getTime() + 60_000) });
    expect(decideAgentSignin({ account: all, now: NOW })).toEqual({ status: 'revoked' });
    const two = found({ suspendedAt: NOW, lockedUntil: new Date(NOW.getTime() + 60_000) });
    expect(decideAgentSignin({ account: two, now: NOW })).toEqual({ status: 'suspended' });
  });
});

describe('collapseAgentSigninDecision — one reason on the wire', () => {
  it('maps ok to ok', () => {
    expect(collapseAgentSigninDecision({ status: 'ok' })).toEqual({ ok: true });
  });

  it('maps EVERY failure to the same constant shape', () => {
    const failures = ['not_found', 'revoked', 'suspended', 'locked'] as const;
    const shapes = failures.map((status) => collapseAgentSigninDecision({ status }));
    for (const shape of shapes) {
      expect(shape).toEqual({ ok: false, error: AGENT_SIGNIN_WIRE_ERROR });
    }
    expect(new Set(shapes.map((s) => JSON.stringify(s))).size).toBe(1);
  });

  it('the wire error is the generic invalid_credentials', () => {
    expect(AGENT_SIGNIN_WIRE_ERROR).toBe('invalid_credentials');
  });
});
