import { sweepExpiredRevokedJTIs } from '@pagespace/lib/security/jti-revocation';
import { sweepExpiredRateLimitBuckets } from '@pagespace/lib/security/distributed-rate-limit';
import { sweepExpiredAuthHandoffTokens } from '@pagespace/lib/security/auth-handoff-sweep';
import { sweepExpiredPendingAbortIntents } from '@/lib/ai/core/pending-abort-intents';
import { sweepExpiredPendingUploads } from '@pagespace/lib/services/pending-uploads';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint to sweep expired rows from append-only-with-TTL tables.
 *
 * Currently swept:
 * - `revoked_service_tokens` (JTI revocation tombstones)
 * - `rate_limit_buckets` (finished sliding-window counter buckets)
 * - `auth_handoff_tokens` (PKCE, exchange-code, passkey-register handoff)
 * - `ai_pending_abort_intents` (pre-INSERT Stop intents never consumed by a later send)
 * - `pending_uploads` (presign-reserved upload slots abandoned past their TTL, #2154)
 *
 * Each table is swept inside its own try/catch so a failure on one does not
 * block the others. `rowCount` (via the helpers) is used instead of
 * `.returning()` so the response is constant-size regardless of how many
 * rows were deleted.
 *
 * Authentication:
 * - Primary: HMAC-signed cron requests (via cron-curl)
 * - Defense-in-depth: internal network origin check
 *
 * Trigger via:
 *   cron-curl GET http://web:3000/api/cron/sweep-expired
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  const results: Record<string, number | { error: string }> = {};

  try {
    results.revokedServiceTokens = await sweepExpiredRevokedJTIs();
  } catch (error) {
    results.revokedServiceTokens = {
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  try {
    results.rateLimitBuckets = await sweepExpiredRateLimitBuckets();
  } catch (error) {
    results.rateLimitBuckets = {
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  try {
    results.authHandoffTokens = await sweepExpiredAuthHandoffTokens();
  } catch (error) {
    results.authHandoffTokens = {
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  try {
    results.pendingAbortIntents = await sweepExpiredPendingAbortIntents();
  } catch (error) {
    results.pendingAbortIntents = {
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  try {
    results.pendingUploads = await sweepExpiredPendingUploads();
  } catch (error) {
    results.pendingUploads = {
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  const hadError = Object.values(results).some((v) => typeof v !== 'number');

  audit({
    eventType: 'data.delete',
    resourceType: 'cron_job',
    resourceId: 'sweep_expired',
    details: results,
  });

  if (hadError) {
    loggers.system.error('[Cron] sweep-expired partial failure', undefined, { results });
    return NextResponse.json(
      { success: false, results, timestamp: new Date().toISOString() },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    results,
    timestamp: new Date().toISOString(),
  });
}

export async function POST(request: Request) {
  return GET(request);
}
