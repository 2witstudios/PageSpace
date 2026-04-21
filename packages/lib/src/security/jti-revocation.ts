/**
 * JTI (JWT ID) Revocation — Postgres-backed.
 *
 * Tracks and revokes service-token JTIs via `revoked_service_tokens`. Rows
 * are inserted on token issuance (`revoked_at = NULL`) and flipped to
 * `revoked_at = now()` on revocation. `isJTIRevoked` fails closed: unknown
 * or expired rows count as revoked.
 *
 * The cron sweeper in `apps/web/src/app/api/cron/sweep-expired/route.ts`
 * calls `sweepExpiredRevokedJTIs` to prune rows past their `expires_at`.
 *
 * @module @pagespace/lib/security/jti-revocation
 */

import { db, revokedServiceTokens, and, eq, gt, lt, sql } from '@pagespace/db';
import { loggers } from '../logging/logger-config';

/**
 * Record a new JTI (JWT ID) for a service token.
 *
 * Inserts a row into `revoked_service_tokens` with `revoked_at = NULL` and
 * `expires_at = now + expiresInSeconds`. The row tracks that the JTI was
 * issued; `revokeJTI` later sets `revoked_at` to flip it to revoked.
 *
 * SECURITY: In production, throws if the DB write fails (fail-closed).
 * In development, logs a warning and continues (graceful degradation).
 */
export async function recordJTI(
  jti: string,
  userId: string,
  expiresInSeconds: number
): Promise<void> {
  try {
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    await db
      .insert(revokedServiceTokens)
      .values({ jti, revokedAt: null, expiresAt })
      .onConflictDoNothing({ target: revokedServiceTokens.jti });
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      throw error;
    }
    loggers.api.warn('JTI recording skipped: DB unavailable', { userId });
  }
}

/**
 * Check if a JTI is revoked.
 * Returns true (revoked) if:
 * - The row exists and `revoked_at IS NOT NULL`
 * - The row exists but is past its `expires_at`
 * - No row exists (token was never recorded — fail closed)
 *
 * SECURITY: Always fails closed — when in doubt, treat token as revoked.
 * In production, re-throws on DB failure rather than silently returning true,
 * so upstream retries / health checks can see the outage.
 */
export async function isJTIRevoked(jti: string): Promise<boolean> {
  try {
    const rows = await db
      .select({
        revokedAt: revokedServiceTokens.revokedAt,
        expiresAt: revokedServiceTokens.expiresAt,
      })
      .from(revokedServiceTokens)
      .where(eq(revokedServiceTokens.jti, jti))
      .limit(1);

    if (rows.length === 0) {
      return true;
    }
    const row = rows[0];
    if (row.expiresAt.getTime() <= Date.now()) {
      return true;
    }
    return row.revokedAt !== null;
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      throw error;
    }
    loggers.api.warn('JTI check failed: DB unavailable - treating as revoked');
    return true;
  }
}

/**
 * Revoke a specific JTI.
 *
 * Atomic single-statement UPDATE: sets `revoked_at = now()` only if the row
 * exists and has not expired. Returns false when the JTI was never recorded
 * or has already expired (matching prior Redis semantics). Idempotent —
 * re-revoking an already-revoked JTI resets `revoked_at` to now().
 *
 * SECURITY: In production, throws if DB unavailable (fail-closed).
 */
export async function revokeJTI(jti: string, reason: string): Promise<boolean> {
  try {
    const result = await db
      .update(revokedServiceTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(revokedServiceTokens.jti, jti),
          gt(revokedServiceTokens.expiresAt, sql`now()`),
        ),
      );

    const updated = (result.rowCount ?? 0) > 0;
    if (updated) {
      loggers.api.info('JTI revoked', { jti: '[REDACTED]', reason });
    }
    return updated;
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      throw error;
    }
    loggers.api.warn('JTI revocation skipped: DB unavailable');
    return false;
  }
}

/**
 * Delete revoked-JTI rows whose `expires_at` is in the past.
 * Runs on the cron sweeper; returns the number of rows deleted.
 *
 * Not fail-closed: the sweeper is best-effort cleanup. In production we
 * still re-throw so the cron handler can surface a 500 and page ops.
 */
export async function sweepExpiredRevokedJTIs(): Promise<number> {
  try {
    const result = await db
      .delete(revokedServiceTokens)
      .where(lt(revokedServiceTokens.expiresAt, sql`now()`));
    return result.rowCount ?? 0;
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      throw error;
    }
    loggers.api.warn('JTI sweep skipped: DB unavailable');
    return 0;
  }
}
