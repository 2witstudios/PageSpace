import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db, googleCalendarConnections, calendarEvents, eq, and, count } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const settingsSchema = z.object({
  selectedCalendars: z.array(z.string()).min(1, 'At least one calendar must be selected').optional(),
  syncFrequencyMinutes: z.number().min(5).max(1440).optional(), // 5 min to 24 hours
  targetDriveId: z.string().nullable().optional(),
});

/**
 * GET /api/integrations/google-calendar/settings
 * Returns the current settings and event statistics.
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const connection = await db.query.googleCalendarConnections.findFirst({
      where: eq(googleCalendarConnections.userId, userId),
      columns: {
        selectedCalendars: true,
        syncFrequencyMinutes: true,
        targetDriveId: true,
        lastSyncAt: true,
      },
    });

    if (!connection) {
      return NextResponse.json({ error: 'No connection found' }, { status: 404 });
    }

    // Get event count for synced events
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
      settings: {
        selectedCalendars: connection.selectedCalendars,
        syncFrequencyMinutes: connection.syncFrequencyMinutes,
        targetDriveId: connection.targetDriveId,
      },
      stats: {
        syncedEventCount: eventStats?.total ?? 0,
        lastSyncAt: connection.lastSyncAt,
      },
    });
  } catch (error) {
    loggers.api.error('Error fetching Google Calendar settings:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch settings' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/integrations/google-calendar/settings
 * Updates Google Calendar sync settings.
 */
export async function PATCH(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json();
    const validation = settingsSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Invalid settings', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const updates = validation.data;

    // Verify connection exists
    const connection = await db.query.googleCalendarConnections.findFirst({
      where: eq(googleCalendarConnections.userId, userId),
      columns: { id: true, status: true },
    });

    if (!connection) {
      return NextResponse.json({ error: 'No connection found' }, { status: 404 });
    }

    // Build update object
    const setValues: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.selectedCalendars !== undefined) setValues.selectedCalendars = updates.selectedCalendars;
    if (updates.syncFrequencyMinutes !== undefined) setValues.syncFrequencyMinutes = updates.syncFrequencyMinutes;
    if (updates.targetDriveId !== undefined) setValues.targetDriveId = updates.targetDriveId;

    await db
      .update(googleCalendarConnections)
      .set(setValues)
      .where(eq(googleCalendarConnections.userId, userId));

    loggers.api.info('Google Calendar settings updated', { userId, updates });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error updating Google Calendar settings:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    );
  }
}
