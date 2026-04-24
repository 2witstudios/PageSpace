/**
 * Expired auth-handoff-token sweep.
 *
 * The `auth_handoff_tokens` table stores short-lived tokens (PKCE verifiers,
 * OAuth exchange codes, desktop↔browser passkey register handoffs, plus the
 * one-options-per-handoff replay marker). The consume paths already respect
 * `expires_at`, so expired rows are merely wasted disk/index bytes — not a
 * correctness issue. This helper is the best-effort periodic cleanup run
 * from the cron sweep route.
 *
 * Mirrors `sweepExpiredRevokedJTIs` and `sweepExpiredRateLimitBuckets`:
 * constant-size `rowCount` return; re-throws in production so the cron
 * handler can surface a 500; swallows and warns in non-production.
 */

import { db } from '@pagespace/db/db';
import { sql, lt } from '@pagespace/db/operators';
import { authHandoffTokens } from '@pagespace/db/schema/auth-handoff-tokens';
import { loggers } from '../logging/logger-config';

export async function sweepExpiredAuthHandoffTokens(): Promise<number> {
  try {
    const result = await db
      .delete(authHandoffTokens)
      .where(lt(authHandoffTokens.expiresAt, sql`now()`));
    return result.rowCount ?? 0;
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      throw error;
    }
    loggers.api.warn('Auth-handoff-token sweep skipped: DB unavailable');
    return 0;
  }
}
