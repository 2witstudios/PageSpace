/**
 * Google Calendar Push Service
 *
 * Pushes PageSpace calendar events to Google Calendar.
 * Handles create, update, and delete operations.
 */

import { db, googleCalendarConnections, calendarEvents, eq, and } from '@pagespace/db';
import type { CalendarEvent } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { getValidAccessToken } from './token-refresh';
import {
  createGoogleEvent,
  updateGoogleEvent,
  deleteGoogleEvent,
  type GoogleEventDateTime,
} from './api-client';

export interface PushResult {
  success: boolean;
  googleEventId?: string;
  error?: string;
}

/**
 * Pure function: Convert a PageSpace recurrence rule to Google RRULE string
 */
export const buildGoogleRRule = (
  rule: CalendarEvent['recurrenceRule']
): string[] | undefined => {
  if (!rule) return undefined;

  const parts = [`FREQ=${rule.frequency}`];

  if (rule.interval && rule.interval > 1) {
    parts.push(`INTERVAL=${rule.interval}`);
  }
  if (rule.byDay && rule.byDay.length > 0) {
    parts.push(`BYDAY=${rule.byDay.join(',')}`);
  }
  if (rule.byMonthDay && rule.byMonthDay.length > 0) {
    parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
  }
  if (rule.byMonth && rule.byMonth.length > 0) {
    parts.push(`BYMONTH=${rule.byMonth.join(',')}`);
  }
  if (rule.count) {
    parts.push(`COUNT=${rule.count}`);
  }
  if (rule.until) {
    const date = new Date(rule.until);
    const until = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    parts.push(`UNTIL=${until}`);
  }

  return [`RRULE:${parts.join(';')}`];
};

// Reverse map from PageSpace color to Google color ID
const PAGESPACE_TO_GOOGLE_COLOR: Record<string, string> = {
  personal: '4',   // Flamingo
  meeting: '6',    // Tangerine
  focus: '9',      // Blueberry
  deadline: '11',  // Tomato
};

// Reverse map from PageSpace visibility to Google visibility
const PAGESPACE_TO_GOOGLE_VISIBILITY: Record<string, 'default' | 'public' | 'private'> = {
  DRIVE: 'default',
  ATTENDEES_ONLY: 'default',
  PRIVATE: 'private',
};

/**
 * Pure function: Transform a PageSpace event to a Google Calendar event body
 */
export const transformPageSpaceEventToGoogle = (event: CalendarEvent) => {
  const body: {
    summary: string;
    description?: string;
    location?: string;
    start: GoogleEventDateTime;
    end: GoogleEventDateTime;
    visibility?: 'default' | 'public' | 'private' | 'confidential';
    colorId?: string;
    recurrence?: string[];
  } = {
    summary: event.title,
    description: event.description || undefined,
    location: event.location || undefined,
    visibility: PAGESPACE_TO_GOOGLE_VISIBILITY[event.visibility] || 'default',
    start: {},
    end: {},
  };

  // Set color if we have a mapping
  const googleColor = PAGESPACE_TO_GOOGLE_COLOR[event.color || ''];
  if (googleColor) {
    body.colorId = googleColor;
  }

  // Set start/end times
  if (event.allDay) {
    body.start = {
      date: event.startAt.toISOString().slice(0, 10),
    };
    body.end = {
      date: event.endAt.toISOString().slice(0, 10),
    };
  } else {
    body.start = {
      dateTime: event.startAt.toISOString(),
      timeZone: event.timezone,
    };
    body.end = {
      dateTime: event.endAt.toISOString(),
      timeZone: event.timezone,
    };
  }

  // Set recurrence
  body.recurrence = buildGoogleRRule(event.recurrenceRule);

  return body;
};

/**
 * Check if a user has an active Google Calendar connection with push enabled.
 */
export const getActiveConnection = async (
  userId: string
): Promise<{
  connected: boolean;
  pushEnabled: boolean;
  targetCalendarId: string;
} | null> => {
  const connection = await db.query.googleCalendarConnections.findFirst({
    where: and(
      eq(googleCalendarConnections.userId, userId),
      eq(googleCalendarConnections.status, 'active')
    ),
    columns: {
      selectedCalendars: true,
      googleEmail: true,
    },
  });

  if (!connection) return null;

  // Resolve the target calendar — use googleEmail if first calendar is 'primary'
  const firstCalendar = connection.selectedCalendars?.[0] || 'primary';
  const targetCalendarId = firstCalendar === 'primary'
    ? (connection.googleEmail || 'primary')
    : firstCalendar;

  return {
    connected: true,
    pushEnabled: true,
    targetCalendarId,
  };
};

/**
 * Push a newly created PageSpace event to Google Calendar.
 * Updates the local event with the Google event ID for future sync.
 */
export const pushEventToGoogle = async (
  userId: string,
  eventId: string
): Promise<PushResult> => {
  try {
    const connection = await getActiveConnection(userId);
    if (!connection?.pushEnabled) {
      return { success: true };
    }

    const event = await db.query.calendarEvents.findFirst({
      where: eq(calendarEvents.id, eventId),
    });

    if (!event) {
      return { success: false, error: 'Event not found' };
    }

    // Don't push events that were synced FROM Google (would create duplicates)
    if (event.syncedFromGoogle) {
      return { success: true };
    }

    const tokenResult = await getValidAccessToken(userId);
    if (!tokenResult.success) {
      return { success: false, error: tokenResult.error };
    }

    const googleEvent = transformPageSpaceEventToGoogle(event);
    const result = await createGoogleEvent(
      tokenResult.accessToken,
      connection.targetCalendarId,
      googleEvent
    );

    if (!result.success) {
      loggers.api.error('Failed to push event to Google Calendar', {
        userId,
        eventId,
        error: result.error,
      });
      return { success: false, error: result.error };
    }

    // Store the Google event ID so we can update/delete later
    await db
      .update(calendarEvents)
      .set({
        googleEventId: result.data.id,
        googleCalendarId: connection.targetCalendarId,
        lastGoogleSync: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(calendarEvents.id, eventId));

    loggers.api.info('Pushed event to Google Calendar', {
      userId,
      eventId,
      googleEventId: result.data.id,
    });

    return { success: true, googleEventId: result.data.id };
  } catch (error) {
    loggers.api.error('Error pushing event to Google Calendar', error as Error, { userId, eventId });
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
};

/**
 * Push an updated PageSpace event to Google Calendar.
 */
export const pushEventUpdateToGoogle = async (
  userId: string,
  eventId: string
): Promise<PushResult> => {
  try {
    const connection = await getActiveConnection(userId);
    if (!connection?.pushEnabled) {
      return { success: true };
    }

    const event = await db.query.calendarEvents.findFirst({
      where: eq(calendarEvents.id, eventId),
    });

    if (!event || !event.googleEventId || !event.googleCalendarId) {
      return { success: true }; // No Google event to update
    }

    const tokenResult = await getValidAccessToken(userId);
    if (!tokenResult.success) {
      return { success: false, error: tokenResult.error };
    }

    const googleEvent = transformPageSpaceEventToGoogle(event);
    const result = await updateGoogleEvent(
      tokenResult.accessToken,
      event.googleCalendarId,
      event.googleEventId,
      googleEvent
    );

    if (!result.success) {
      loggers.api.error('Failed to push event update to Google Calendar', {
        userId,
        eventId,
        googleEventId: event.googleEventId,
        error: result.error,
      });
      return { success: false, error: result.error };
    }

    await db
      .update(calendarEvents)
      .set({
        lastGoogleSync: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(calendarEvents.id, eventId));

    loggers.api.info('Pushed event update to Google Calendar', {
      userId,
      eventId,
      googleEventId: event.googleEventId,
    });

    return { success: true, googleEventId: event.googleEventId };
  } catch (error) {
    loggers.api.error('Error pushing event update to Google', error as Error, { userId, eventId });
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
};

/**
 * Delete a PageSpace event from Google Calendar.
 */
export const pushEventDeleteToGoogle = async (
  userId: string,
  eventId: string
): Promise<PushResult> => {
  try {
    const connection = await getActiveConnection(userId);
    if (!connection?.pushEnabled) {
      return { success: true };
    }

    const event = await db.query.calendarEvents.findFirst({
      where: eq(calendarEvents.id, eventId),
    });

    if (!event || !event.googleEventId || !event.googleCalendarId) {
      return { success: true }; // No Google event to delete
    }

    const tokenResult = await getValidAccessToken(userId);
    if (!tokenResult.success) {
      return { success: false, error: tokenResult.error };
    }

    const result = await deleteGoogleEvent(
      tokenResult.accessToken,
      event.googleCalendarId,
      event.googleEventId
    );

    if (!result.success) {
      loggers.api.error('Failed to delete event from Google Calendar', {
        userId,
        eventId,
        googleEventId: event.googleEventId,
        error: result.error,
      });
      return { success: false, error: result.error };
    }

    loggers.api.info('Deleted event from Google Calendar', {
      userId,
      eventId,
      googleEventId: event.googleEventId,
    });

    return { success: true, googleEventId: event.googleEventId };
  } catch (error) {
    loggers.api.error('Error deleting event from Google', error as Error, { userId, eventId });
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
};
