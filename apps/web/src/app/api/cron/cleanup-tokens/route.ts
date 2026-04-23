import { cleanupExpiredDeviceTokens } from '@pagespace/lib';
import { audit } from '@pagespace/lib/server';
import { NextResponse } from 'next/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint to cleanup expired device tokens
 *
 * This endpoint should be called periodically (e.g., hourly or daily) to remove
 * expired device tokens from the database. While the updated partial unique index
 * prevents expired tokens from blocking new token creation, this cleanup keeps
 * the database tidy and prevents unbounded growth.
 *
 * Authentication:
 * - Primary: HMAC-signed cron requests (via cron-curl)
 * - Defense-in-depth: internal network origin check
 *
 * Trigger via:
 * cron-curl GET http://web:3000/api/cron/cleanup-tokens
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    // Execute cleanup
    const count = await cleanupExpiredDeviceTokens();

    console.log(`[Cron] Cleaned up ${count} expired device tokens`);

    audit({ eventType: 'data.delete', resourceType: 'cron_job', resourceId: 'cleanup_tokens', details: { cleaned: count } });

    return NextResponse.json({
      success: true,
      cleanedUp: count,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Cron] Error cleaning up expired device tokens:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

// Also support POST for consistency with other cron endpoints
export async function POST(request: Request) {
  return GET(request);
}
