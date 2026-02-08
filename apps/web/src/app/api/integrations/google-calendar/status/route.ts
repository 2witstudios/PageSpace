import { NextResponse } from 'next/server';
import { db, googleCalendarConnections, calendarEvents, eq, and, count } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

/**
 * GET /api/integrations/google-calendar/status
 * Returns the Google Calendar connection status for the authenticated user.
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const connection = await db.query.googleCalendarConnections.findFirst({
      where: eq(googleCalendarConnections.userId, userId),
      columns: {
        id: true,
        status: true,
        statusMessage: true,
        googleEmail: true,
        selectedCalendars: true,
        syncFrequencyMinutes: true,
        targetDriveId: true,
        lastSyncAt: true,
        lastSyncError: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!connection) {
      return NextResponse.json({
        connected: false,
        connection: null,
        syncedEventCount: 0,
      });
    }

    // Get count of synced events for this user
    const [eventStats] = await db
      .select({ total: count() })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.createdById, userId),
          eq(calendarEvents.syncedFromGoogle, true),
          eq(calendarEvents.isTrashed, false)
        )
      );

    return NextResponse.json({
      connected: connection.status === 'active',
      connection: {
        id: connection.id,
        status: connection.status,
        statusMessage: connection.statusMessage,
        googleEmail: connection.googleEmail,
        selectedCalendars: connection.selectedCalendars,
        syncFrequencyMinutes: connection.syncFrequencyMinutes,
        targetDriveId: connection.targetDriveId,
        lastSyncAt: connection.lastSyncAt,
        lastSyncError: connection.lastSyncError,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
      },
      syncedEventCount: eventStats?.total ?? 0,
    });
  } catch (error) {
    loggers.api.error('Error fetching Google Calendar status:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch connection status' },
      { status: 500 }
    );
  }
}
