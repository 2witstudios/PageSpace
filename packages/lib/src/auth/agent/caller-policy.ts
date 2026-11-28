/**
 * Who may act FOR an agent, by credential class (ADR 0008 security review
 * addendum). Two pure rules, shared by every route that applies them:
 *
 *  - `decideClaimCaller` — a claim is started and polled by the agent ITSELF,
 *    proven by its own credential. No other credential (a claim token, a
 *    human's session or token, a token the agent granted another client) can
 *    start a claim or read its result. This is what keeps ownership — and the
 *    secret rotation that ownership allows (Decision 14) — the agent's choice.
 *
 *  - `decideAgentKeyMint` — the mcp_ key-mint caps (AGENT_KEY_MINT, the
 *    live-key cap) follow the CALLER (`accountType === 'agent'`), never the
 *    credential type, so an agent signed in by cookie is capped exactly like
 *    one presenting its bearer.
 *
 * The credential class is `classifyCallerCredential`'s answer (the web adapter
 * reads the token's issuance); `accountType` is the caller's
 * `users.accountType`. No I/O.
 *
 * @module @pagespace/lib/auth/agent/caller-policy
 */

import type { AccountType } from './account-type';

/**
 * `classifyCallerCredential`'s vocabulary:
 *  - `session` — a session (cookie, or the desktop/mobile session bearer);
 *  - `agent_grant_token` — an `account`-scoped access token minted for the
 *    `pagespace-agent` client whose principal is an agent (its own grant);
 *  - `other_token` — every other bearer.
 */
export type CallerCredentialClass = 'session' | 'agent_grant_token' | 'other_token';

/**
 * Which door is asking:
 *  - `bearer` — `POST /api/agent/claim` and the claim grant on the token
 *    endpoint: the agent's own `pagespace-agent` access token only;
 *  - `session` — `POST /api/agent/claim/session`: the agent's browser session
 *    only (CSRF-checked by the route).
 */
export type ClaimDoor = 'bearer' | 'session';

export type ClaimCallerDecision =
  | { status: 'ok' }
  /** Not the agent's own credential for this door — one refusal, whatever the reason. */
  | { status: 'refused' };

export function decideClaimCaller(input: {
  door: ClaimDoor;
  credential: CallerCredentialClass;
  /** The caller's `users.accountType`; null when the caller's row could not be read. */
  accountType: AccountType | null;
}): ClaimCallerDecision {
  if (input.accountType !== 'agent') return { status: 'refused' };
  const expected = input.door === 'bearer' ? 'agent_grant_token' : 'session';
  return input.credential === expected ? { status: 'ok' } : { status: 'refused' };
}

export type AgentKeyMintDecision =
  /** A bearer that may not mint keys at all — the route's long-standing 401. */
  | { status: 'refused' }
  /** May mint; `agentCaps` applies AGENT_KEY_MINT and the live-key cap. */
  | { status: 'ok'; agentCaps: boolean };

export function decideAgentKeyMint(input: {
  credential: CallerCredentialClass;
  accountType: AccountType | null;
}): AgentKeyMintDecision {
  if (input.credential === 'other_token') return { status: 'refused' };
  // An agent_grant_token's principal is an agent by construction; a session is
  // capped whenever its caller is one. An unreadable caller fails closed (capped).
  return { status: 'ok', agentCaps: input.credential === 'agent_grant_token' || input.accountType !== 'human' };
}
