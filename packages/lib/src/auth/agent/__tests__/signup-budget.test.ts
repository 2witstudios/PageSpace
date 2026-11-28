/**
 * Agent Signup Phase 2b leaf 2 — the deployment-wide signup budget. The
 * per-IP limits are only as good as the client IP, and an IP header can be
 * forged wherever the proxy in front does not overwrite it; this budget counts
 * accounts actually created, deployment-wide, so no header can widen it.
 */
import { describe, it, expect } from 'vitest';
import { decideAgentSignupBudget, type AgentSignupBudgetInput } from '../signup-budget';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function input(overrides: Partial<AgentSignupBudgetInput> = {}): AgentSignupBudgetInput {
  return { signupsInWindow: 0, oldestInWindow: null, budget: 100, windowMs: HOUR, now: NOW, ...overrides };
}

describe('decideAgentSignupBudget', () => {
  it('given no signups in the window, should allow', () => {
    expect(decideAgentSignupBudget(input())).toEqual({ allowed: true });
  });

  it('given one fewer signup than the budget, should allow the last one', () => {
    expect(decideAgentSignupBudget(input({ signupsInWindow: 99, oldestInWindow: new Date(NOW.getTime() - 1000) }))).toEqual({ allowed: true });
  });

  it('given the budget already spent in the window, should refuse until the oldest signup ages out', () => {
    const oldest = new Date(NOW.getTime() - 45 * 60 * 1000);

    expect(decideAgentSignupBudget(input({ signupsInWindow: 100, oldestInWindow: oldest }))).toEqual({ allowed: false, retryAfterSeconds: 15 * 60 });
  });

  it('given more signups than the budget (a race or a lowered budget), should refuse', () => {
    expect(decideAgentSignupBudget(input({ signupsInWindow: 250, oldestInWindow: new Date(NOW.getTime() - HOUR + 500) }))).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('given a spent budget with no oldest timestamp, should refuse for a whole window', () => {
    expect(decideAgentSignupBudget(input({ signupsInWindow: 100 }))).toEqual({ allowed: false, retryAfterSeconds: 3600 });
  });

  it('given a budget of zero, should refuse every signup (an operator closing the door by budget)', () => {
    expect(decideAgentSignupBudget(input({ budget: 0 }))).toEqual({ allowed: false, retryAfterSeconds: 3600 });
  });

  it('given a misconfigured budget or window (negative, fractional, NaN), should fail closed', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(decideAgentSignupBudget(input({ budget: bad })).allowed).toBe(false);
      expect(decideAgentSignupBudget(input({ windowMs: bad })).allowed).toBe(false);
    }
    expect(decideAgentSignupBudget(input({ windowMs: 0 })).allowed).toBe(false);
  });
});
