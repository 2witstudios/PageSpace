/**
 * Pure signup-door decision for agent accounts (ADR 0007 Decisions 10, 11).
 *
 * The route gathers the facts (is the door enabled for this deployment, what
 * did the challenge lookup return, did the PoW verify, were the terms
 * accepted) and this function orders them. Precedence is a security posture:
 *
 *  1. disabled — a closed door reveals nothing else (not even whether a
 *     challenge id exists).
 *  2. challenge_invalid — missing, expired, already consumed, or carrying a
 *     difficulty outside policy; the caller must fetch a fresh challenge.
 *  3. pow_invalid — the challenge is fine but the work is not; the client
 *     should re-solve, not re-fetch. Kept distinct on the wire on purpose.
 *  4. tos_required — the cheapest fix, reported last so a bot that never
 *     accepts terms still pays the PoW before learning that.
 *
 * No I/O, no clock: expiry is decided by the caller against the stored
 * `expiresAt` and passed in as `expired`.
 */

import { isPowDifficultyInRange } from './pow';

export interface AgentSignupChallengeLookup {
  found: boolean;
  expired: boolean;
  consumed: boolean;
  /** The difficulty stored on the challenge row (what the PoW was verified against). */
  difficultyBits: number;
}

export interface AgentSignupInput {
  enabled: boolean;
  challenge: AgentSignupChallengeLookup;
  powValid: boolean;
  tosAccepted: boolean;
}

export type AgentSignupDecision =
  | { status: 'ok'; difficultyBits: number }
  | { status: 'disabled' }
  | { status: 'challenge_invalid' }
  | { status: 'pow_invalid' }
  | { status: 'tos_required' };

export function decideAgentSignup(input: AgentSignupInput): AgentSignupDecision {
  if (!input.enabled) {
    return { status: 'disabled' };
  }

  const { challenge } = input;
  if (
    !challenge.found ||
    challenge.expired ||
    challenge.consumed ||
    !isPowDifficultyInRange(challenge.difficultyBits)
  ) {
    return { status: 'challenge_invalid' };
  }

  if (!input.powValid) {
    return { status: 'pow_invalid' };
  }

  if (!input.tosAccepted) {
    return { status: 'tos_required' };
  }

  return { status: 'ok', difficultyBits: challenge.difficultyBits };
}
