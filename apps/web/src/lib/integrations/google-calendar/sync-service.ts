/**
 * Google Calendar Sync Service
 *
 * Orchestrates syncing events from Google Calendar to PageSpace.
 * Handles both initial full sync and incremental updates.
 */

import { db, googleCalendarConnections, calendarEvents, eventAttendees, users, eq, and, inArray } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { getValidAccessToken, updateConnectionStatus } from './token-refresh';
import { listEvents, watchCalendar, stopChannel, type GoogleCalendarEvent, type GoogleEventAttendee } from './api-client';
import { transformGoogleEventToPageSpace, shouldSyncEvent, needsUpdate } from './event-transform';
import { createId } from '@paralleldrive/cuid2';

type WebhookChannel = { channelId: string; resourceId: string; expiration: string };
type WebhookChannels = Record<string, WebhookChannel>;

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

    // Register/renew webhook push notification channels (non-blocking best effort)
    registerWebhookChannels(userId, accessToken, calendarsToSync).catch((err) => {
      loggers.api.warn('Failed to register webhook channels after sync', {
        userId,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
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

    // Map Google attendees to PageSpace users
    await mapAttendeesToUsers(existingEvent.id, googleEvent.attendees);

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

  // Map Google attendees to PageSpace users for newly created event
  await mapAttendeesToUsers(inserted[0].id, googleEvent.attendees);

  return { action: 'created' };
};

/**
 * Register or renew webhook push notification channels for all selected calendars.
 * Channels expire after ~7 days, so they need periodic renewal.
 */
export const registerWebhookChannels = async (
  userId: string,
  accessToken: string,
  calendarsToSync: string[]
): Promise<void> => {
  const baseUrl = process.env.WEB_APP_URL || process.env.NEXTAUTH_URL;
  if (!baseUrl) {
    loggers.api.warn('Cannot register webhooks: WEB_APP_URL not configured');
    return;
  }

  const webhookUrl = `${baseUrl}/api/integrations/google-calendar/webhook`;

  // Get existing channels
  const connection = await db.query.googleCalendarConnections.findFirst({
    where: eq(googleCalendarConnections.userId, userId),
    columns: { webhookChannels: true },
  });

  const existingChannels: WebhookChannels = (connection?.webhookChannels as WebhookChannels) || {};
  const updatedChannels: WebhookChannels = {};
  const now = Date.now();

  for (const calendarId of calendarsToSync) {
    const existing = existingChannels[calendarId];

    // Skip if channel exists and won't expire within 1 hour
    if (existing && parseInt(existing.expiration) > now + 3600 * 1000) {
      updatedChannels[calendarId] = existing;
      continue;
    }

    // Stop old channel if it exists (best effort)
    if (existing) {
      await stopChannel(accessToken, existing.channelId, existing.resourceId).catch(() => {
        // Ignore errors stopping old channels
      });
    }

    // Create new watch channel
    const channelId = createId();
    const result = await watchCalendar(accessToken, calendarId, webhookUrl, channelId);

    if (result.success) {
      updatedChannels[calendarId] = {
        channelId,
        resourceId: result.data.resourceId,
        expiration: result.data.expiration,
      };
      loggers.api.info('Google Calendar webhook registered', { userId, calendarId, channelId });
    } else {
      loggers.api.warn('Failed to register Google Calendar webhook', {
        userId,
        calendarId,
        error: result.error,
      });
      // Keep old channel if registration failed but it hasn't expired
      if (existing && parseInt(existing.expiration) > now) {
        updatedChannels[calendarId] = existing;
      }
    }
  }

  // Remove channels for calendars no longer selected
  for (const calId of Object.keys(existingChannels)) {
    if (!calendarsToSync.includes(calId) && existingChannels[calId]) {
      await stopChannel(accessToken, existingChannels[calId].channelId, existingChannels[calId].resourceId).catch(() => {});
    }
  }

  // Persist updated channels
  await db
    .update(googleCalendarConnections)
    .set({
      webhookChannels: updatedChannels,
      updatedAt: new Date(),
    })
    .where(eq(googleCalendarConnections.userId, userId));
};

/**
 * Unregister all webhook channels for a user (called on disconnect).
 */
export const unregisterWebhookChannels = async (
  userId: string,
  accessToken: string
): Promise<void> => {
  const connection = await db.query.googleCalendarConnections.findFirst({
    where: eq(googleCalendarConnections.userId, userId),
    columns: { webhookChannels: true },
  });

  const channels = (connection?.webhookChannels as WebhookChannels) || {};

  for (const calId of Object.keys(channels)) {
    await stopChannel(accessToken, channels[calId].channelId, channels[calId].resourceId).catch(() => {});
  }

  await db
    .update(googleCalendarConnections)
    .set({
      webhookChannels: null,
      updatedAt: new Date(),
    })
    .where(eq(googleCalendarConnections.userId, userId));
};

/**
 * Map Google event attendees to PageSpace users by email and persist as eventAttendees.
 * Only maps attendees that have a matching PageSpace user account.
 */
const mapAttendeesToUsers = async (
  eventId: string,
  googleAttendees: GoogleEventAttendee[] | undefined
): Promise<void> => {
  if (!googleAttendees || googleAttendees.length === 0) return;

  // Collect unique attendee emails
  const emails = [...new Set(googleAttendees.map((a) => a.email.toLowerCase()))];
  if (emails.length === 0) return;

  // Look up PageSpace users by email (batch query)
  const matchedUsers = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.email, emails));

  if (matchedUsers.length === 0) return;

  // Build a map of email → userId for fast lookup
  const emailToUserId = new Map(matchedUsers.map((u) => [u.email.toLowerCase(), u.id]));

  // Map Google response status to PageSpace attendee status
  const statusMap: Record<string, 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'TENTATIVE'> = {
    needsAction: 'PENDING',
    accepted: 'ACCEPTED',
    declined: 'DECLINED',
    tentative: 'TENTATIVE',
  };

  // Build attendee records
  const attendeeValues = googleAttendees
    .filter((a) => emailToUserId.has(a.email.toLowerCase()))
    .map((a) => ({
      id: createId(),
      eventId,
      userId: emailToUserId.get(a.email.toLowerCase())!,
      status: statusMap[a.responseStatus || 'needsAction'] || ('PENDING' as const),
      isOrganizer: a.organizer ?? false,
      isOptional: a.optional ?? false,
    }));

  if (attendeeValues.length === 0) return;

  // Upsert attendees (update status if already exists)
  for (const attendee of attendeeValues) {
    await db
      .insert(eventAttendees)
      .values(attendee)
      .onConflictDoUpdate({
        target: [eventAttendees.eventId, eventAttendees.userId],
        set: {
          status: attendee.status,
          isOrganizer: attendee.isOrganizer,
          isOptional: attendee.isOptional,
        },
      });
  }
};

/**
 * Trigger sync for a user (can be called from API or background job).
 */
export const triggerSync = async (userId: string): Promise<SyncResult> => {
  return syncGoogleCalendar(userId);
};
