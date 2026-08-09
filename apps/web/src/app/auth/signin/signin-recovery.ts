/**
 * Pure decision core for the signin page's silent session recovery.
 *
 * WHY THIS EXISTS. On 2026-07-07 middleware began intercepting any page navigation that
 * arrives without a session cookie and redirecting it to /auth/signin, *before* the app's
 * own JavaScript can run. That JS used to silently recover the session — an expired 7-day
 * cookie was invisible, the page loaded, a 401 came back, and AuthFetch minted a fresh
 * session from the stored device token. The middleware redirect now lands those users
 * on the signin form instead, so they re-authenticate by hand (which then revokes their
 * other devices — a logout storm). This restores the recovery at the page every bounced
 * user now lands on: before showing the form, try to heal the session.
 *
 * NATIVE SHELLS RUN THIS TOO (D1, wave 1). This machine used to short-circuit to `skip` on
 * desktop/Capacitor, on the theory that native shells own their own session and web cookie
 * recovery must stay out of the way. That was the bug: a desktop user middleware-bounced to
 * /auth/signin would see the form even though safeStorage held a valid 90-day session, because
 * nothing re-ran the recovery. Native shells now run the exact same check-me -> refresh ->
 * redirect flow; the shell just routes the effects through platform storage (safeStorage over
 * IPC) and Bearer-attaching fetch. The `authFailedPermanently` guard below is the native
 * loop-guard — it runs FIRST so a genuinely-dead session shows the form instead of looping.
 *
 * FUNCTIONAL CORE. This module holds only the decision. The shell (useSigninRecovery) owns
 * every effect — fetching /api/auth/me, reading the device token, running the refresh, calling
 * the router — and feeds the observations back here one at a time. `undefined` means "not
 * observed yet", which is how the shell drives the machine forward: it keeps calling this
 * with more filled-in fields until it gets a terminal action.
 */

export interface SigninRecoveryInput {
  /**
   * The auth store's permanent-failure flag. When set, a session has already definitively
   * failed (revoked token, detected loop) and must not be retried — retrying is the loop.
   * This is the loop-guard for every shell, native included.
   */
  authFailedPermanently: boolean;
  /** Result of GET /api/auth/me; undefined until the shell has checked. */
  meAuthenticated: boolean | undefined;
  /** Whether a device token exists in platform storage to recover an expired session from. */
  hasDeviceToken: boolean;
  /** Result of the device-token refresh; undefined until the shell has attempted it. */
  refreshSucceeded: boolean | undefined;
}

export type SigninRecoveryAction =
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
 * The progression, once past the loop-guard, is: check the session → if live, redirect →
 * else if a device token exists, refresh → if the refresh succeeds, redirect, otherwise
 * show the form. A missing device token or a failed refresh both terminate at the form,
 * and nothing here ever loops back to an earlier step, so the shell (which runs each
 * action once) cannot spin.
 */
export function decideSigninRecovery(input: SigninRecoveryInput): SigninRecoveryAction {
  const { authFailedPermanently, meAuthenticated, hasDeviceToken, refreshSucceeded } = input;

  // A definitively-dead session must not be retried; that retry IS the loop the store guards.
  // Runs first — before any check-me/refresh — so it wins on every platform (this is the
  // desktop loop-guard).
  if (authFailedPermanently) return { type: 'show-form' };

  // Step 1 — is the current session live?
  if (meAuthenticated === undefined) return { type: 'check-me' };
  if (meAuthenticated) return { type: 'redirect' };

  // Step 2 — the session is dead; can we recover it from a device token?
  if (!hasDeviceToken) return { type: 'show-form' };
  if (refreshSucceeded === undefined) return { type: 'refresh' };

  return refreshSucceeded ? { type: 'redirect' } : { type: 'show-form' };
}
