import { NextResponse } from 'next/server';
import { db, googleCalendarConnections, eq, and, lt } from '@pagespace/db';
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

    // Find all active connections that are due for sync
    const connections = await db.query.googleCalendarConnections.findMany({
      where: eq(googleCalendarConnections.status, 'active'),
      columns: {
        userId: true,
        syncFrequencyMinutes: true,
        lastSyncAt: true,
      },
    });

    // Filter to connections that are due for sync
    const dueConnections = connections.filter((conn) => {
      if (!conn.lastSyncAt) return true; // Never synced
      const nextSyncAt = new Date(conn.lastSyncAt.getTime() + conn.syncFrequencyMinutes * 60 * 1000);
      return now >= nextSyncAt;
    });

    loggers.api.info('Calendar sync cron: processing due connections', {
      total: connections.length,
      due: dueConnections.length,
    });

    let synced = 0;
    let failed = 0;
    const errors: Array<{ userId: string; error: string }> = [];

    // Sync each due connection sequentially to avoid overwhelming Google API
    for (const conn of dueConnections) {
      try {
        const result = await syncGoogleCalendar(conn.userId);
        if (result.success) {
          synced++;
        } else {
          failed++;
          errors.push({ userId: conn.userId, error: result.error || 'Unknown error' });
        }
      } catch (error) {
        failed++;
        errors.push({
          userId: conn.userId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
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
