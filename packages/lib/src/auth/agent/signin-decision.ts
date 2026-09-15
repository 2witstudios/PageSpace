/**
 * Pure sign-in decision for the agent browser door (ADR 0005, threat model T3).
 *
 * The route hashes the presented secret, looks the account up by hash, and
 * hands the lookup here. The decision is TYPED internally so the route can
 * audit the real reason and apply lockout increments; it is COLLAPSED to one
 * constant shape on the wire (`collapseAgentSigninDecision`) so an unknown
 * secret, a revoked agent, a suspended agent and a locked agent are
 * indistinguishable to the caller. Same vocabulary as passkey login's
 * account-lockout: `lockedUntil` strictly in the future is a lock; exactly
 * at `now` is not.
 */

export type AgentSigninLookup =
  | { found: false }
  | {
      found: true;
      revokedAt: Date | null;
      suspendedAt: Date | null;
      lockedUntil: Date | null;
    };

export interface AgentSigninInput {
  account: AgentSigninLookup;
  now: Date;
}

export type AgentSigninDecision =
  | { status: 'ok' }
  | { status: 'not_found' }
  | { status: 'revoked' }
  | { status: 'suspended' }
  | { status: 'locked' };

/** Precedence: not_found → revoked → suspended → locked → ok. */
export function decideAgentSignin(input: AgentSigninInput): AgentSigninDecision {
  const { account, now } = input;
  if (!account.found) {
    return { status: 'not_found' };
  }
  if (account.revokedAt !== null) {
    return { status: 'revoked' };
  }
  if (account.suspendedAt !== null) {
    return { status: 'suspended' };
  }
  if (account.lockedUntil !== null && account.lockedUntil.getTime() > now.getTime()) {
    return { status: 'locked' };
  }
  return { status: 'ok' };
}

/** The single error string every sign-in failure becomes on the wire. */
export const AGENT_SIGNIN_WIRE_ERROR = 'invalid_credentials' as const;

export type AgentSigninWireShape = { ok: true } | { ok: false; error: typeof AGENT_SIGNIN_WIRE_ERROR };

/** Every non-ok decision collapses to the same object — no oracle between reasons. */
export function collapseAgentSigninDecision(decision: AgentSigninDecision): AgentSigninWireShape {
  if (decision.status === 'ok') {
    return { ok: true };
  }
  return { ok: false, error: AGENT_SIGNIN_WIRE_ERROR };
}
