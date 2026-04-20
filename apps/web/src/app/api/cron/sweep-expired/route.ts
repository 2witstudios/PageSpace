import { db, rateLimitBuckets, sql } from '@pagespace/db';
import { audit } from '@pagespace/lib/server';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint to sweep expired security rows.
 *
 * Runs `DELETE ... WHERE expires_at < now()` against each table whose
 * expires_at column marks a row as stale. Tables are swept independently
 * so a failure on one does not block the others.
 *
 * Currently swept:
 * - rate_limit_buckets — finished sliding-window counter buckets
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
    const deleted = await db
      .delete(rateLimitBuckets)
      .where(sql`${rateLimitBuckets.expiresAt} < now()`)
      .returning({ key: rateLimitBuckets.key });
    results.rate_limit_buckets = deleted.length;
  } catch (error) {
    results.rate_limit_buckets = {
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  const hadError = Object.values(results).some(
    (v) => typeof v !== 'number',
  );

  audit({
    eventType: 'data.delete',
    userId: 'system',
    resourceType: 'cron_job',
    resourceId: 'sweep_expired',
    details: results,
  });

  if (hadError) {
    console.error('[Cron] sweep-expired partial failure:', results);
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
