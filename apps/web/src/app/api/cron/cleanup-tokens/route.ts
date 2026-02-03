import { cleanupExpiredDeviceTokens } from '@pagespace/lib';
import { NextResponse } from 'next/server';
import { validateCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint to cleanup expired device tokens
 *
 * This endpoint should be called periodically (e.g., hourly or daily) to remove
 * expired device tokens from the database. While the updated partial unique index
 * prevents expired tokens from blocking new token creation, this cleanup keeps
 * the database tidy and prevents unbounded growth.
 *
 * Authentication:
 * - Zero-trust: only accessible from localhost (no secret comparison)
 * - Must be called from within the same machine (docker network)
 *
 * Trigger via:
 * curl http://localhost:3000/api/cron/cleanup-tokens
 */
export async function GET(request: Request) {
  // Zero trust: only allow requests from localhost (no secret comparison)
  const authError = validateCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    // Execute cleanup
    const count = await cleanupExpiredDeviceTokens();

    console.log(`[Cron] Cleaned up ${count} expired device tokens`);

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
