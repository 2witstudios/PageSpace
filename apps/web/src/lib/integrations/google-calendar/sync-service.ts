/**
 * Google Calendar Sync Service
 *
 * Orchestrates syncing events from Google Calendar to PageSpace.
 * Handles both initial full sync and incremental updates.
 */

import { db, googleCalendarConnections, calendarEvents, eq, and } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { getValidAccessToken, updateConnectionStatus } from './token-refresh';
import { listEvents, type GoogleCalendarEvent } from './api-client';
import { transformGoogleEventToPageSpace, shouldSyncEvent, needsUpdate } from './event-transform';

export interface SyncResult {
  success: boolean;
  eventsCreated: number;
  eventsUpdated: number;
  eventsDeleted: number;
  error?: string;
}

/**
 * Per-calendar sync cursors stored as JSON in the syncCursor field.
 * Maps calendar ID to Google's sync token.
 */
type SyncCursors = Record<string, string>;

/**
 * Parse sync cursors from the stored string.
 * Handles migration from old single-cursor format.
 */
const parseSyncCursors = (stored: string | null): SyncCursors => {
  if (!stored) return {};
  try {
    const parsed = JSON.parse(stored);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as SyncCursors;
    }
    return {};
  } catch {
    // Old format was a single string token - discard it since we can't know which calendar it was for
    return {};
  }
};

/**
 * Serialize sync cursors for storage.
 */
const serializeSyncCursors = (cursors: SyncCursors): string => {
  return JSON.stringify(cursors);
};

/**
 * Sync events from Google Calendar for a user.
 *
 * @param userId - The user to sync for
 * @param options - Sync options
 */
export const syncGoogleCalendar = async (
  userId: string,
  options: {
    fullSync?: boolean; // Force full sync even if we have a sync cursor
    timeMin?: Date; // Start of time range (default: 30 days ago)
    timeMax?: Date; // End of time range (default: 90 days ahead)
  } = {}
): Promise<SyncResult> => {
  const result: SyncResult = {
    success: false,
    eventsCreated: 0,
    eventsUpdated: 0,
    eventsDeleted: 0,
  };

  try {
    // Get valid access token
    const tokenResult = await getValidAccessToken(userId);
    if (!tokenResult.success) {
      result.error = tokenResult.error;
      return result;
    }

    // Get connection details
    const connection = await db.query.googleCalendarConnections.findFirst({
      where: eq(googleCalendarConnections.userId, userId),
    });

    if (!connection) {
      result.error = 'No connection found';
      return result;
    }

    if (connection.status !== 'active') {
      result.error = `Connection is ${connection.status}`;
      return result;
    }

    const calendarsToSync = connection.selectedCalendars || ['primary'];
    const accessToken = tokenResult.accessToken;

    // Determine time range for sync
    const now = new Date();
    const timeMin = options.timeMin || new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    const timeMax = options.timeMax || new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days ahead

    // Parse per-calendar sync cursors
    const syncCursors = parseSyncCursors(connection.syncCursor);

    // Sync each selected calendar
    for (const calendarId of calendarsToSync) {
      // Use per-calendar sync token for incremental sync if available and not forcing full sync
      const calendarSyncToken = !options.fullSync ? syncCursors[calendarId] : undefined;

      const calendarResult = await syncCalendar(
        userId,
        accessToken,
        calendarId,
        connection.targetDriveId,
        connection.markAsReadOnly,
        calendarSyncToken,
        timeMin,
        timeMax
      );

      result.eventsCreated += calendarResult.eventsCreated;
      result.eventsUpdated += calendarResult.eventsUpdated;
      result.eventsDeleted += calendarResult.eventsDeleted;

      // Save sync cursor for this calendar if we got one
      if (calendarResult.syncCursor) {
        syncCursors[calendarId] = calendarResult.syncCursor;
      }
    }

    // Persist all updated sync cursors and update last sync time
    await db
      .update(googleCalendarConnections)
      .set({
        syncCursor: serializeSyncCursors(syncCursors),
        lastSyncAt: new Date(),
        lastSyncError: null,
        updatedAt: new Date(),
      })
      .where(eq(googleCalendarConnections.userId, userId));

    result.success = true;

    loggers.api.info('Google Calendar sync completed', {
      userId,
      eventsCreated: result.eventsCreated,
      eventsUpdated: result.eventsUpdated,
      eventsDeleted: result.eventsDeleted,
    });

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const requiresReauth = error instanceof Error && (error as Error & { requiresReauth?: boolean }).requiresReauth === true;
    result.error = errorMessage;

    loggers.api.error('Google Calendar sync failed', error as Error, { userId });

    if (requiresReauth) {
      // Permission or auth error — mark connection so UI can prompt reconnection
      await updateConnectionStatus(userId, 'error', 'Calendar permissions may have been revoked - please reconnect');
      await db
        .update(googleCalendarConnections)
        .set({
          lastSyncError: errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(googleCalendarConnections.userId, userId));
    } else {
      // Transient or unknown error — keep connection active
      await db
        .update(googleCalendarConnections)
        .set({
          lastSyncError: errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(googleCalendarConnections.userId, userId));
    }

    return result;
  }
};

/**
 * Sync a single calendar's events.
 */
const syncCalendar = async (
  userId: string,
  accessToken: string,
  calendarId: string,
  targetDriveId: string | null,
  markAsReadOnly: boolean,
  syncToken: string | undefined | null,
  timeMin: Date,
  timeMax: Date
): Promise<{
  eventsCreated: number;
  eventsUpdated: number;
  eventsDeleted: number;
  syncCursor?: string;
}> => {
  const result = {
    eventsCreated: 0,
    eventsUpdated: 0,
    eventsDeleted: 0,
    syncCursor: undefined as string | undefined,
  };

  // Fetch events from Google
  const listResult = await listEvents(accessToken, calendarId, {
    syncToken: syncToken ?? undefined,
    timeMin: syncToken ? undefined : timeMin, // Don't use time range with sync token
    timeMax: syncToken ? undefined : timeMax,
  });

  if (!listResult.success) {
    // If sync token is invalid, fall back to full sync (only if we were using a sync token)
    if (listResult.statusCode === 410 && syncToken) {
      loggers.api.info('Sync token expired, performing full sync', { userId, calendarId });
      return syncCalendar(
        userId,
        accessToken,
        calendarId,
        targetDriveId,
        markAsReadOnly,
        undefined, // No sync token - this guarantees no further 410 fallback
        timeMin,
        timeMax
      );
    }

    // Propagate permission/auth errors so the caller can update connection status
    if (listResult.requiresReauth) {
      const error = new Error(listResult.error);
      (error as Error & { requiresReauth: boolean }).requiresReauth = true;
      throw error;
    }

    throw new Error(listResult.error);
  }

  const { events, nextSyncToken } = listResult.data;
  result.syncCursor = nextSyncToken;

  // Process each event
  for (const googleEvent of events) {
    if (!shouldSyncEvent(googleEvent)) {
      continue;
    }

    const eventResult = await upsertEvent(
      userId,
      googleEvent,
      calendarId,
      targetDriveId,
      markAsReadOnly
    );

    if (eventResult.action === 'created') result.eventsCreated++;
    else if (eventResult.action === 'updated') result.eventsUpdated++;
    else if (eventResult.action === 'deleted') result.eventsDeleted++;
  }

  return result;
};

/**
 * Upsert a single event from Google Calendar.
 */
const upsertEvent = async (
  userId: string,
  googleEvent: GoogleCalendarEvent,
  calendarId: string,
  targetDriveId: string | null,
  markAsReadOnly: boolean
): Promise<{ action: 'created' | 'updated' | 'deleted' | 'skipped' }> => {
  // Check if event already exists
  const existingEvent = await db.query.calendarEvents.findFirst({
    where: and(
      eq(calendarEvents.createdById, userId),
      eq(calendarEvents.googleEventId, googleEvent.id),
      eq(calendarEvents.googleCalendarId, calendarId)
    ),
    columns: {
      id: true,
      lastGoogleSync: true,
      title: true,
      startAt: true,
      endAt: true,
    },
  });

  // Handle cancelled/deleted events
  if (googleEvent.status === 'cancelled') {
    if (existingEvent) {
      await db
        .update(calendarEvents)
        .set({
          isTrashed: true,
          trashedAt: new Date(),
          lastGoogleSync: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(calendarEvents.id, existingEvent.id));
      return { action: 'deleted' };
    }
    return { action: 'skipped' };
  }

  // Transform Google event to PageSpace format
  const pageSpaceEvent = transformGoogleEventToPageSpace(googleEvent, {
    userId,
    driveId: targetDriveId,
    googleCalendarId: calendarId,
    markAsReadOnly,
  });

  if (existingEvent) {
    // Check if update is needed
    if (!needsUpdate(existingEvent, googleEvent)) {
      return { action: 'skipped' };
    }

    // Update existing event
    await db
      .update(calendarEvents)
      .set({
        title: pageSpaceEvent.title,
        description: pageSpaceEvent.description,
        location: pageSpaceEvent.location,
        startAt: pageSpaceEvent.startAt,
        endAt: pageSpaceEvent.endAt,
        allDay: pageSpaceEvent.allDay,
        timezone: pageSpaceEvent.timezone,
        recurrenceRule: pageSpaceEvent.recurrenceRule,
        visibility: pageSpaceEvent.visibility,
        color: pageSpaceEvent.color,
        metadata: pageSpaceEvent.metadata,
        isTrashed: pageSpaceEvent.isTrashed,
        trashedAt: pageSpaceEvent.trashedAt,
        lastGoogleSync: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(calendarEvents.id, existingEvent.id));

    return { action: 'updated' };
  }

  // Create new event
  const inserted = await db
    .insert(calendarEvents)
    .values({
      ...pageSpaceEvent,
      updatedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [
        calendarEvents.createdById,
        calendarEvents.googleCalendarId,
        calendarEvents.googleEventId,
      ],
    })
    .returning({ id: calendarEvents.id });

  if (inserted.length === 0) {
    return { action: 'skipped' };
  }

  return { action: 'created' };
};

/**
 * Trigger sync for a user (can be called from API or background job).
 */
export const triggerSync = async (userId: string): Promise<SyncResult> => {
  return syncGoogleCalendar(userId);
};
