/**
 * Functional core for device-refresh session housekeeping.
 *
 * A proactive device refresh mints a replacement session every ~15 minutes. Left
 * unchecked the old sessions accumulate (thousands per account), which turns a
 * single interactive login into a thousand-session "revocation storm". This pure
 * decision function retires the exact session a refresh replaces — and ONLY that
 * one, and ONLY when it belongs to the same user — with every side effect injected
 * so the branch table can be covered without a database.
 */

export interface SessionRetirementDeps {
  /** Resolve the owning userId of a live session token, or null if none/inactive. */
  getSessionOwnerId: (token: string) => Promise<string | null>;
  /** Hash a session token to its stored form. */
  hashToken: (token: string) => string;
  /** Revoke a session by its token hash. */
  revokeByHash: (tokenHash: string, reason: string) => Promise<void>;
  /** Structured warn logger — retirement must never fail the refresh. */
  logWarn: (message: string, meta: Record<string, unknown>) => void;
}

export type RetirementOutcome =
  | 'no_session_cookie'
  | 'not_same_user'
  | 'revoked'
  | 'revoke_failed';

export const REPLACED_BY_REFRESH_REASON = 'replaced_by_refresh';

/**
 * Retire the session a device refresh is replacing.
 *
 * - No old cookie present → nothing to retire (`no_session_cookie`).
 * - Old session resolves to a different (or no) user → leave it alone
 *   (`not_same_user`); never revoke another user's session on the strength of a
 *   cookie the request happened to carry.
 * - Old session belongs to the same user → revoke it by hash (`revoked`).
 * - Any effect throws → swallow, log, and report `revoke_failed`; the caller
 *   must still complete the refresh.
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

    await deps.revokeByHash(deps.hashToken(oldSessionToken), REPLACED_BY_REFRESH_REASON);
    return 'revoked';
  } catch (error) {
    deps.logWarn('Failed to retire replaced session on device refresh', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'revoke_failed';
  }
}
