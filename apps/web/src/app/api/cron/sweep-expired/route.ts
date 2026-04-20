import { sweepExpiredRevokedJTIs } from '@pagespace/lib/security';
import { audit } from '@pagespace/lib/server';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint to sweep expired rows from tables that use an
 * append-only-with-TTL pattern.
 *
 * Currently sweeps:
 * - `revoked_service_tokens` (JTI revocation tombstones)
 *
 * PR 3 will extend this handler with `rate_limit_buckets`.
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

  try {
    const jtisCleaned = await sweepExpiredRevokedJTIs();

    console.log(`[Cron] Sweep: cleaned ${jtisCleaned} expired revoked JTIs`);

    audit({
      eventType: 'data.delete',
      userId: 'system',
      resourceType: 'cron_job',
      resourceId: 'sweep_expired',
      details: { revokedServiceTokens: jtisCleaned },
    });

    return NextResponse.json({
      success: true,
      swept: { revokedServiceTokens: jtisCleaned },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Cron] Error sweeping expired rows:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
