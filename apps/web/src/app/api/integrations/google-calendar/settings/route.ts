import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, googleCalendarConnections, calendarEvents, eq, and } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

const updateSettingsSchema = z.object({
  markAsReadOnly: z.boolean().optional(),
});

/**
 * PATCH /api/integrations/google-calendar/settings
 *
 * Update Google Calendar connection settings.
 * When toggling markAsReadOnly, also bulk-updates existing synced events.
 */
export async function PATCH(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const connection = await db.query.googleCalendarConnections.findFirst({
      where: eq(googleCalendarConnections.userId, userId),
      columns: { id: true, status: true, markAsReadOnly: true },
    });

    if (!connection) {
      return NextResponse.json(
        { error: 'No Google Calendar connection found' },
        { status: 404 }
      );
    }

    const body = await request.json();
    const parseResult = updateSettingsSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parseResult.error.issues },
        { status: 400 }
      );
    }

    const data = parseResult.data;

    // Update connection settings
    if (data.markAsReadOnly !== undefined) {
      await db
        .update(googleCalendarConnections)
        .set({
          markAsReadOnly: data.markAsReadOnly,
          updatedAt: new Date(),
        })
        .where(eq(googleCalendarConnections.userId, userId));

      // Bulk-update existing synced events to match the new setting
      await db
        .update(calendarEvents)
        .set({
          googleSyncReadOnly: data.markAsReadOnly,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(calendarEvents.createdById, userId),
            eq(calendarEvents.syncedFromGoogle, true)
          )
        );

      loggers.api.info('Google Calendar sync direction updated', {
        userId,
        markAsReadOnly: data.markAsReadOnly,
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error updating Google Calendar settings:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    );
  }
}
