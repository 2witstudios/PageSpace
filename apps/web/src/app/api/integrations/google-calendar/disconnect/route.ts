import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, and, inArray } from '@pagespace/db/operators'
import {
  googleCalendarConnections,
  calendarEvents,
  eventAttendees,
  calendarEventDrives,
} from '@pagespace/db/schema/calendar';
import { calendarTriggers } from '@pagespace/db/schema/calendar-triggers';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { decrypt } from '@pagespace/lib/encryption/encryption-utils';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { unregisterWebhookChannels } from '@/lib/integrations/google-calendar/sync-service';
import { buildCalendarCacheErasurePlan } from '@/lib/integrations/google-calendar/cache-erasure';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

/**
 * POST /api/integrations/google-calendar/disconnect
 * Disconnects Google Calendar integration for the authenticated user.
 * Revokes OAuth token and updates connection status.
 */
export async function POST(request: Request) {
  if (isOnPrem()) return Response.json({ error: 'Not available' }, { status: 404 });
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Fetch connection
    const connection = await db.query.googleCalendarConnections.findFirst({
      where: eq(googleCalendarConnections.userId, userId),
    });

    if (!connection) {
      return NextResponse.json(
        { error: 'No connection found' },
        { status: 404 }
      );
    }

    // Try to revoke the Google token and unregister webhooks (best effort)
    // Skip if tokens are already cleared from a prior disconnect
    if (connection.accessToken !== 'REVOKED') {
      try {
        const accessToken = await decrypt(connection.accessToken);

        // Unregister webhook channels before revoking token
        await unregisterWebhookChannels(userId, accessToken).catch(err => {
          loggers.auth.warn('Webhook channel unregistration failed', {
            error: err instanceof Error ? err.message : String(err),
            userId,
          });
        });

        await fetch(`https://oauth2.googleapis.com/revoke?token=${accessToken}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        loggers.auth.info('Google Calendar token revoked', { userId });
      } catch (error) {
        // Log but don't fail - token might already be expired/revoked
        loggers.auth.warn('Failed to revoke Google token (continuing with disconnect)', {
          userId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    // GDPR Art 5(1)(e) + Art 17 (#959): erase cached Google-synced data that
    // survived prior disconnects. The pure plan decides WHAT to erase; this edge
    // executes it in FK-safe order. User-CREATED events (syncedFromGoogle=false)
    // are never matched and always survive.
    const plan = buildCalendarCacheErasurePlan({ userId });

    // Collect the IDs of this user's Google-synced cached events.
    const syncedEvents = await db
      .select({ id: calendarEvents.id })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.createdById, plan.syncedEventMatch.createdById),
          eq(calendarEvents.syncedFromGoogle, plan.syncedEventMatch.syncedFromGoogle),
        ),
      );
    const syncedEventIds = syncedEvents.map((e) => e.id);

    let deletedSyncedEvents = 0;
    if (plan.deleteSyncedEvents && syncedEventIds.length > 0) {
      // Children before parents (FK-safe): triggers → junction → attendees → events.
      await db.delete(calendarTriggers).where(inArray(calendarTriggers.calendarEventId, syncedEventIds));
      await db.delete(calendarEventDrives).where(inArray(calendarEventDrives.eventId, syncedEventIds));
      await db.delete(eventAttendees).where(inArray(eventAttendees.eventId, syncedEventIds));
      const deleted = await db
        .delete(calendarEvents)
        .where(inArray(calendarEvents.id, syncedEventIds))
        .returning({ id: calendarEvents.id });
      deletedSyncedEvents = deleted.length;
    }

    // Update connection status to disconnected and CLEAR all cached PII fields.
    // We retain a minimal disconnected stub for UX (status only) per the plan,
    // but strip syncCursor/lastSyncAt/lastSyncError/webhookChannels/selectedCalendars
    // and revoke the OAuth tokens.
    await db
      .update(googleCalendarConnections)
      .set({
        status: 'disconnected',
        statusMessage: 'Disconnected by user',
        // Clear tokens for security (they're revoked anyway)
        accessToken: 'REVOKED',
        refreshToken: 'REVOKED',
        // Clear cached PII / sync state (#959)
        syncCursor: null,
        lastSyncAt: null,
        lastSyncError: null,
        webhookChannels: null,
        selectedCalendars: [],
        updatedAt: new Date(),
      })
      .where(eq(googleCalendarConnections.userId, userId));

    loggers.auth.info('Google Calendar disconnected', { userId, deletedSyncedEvents });

    if (connection.accessToken !== 'REVOKED') {
      auditRequest(request, { eventType: 'auth.token.revoked', userId, details: { tokenType: 'google_calendar', reason: 'user_disconnect' } });
    }
    auditRequest(request, {
      eventType: 'data.delete',
      userId,
      resourceType: 'calendar_connection',
      resourceId: connection.id,
      details: {
        operation: 'disconnect',
        erasedSyncedEvents: deletedSyncedEvents,
        clearedConnectionCacheFields: plan.clearConnectionCacheFields,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error disconnecting Google Calendar:', error as Error);
    return NextResponse.json(
      { error: 'Failed to disconnect' },
      { status: 500 }
    );
  }
}
