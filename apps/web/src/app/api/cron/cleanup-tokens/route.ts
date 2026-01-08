import { cleanupExpiredDeviceTokens, secureCompare } from '@pagespace/lib';
import { NextResponse } from 'next/server';

/**
 * Cron endpoint to cleanup expired device tokens
 *
 * This endpoint should be called periodically (e.g., hourly or daily) to remove
 * expired device tokens from the database. While the updated partial unique index
 * prevents expired tokens from blocking new token creation, this cleanup keeps
 * the database tidy and prevents unbounded growth.
 *
 * Authentication:
 * - Requires CRON_SECRET environment variable to be set
 * - Request must include: Authorization: Bearer <CRON_SECRET>
 *
 * Setup with Vercel Cron (vercel.json):
 * {
 *   "crons": [{
 *     "path": "/api/cron/cleanup-tokens",
 *     "schedule": "0 * * * *"
 *   }]
 * }
 *
 * Or use external cron service (cron-job.org, etc.) with:
 * curl -X GET https://your-domain.com/api/cron/cleanup-tokens \
 *   -H "Authorization: Bearer YOUR_CRON_SECRET"
 */
export async function GET(request: Request) {
  try {
    // Verify cron secret for security
    const authHeader = request.headers.get('authorization');
    const expectedAuth = process.env.CRON_SECRET;

    if (!expectedAuth) {
      console.error('CRON_SECRET environment variable not set');
      return NextResponse.json(
        { error: 'Cron secret not configured' },
        { status: 500 }
      );
    }

    // Use timing-safe comparison to prevent timing attacks
    const expectedHeader = `Bearer ${expectedAuth}`;
    if (!authHeader || !secureCompare(authHeader, expectedHeader)) {
      console.warn('Unauthorized cron request attempt');
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

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
