/**
 * The deployment-wide agent signup budget (Agent Signup Phase 2b).
 *
 * `AGENT_SIGNUP` / `AGENT_SIGNUP_DAILY` cap signups per client IP, and a client
 * IP is only as trustworthy as the proxy that reported it (see
 * `security/client-ip.ts`). This is the ceiling no header can widen: at most
 * `budget` agent accounts are created per rolling `windowMs` across the whole
 * deployment, by every door. It counts accounts actually created (not
 * attempts), so junk requests cannot drain it — only paid-for, valid signups
 * can, and each of those already cost a solved proof-of-work.
 *
 * `createAgentAccount` evaluates it inside the account transaction under an
 * advisory lock, so no door can skip it and concurrent signups cannot overshoot.
 *
 * @module @pagespace/lib/auth/agent/signup-budget
 */

import { envInt } from '../../billing/credit-pricing';

/** Rolling window the budget is counted over. */
export const AGENT_SIGNUP_BUDGET_WINDOW_MS = 60 * 60 * 1000;

/**
 * How far past `now` a signup stamp may be and still count: covers a racer
 * that took its clock reading before waiting on the budget lock, and small
 * skew between machines. Anything further in the future is ignored.
 */
export const AGENT_SIGNUP_BUDGET_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Agent accounts the whole deployment may create per rolling hour. Twenty times
 * one IP's hourly allowance; `0` closes the door by budget. A value that is not
 * an unsigned integer falls back to the default (`envInt`).
 */
export const AGENT_SIGNUP_GLOBAL_BUDGET = envInt('AGENT_SIGNUP_GLOBAL_BUDGET', 100);

export interface AgentSignupBudgetInput {
  /** Agent accounts created in `(now - windowMs, now]`. */
  signupsInWindow: number;
  /** Creation time of the oldest of those, or null when there are none. */
  oldestInWindow: Date | null;
  budget: number;
  windowMs: number;
  now: Date;
}

export type AgentSignupBudgetDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function decideAgentSignupBudget(input: AgentSignupBudgetInput): AgentSignupBudgetDecision {
  const { signupsInWindow, oldestInWindow, budget, windowMs, now } = input;
  const windowSeconds = Math.max(1, Math.ceil((isCount(windowMs) ? windowMs : AGENT_SIGNUP_BUDGET_WINDOW_MS) / 1000));

  // A misconfigured budget or window fails closed rather than meaning "unlimited".
  if (!isCount(budget) || !isCount(windowMs) || windowMs === 0) {
    return { allowed: false, retryAfterSeconds: windowSeconds };
  }
  if (signupsInWindow < budget) return { allowed: true };

  if (oldestInWindow === null) return { allowed: false, retryAfterSeconds: windowSeconds };
  const msUntilFree = oldestInWindow.getTime() + windowMs - now.getTime();
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(msUntilFree / 1000)) };
}
