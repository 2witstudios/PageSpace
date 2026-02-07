import { NextResponse } from 'next/server';
import { db, googleCalendarConnections, eq, and, or, lt, isNull, sql } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { validateCronRequest } from '@/lib/auth/cron-auth';
import { syncGoogleCalendar } from '@/lib/integrations/google-calendar/sync-service';

/**
 * Cron endpoint for automatic background Google Calendar sync.
 *
 * Finds all active connections that are due for sync based on their
 * syncFrequencyMinutes setting, and triggers incremental sync for each.
 *
 * This serves as a fallback to ensure data stays fresh even if webhook
 * push notifications are missed or delayed. With webhooks working properly,
 * most syncs happen in near-real-time via the webhook endpoint.
 *
 * Recommended cron schedule: every 5 minutes
 * curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/calendar-sync
 */
export async function GET(request: Request) {
  const authError = validateCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const now = new Date();

    // Find all active connections that are due for sync (filtering in SQL)
    const dueConnections = await db.query.googleCalendarConnections.findMany({
      where: and(
        eq(googleCalendarConnections.status, 'active'),
        or(
          isNull(googleCalendarConnections.lastSyncAt),
          lt(
            googleCalendarConnections.lastSyncAt,
            sql`now() - (${googleCalendarConnections.syncFrequencyMinutes} * interval '1 minute')`
          )
        )
      ),
      columns: {
        userId: true,
        syncFrequencyMinutes: true,
        lastSyncAt: true,
      },
    });

    loggers.api.info('Calendar sync cron: processing due connections', {
      due: dueConnections.length,
    });

    let synced = 0;
    let failed = 0;
    const errors: Array<{ error: string }> = [];

    // Sync each due connection sequentially to avoid overwhelming Google API
    for (const conn of dueConnections) {
      try {
        const result = await syncGoogleCalendar(conn.userId);
        if (result.success) {
          synced++;
        } else {
          failed++;
          loggers.api.error('Calendar sync cron: sync failed for user', undefined, {
            userId: conn.userId,
            error: result.error || 'Unknown error',
          });
          errors.push({ error: result.error || 'Unknown error' });
        }
      } catch (error) {
        failed++;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        loggers.api.error('Calendar sync cron: sync threw for user', error as Error, {
          userId: conn.userId,
        });
        errors.push({ error: errorMessage });
      }
    }

    loggers.api.info('Calendar sync cron completed', { synced, failed });

    return NextResponse.json({
      success: true,
      synced,
      failed,
      errors: errors.length > 0 ? errors : undefined,
      timestamp: now.toISOString(),
    });
  } catch (error) {
    loggers.api.error('Calendar sync cron error:', error as Error);
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
