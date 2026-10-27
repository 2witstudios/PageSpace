/**
 * Auth-exchange CSRF / session-fixation binding (security finding L9).
 *
 * The `pagespace://auth-exchange?code=...` deep link previously adopted any
 * code with no proof that THIS app instance started the login. Any local app or
 * web page could drive the desktop into an attacker-supplied session.
 *
 * This module binds the exchange to an app-instance auth flow:
 *  - `beginAuthExchangeFlow()` is called at the start of a desktop-initiated
 *    login (the renderer / open-external handoff). It records a single-use,
 *    TTL-bounded random `state`.
 *  - `verifyAuthExchangeState` / `evaluateAuthExchangeBinding` are PURE decision
 *    helpers (exhaustively unit-tested) that decide whether an incoming deep
 *    link may proceed.
 *  - The deep-link handler consumes the stored state and rejects exchanges that
 *    arrive with no flow in progress (the unsolicited-CSRF case) or with a
 *    non-matching state.
 */

import { randomBytes } from 'node:crypto';

/** How long a begun auth flow stays valid (ms). Exceeds the 5-minute server
 * exchange-code TTL so a legitimately slow login is not rejected. */
export const AUTH_EXCHANGE_STATE_TTL_MS = 10 * 60 * 1000;

interface PendingAuthExchange {
  state: string;
  expiresAt: number;
}

let pending: PendingAuthExchange | null = null;

/** Generate a high-entropy, opaque state value. */
export function generateAuthExchangeState(): string {
  return randomBytes(32).toString('hex');
}

/**
 * PURE. Constant-length-ish equality of two state values. Both must be present,
 * equal-length, non-empty strings. Returns false for any null/empty/mismatch.
 */
export function verifyAuthExchangeState(
  received: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  if (received.length === 0 || expected.length === 0) return false;
  if (received.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < received.length; i++) {
    diff |= received.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export interface AuthExchangeDecision {
  accepted: boolean;
  reason:
    | 'no-flow-in-progress'
    | 'flow-in-progress-no-state'
    | 'state-match'
    | 'state-mismatch';
}

/**
 * PURE. Decide whether an auth-exchange deep link may proceed.
 *
 * - No flow in progress (expected is null): REJECT — closes the unsolicited
 *   drive-by CSRF / session-fixation case.
 * - Flow in progress, deep link carries no state: ACCEPT — preserves current
 *   server-issued flows that do not yet echo the desktop state, while still
 *   requiring a desktop-initiated flow.
 * - Flow in progress, deep link carries a state: ACCEPT iff it matches —
 *   strong binding once producers echo the state.
 */
export function evaluateAuthExchangeBinding(
  received: string | null | undefined,
  expected: string | null | undefined,
): AuthExchangeDecision {
  if (typeof expected !== 'string' || expected.length === 0) {
    return { accepted: false, reason: 'no-flow-in-progress' };
  }
  if (received === null || received === undefined || received === '') {
    return { accepted: true, reason: 'flow-in-progress-no-state' };
  }
  return verifyAuthExchangeState(received, expected)
    ? { accepted: true, reason: 'state-match' }
    : { accepted: false, reason: 'state-mismatch' };
}

/**
 * Begin a desktop-initiated auth flow. Records a fresh single-use state with a
 * TTL and returns it so the caller may forward it to the server (for the strong
 * binding once producers echo it back).
 */
export function beginAuthExchangeFlow(now: number = Date.now()): string {
  const state = generateAuthExchangeState();
  pending = { state, expiresAt: now + AUTH_EXCHANGE_STATE_TTL_MS };
  return state;
}

/** Read the currently-expected state, or null if none / expired. */
export function peekAuthExchangeState(now: number = Date.now()): string | null {
  if (!pending) return null;
  if (now >= pending.expiresAt) {
    pending = null;
    return null;
  }
  return pending.state;
}

/** Clear any in-progress flow (single-use consumption / explicit reset). */
export function clearAuthExchangeState(): void {
  pending = null;
}
