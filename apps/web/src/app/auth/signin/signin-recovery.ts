/**
 * Pure decision core for the signin page's silent session recovery.
 *
 * WHY THIS EXISTS. On 2026-07-07 middleware began intercepting any page navigation that
 * arrives without a session cookie and redirecting it to /auth/signin, *before* the app's
 * own JavaScript can run. That JS used to silently recover the session — an expired 7-day
 * cookie was invisible, the page loaded, a 401 came back, and AuthFetch minted a fresh
 * session from the localStorage device token. The middleware redirect now lands those users
 * on the signin form instead, so they re-authenticate by hand (which then revokes their
 * other devices — a logout storm). This restores the recovery at the page every bounced
 * user now lands on: before showing the form, try to heal the session.
 *
 * FUNCTIONAL CORE. This module holds only the decision. The shell (useSigninRecovery) owns
 * every effect — fetching /api/auth/me, reading localStorage, running the refresh, calling
 * the router — and feeds the observations back here one at a time. `undefined` means "not
 * observed yet", which is how the shell drives the machine forward: it keeps calling this
 * with more filled-in fields until it gets a terminal action.
 */

export interface SigninRecoveryInput {
  /**
   * Desktop (Electron) or Capacitor (iOS) shell. Those shells authenticate with bearer
   * tokens / keychain, not the web session cookie, and the auth store already recovers
   * them — web cookie recovery must never run there.
   */
  isNativeShell: boolean;
  /**
   * The auth store's permanent-failure flag. When set, a session has already definitively
   * failed (revoked token, detected loop) and must not be retried — retrying is the loop.
   */
  authFailedPermanently: boolean;
  /** Result of GET /api/auth/me; undefined until the shell has checked. */
  meAuthenticated: boolean | undefined;
  /** Whether a device token exists in localStorage to recover an expired cookie from. */
  hasDeviceToken: boolean;
  /** Result of the device-token refresh; undefined until the shell has attempted it. */
  refreshSucceeded: boolean | undefined;
}

export type SigninRecoveryAction =
  /** Native shell: don't run web recovery at all — render the form as today. */
  | { type: 'skip' }
  /** Observe the current session via GET /api/auth/me. */
  | { type: 'check-me' }
  /** Attempt the device-token refresh (reuses AuthFetch's refresh machinery). */
  | { type: 'refresh' }
  /** A session is (or became) live — navigate the user onward. */
  | { type: 'redirect' }
  /** Recovery is exhausted — render the sign-in form. */
  | { type: 'show-form' };

/**
 * Given what the shell has observed so far, decide the next recovery action.
 *
 * The progression, once past the two guards, is: check the session → if live, redirect →
 * else if a device token exists, refresh → if the refresh succeeds, redirect, otherwise
 * show the form. A missing device token or a failed refresh both terminate at the form,
 * and nothing here ever loops back to an earlier step, so the shell (which runs each
 * action once) cannot spin.
 */
export function decideSigninRecovery(input: SigninRecoveryInput): SigninRecoveryAction {
  const { isNativeShell, authFailedPermanently, meAuthenticated, hasDeviceToken, refreshSucceeded } =
    input;

  if (isNativeShell) return { type: 'skip' };

  // A definitively-dead session must not be retried; that retry IS the loop the store guards.
  if (authFailedPermanently) return { type: 'show-form' };

  // Step 1 — is the current session live?
  if (meAuthenticated === undefined) return { type: 'check-me' };
  if (meAuthenticated) return { type: 'redirect' };

  // Step 2 — the session is dead; can we recover it from a device token?
  if (!hasDeviceToken) return { type: 'show-form' };
  if (refreshSucceeded === undefined) return { type: 'refresh' };

  return refreshSucceeded ? { type: 'redirect' } : { type: 'show-form' };
}
