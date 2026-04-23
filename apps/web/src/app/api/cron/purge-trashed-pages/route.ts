import { NextResponse } from 'next/server';
import { audit, pageRepository } from '@pagespace/lib/server';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

/**
 * Cron endpoint to hard-delete pages that have been in the trash for 30+ days.
 *
 * Implements Art. 17 GDPR erasure: trashed pages are soft-deleted immediately,
 * then permanently removed after the 30-day retention window.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce, X-Cron-Signature headers.
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const pagesPurged = await pageRepository.purgeExpiredTrashedPages(thirtyDaysAgo);

    console.log(`[Cron] Purged trashed pages: ${pagesPurged}`);

    audit({
      eventType: 'data.delete',
      userId: 'system',
      resourceType: 'cron_job',
      resourceId: 'purge_trashed_pages',
      details: { pagesPurged },
    });

    return NextResponse.json({
      success: true,
      pagesPurged,
      timestamp: now.toISOString(),
    });
  } catch (error) {
    console.error('[Cron] Error purging trashed pages:', error);
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
