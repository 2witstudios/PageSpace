/**
 * Pure refresh-token rotation decision for the OAuth 2.1 provider (ADR 0003
 * §3.3-3.4, §6-§7; Phase 1 task 8). No I/O: takes the fetched refresh-token
 * record, `now`, and the impure shell's grace-cache lookup *result* (it
 * already did the cache GET before calling in — this function stays pure by
 * taking the fact, not performing the I/O), and returns what to do. The
 * repository fetches the record under `FOR UPDATE`, calls this, and persists
 * whatever the decision implies — this module never touches the database, a
 * cache, or the clock itself.
 *
 * Following the `code-lifecycle.ts` / `token-lifecycle-policy.ts` precedent:
 * exhaustive discriminated unions, fail-closed at every boundary.
 *
 * @module @pagespace/lib/auth/oauth/refresh-rotation
 */

/** ADR 0003 §3.2: concurrent-refresh grace window. */
export const REFRESH_GRACE_WINDOW_MS = 30_000;

export interface RefreshTokenRecord {
  /** Per-token TTL (30d), fixed at issuance/rotation. */
  expiresAt: Date;
  /** Absolute family cap (90d), fixed at first issuance, never extended. */
  familyExpiresAt: Date;
  /** Set the moment this token is rotated away or revoked; null while live. */
  revokedAt: Date | null;
  /** The token this one was rotated into, if any. */
  replacedByTokenId: string | null;
  /** The user's `tokenVersion` snapshotted at this token's issuance/rotation. */
  tokenVersion: number;
}

export type RefreshRotationDecision =
  | { ok: true; action: 'rotate' }
  /** Caller fulfills from the ephemeral grace cache (§3.4) — hand back the
   *  same replacement pair already minted for the first request. */
  | { ok: true; action: 'grace-replay' }
  | { ok: false; reason: 'expired' | 'family_expired'; revokeFamily: false }
  /** In-window but the cache lost the pair — an infra gap, not theft. */
  | { ok: false; reason: 'grace_cache_miss'; revokeFamily: false }
  | { ok: false; reason: 'reuse_detected'; revokeFamily: true }
  /** The user's tokenVersion has advanced since this token was issued (a
   *  global "logout all devices") — refuse, but the family is NOT revoked:
   *  this is not attacker behavior. */
  | { ok: false; reason: 'version_mismatch'; revokeFamily: false };

/**
 * Decide what a presented refresh token means right now.
 *
 * Precedence (each a distinct security posture, most specific first):
 *  1. Already revoked (`revokedAt` set) is checked first — a revoked token
 *     with a replacement wired up (`replacedByTokenId`) fired from a prior
 *     rotation, not a manual/family revocation:
 *       - inside the 30s grace window: a benign concurrent-refresh replay if
 *         the cache still has the pair (`grace-replay`), or an infra gap if
 *         it doesn't (`grace_cache_miss` — family is NOT revoked, this is
 *         not attacker behavior).
 *       - outside the window, or with no replacement to replay (e.g. the
 *         token was revoked by a family-wide reuse revocation, not a
 *         rotation): reuse — revoke the entire family.
 *  2. family_expired — the absolute 90-day cap wins over a still-live
 *     per-token TTL; it is fixed at first issuance and never extended.
 *  3. expired — the per-token 30-day TTL.
 *  4. version_mismatch — the user's tokenVersion has advanced since this
 *     token's snapshot (a global "logout all devices"). Refused, but the
 *     family is left alone: this is an intentional logout, not theft.
 *  5. otherwise — rotate: issue a fresh pair, revoke the presented token.
 */
export function decideRefreshRotation(
  record: RefreshTokenRecord,
  userTokenVersion: number,
  now: Date,
  graceCacheHit: boolean,
): RefreshRotationDecision {
  if (record.revokedAt !== null) {
    const elapsedSinceRevocation = now.getTime() - record.revokedAt.getTime();
    const withinGraceWindow = elapsedSinceRevocation < REFRESH_GRACE_WINDOW_MS;

    if (withinGraceWindow && record.replacedByTokenId !== null) {
      return graceCacheHit
        ? { ok: true, action: 'grace-replay' }
        : { ok: false, reason: 'grace_cache_miss', revokeFamily: false };
    }

    return { ok: false, reason: 'reuse_detected', revokeFamily: true };
  }

  if (now.getTime() >= record.familyExpiresAt.getTime()) {
    return { ok: false, reason: 'family_expired', revokeFamily: false };
  }

  if (now.getTime() >= record.expiresAt.getTime()) {
    return { ok: false, reason: 'expired', revokeFamily: false };
  }

  if (record.tokenVersion !== userTokenVersion) {
    return { ok: false, reason: 'version_mismatch', revokeFamily: false };
  }

  return { ok: true, action: 'rotate' };
}
