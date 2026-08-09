/**
 * Functional core for device-refresh session housekeeping.
 *
 * A proactive device refresh mints a replacement session every ~15 minutes. Left
 * unchecked the old sessions accumulate (thousands per account), which turns a
 * single interactive login into a thousand-session "revocation storm". This pure
 * decision function retires the exact session a refresh replaces — and ONLY that
 * one, and ONLY when it belongs to the same user — with every side effect injected
 * so the branch table can be covered without a database.
 *
 * Retirement uses a GRACE-EXPIRY, not an instant hard-revoke: the replaced
 * session's expiry is merely brought forward to a short grace window. Hard-revoke
 * (the previous behaviour) invalidated the old Bearer token the instant the new
 * session landed, so the 1s `active-streams` poll — still carrying the old token —
 * failed validation and produced an `auth_failed` storm. A grace window lets those
 * in-flight requests drain before the retired session dies.
 */

export interface SessionRetirementDeps {
  /** Resolve the owning userId of a live session token, or null if none/inactive. */
  getSessionOwnerId: (token: string) => Promise<string | null>;
  /** Hash a session token to its stored form. */
  hashToken: (token: string) => string;
  /** Grace-expire a session by its token hash (bring its expiry forward, never extend). */
  graceExpireByHash: (tokenHash: string) => Promise<void>;
  /** Structured warn logger — retirement must never fail the refresh. */
  logWarn: (message: string, meta: Record<string, unknown>) => void;
}

export type RetirementOutcome =
  | 'no_session_cookie'
  | 'not_same_user'
  | 'grace_expired'
  | 'grace_expiry_failed';

/**
 * Retire the session a device refresh is replacing.
 *
 * - No old cookie present → nothing to retire (`no_session_cookie`).
 * - Old session resolves to a different (or no) user → leave it alone
 *   (`not_same_user`); never touch another user's session on the strength of a
 *   cookie the request happened to carry.
 * - Old session belongs to the same user → grace-expire it by hash
 *   (`grace_expired`).
 * - Any effect throws → swallow, log, and report `grace_expiry_failed`; the
 *   caller must still complete the refresh.
 */
export async function retireReplacedSession(
  oldSessionToken: string | null | undefined,
  newSessionUserId: string,
  deps: SessionRetirementDeps,
): Promise<RetirementOutcome> {
  if (!oldSessionToken) {
    return 'no_session_cookie';
  }

  try {
    const ownerId = await deps.getSessionOwnerId(oldSessionToken);
    if (ownerId !== newSessionUserId) {
      return 'not_same_user';
    }

    await deps.graceExpireByHash(deps.hashToken(oldSessionToken));
    return 'grace_expired';
  } catch (error) {
    deps.logWarn('Failed to retire replaced session on device refresh', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'grace_expiry_failed';
  }
}
