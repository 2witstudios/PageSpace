/**
 * Google Calendar API Client
 *
 * Pure functions for building requests and parsing responses.
 * IO functions for making HTTP calls.
 *
 * API Reference: https://developers.google.com/calendar/api/v3/reference
 */

import { loggers } from '@pagespace/lib/server';

const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

// Types matching Google Calendar API responses
export interface GoogleEventDateTime {
  date?: string; // For all-day events (YYYY-MM-DD)
  dateTime?: string; // For timed events (RFC3339)
  timeZone?: string;
}

export interface GoogleEventAttendee {
  id?: string;
  email: string;
  displayName?: string;
  organizer?: boolean;
  self?: boolean;
  resource?: boolean;
  optional?: boolean;
  responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted';
  comment?: string;
}

export interface GoogleCalendarEvent {
  id: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  htmlLink?: string;
  created?: string;
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  creator?: { id?: string; email?: string; displayName?: string; self?: boolean };
  organizer?: { id?: string; email?: string; displayName?: string; self?: boolean };
  start: GoogleEventDateTime;
  end: GoogleEventDateTime;
  endTimeUnspecified?: boolean;
  recurrence?: string[]; // RRULE strings
  recurringEventId?: string;
  originalStartTime?: GoogleEventDateTime;
  transparency?: 'opaque' | 'transparent';
  visibility?: 'default' | 'public' | 'private' | 'confidential';
  iCalUID?: string;
  sequence?: number;
  attendees?: GoogleEventAttendee[];
  hangoutLink?: string;
  conferenceData?: unknown;
  reminders?: {
    useDefault: boolean;
    overrides?: { method: string; minutes: number }[];
  };
  eventType?: 'default' | 'outOfOffice' | 'focusTime' | 'workingLocation';
}

export interface GoogleCalendarListEntry {
  id: string;
  summary: string;
  description?: string;
  timeZone?: string;
  colorId?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  selected?: boolean;
  primary?: boolean;
  accessRole: 'freeBusyReader' | 'reader' | 'writer' | 'owner';
}

export interface GoogleCalendarListResponse {
  kind: 'calendar#calendarList';
  etag: string;
  nextPageToken?: string;
  items: GoogleCalendarListEntry[];
}

export interface GoogleWatchResponse {
  kind: 'api#channel';
  id: string;
  resourceId: string;
  resourceUri: string;
  expiration: string; // milliseconds since epoch as string
}

export interface GoogleEventsListResponse {
  kind: 'calendar#events';
  etag: string;
  summary: string;
  description?: string;
  updated: string;
  timeZone: string;
  accessRole: string;
  nextPageToken?: string;
  nextSyncToken?: string;
  items: GoogleCalendarEvent[];
}

export type GoogleApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; statusCode?: number; requiresReauth?: boolean };

/**
 * Pure function: Build authorization header
 */
export const buildAuthHeader = (accessToken: string): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
});

/**
 * Pure function: Build events list URL
 */
export const buildEventsListUrl = (
  calendarId: string,
  options: {
    timeMin?: Date;
    timeMax?: Date;
    maxResults?: number;
    pageToken?: string;
    syncToken?: string;
    singleEvents?: boolean;
    orderBy?: 'startTime' | 'updated';
  } = {}
): string => {
  const url = new URL(
    `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`
  );

  if (options.timeMin) {
    url.searchParams.set('timeMin', options.timeMin.toISOString());
  }
  if (options.timeMax) {
    url.searchParams.set('timeMax', options.timeMax.toISOString());
  }
  if (options.maxResults) {
    url.searchParams.set('maxResults', options.maxResults.toString());
  }
  if (options.pageToken) {
    url.searchParams.set('pageToken', options.pageToken);
  }
  if (options.syncToken) {
    url.searchParams.set('syncToken', options.syncToken);
  }
  if (options.singleEvents !== undefined) {
    url.searchParams.set('singleEvents', options.singleEvents.toString());
  }
  if (options.orderBy) {
    url.searchParams.set('orderBy', options.orderBy);
  }

  return url.toString();
};

/**
 * IO function: Make authenticated request to Google Calendar API
 */
const makeGoogleApiRequest = async <T>(
  url: string,
  accessToken: string
): Promise<GoogleApiResult<T>> => {
  try {
    const response = await fetch(url, {
      headers: buildAuthHeader(accessToken),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      loggers.api.warn('Google Calendar API error', {
        status: response.status,
        url,
        error: errorBody.slice(0, 500),
      });

      // Check for auth errors
      if (response.status === 401) {
        return {
          success: false,
          error: 'Authentication failed',
          statusCode: 401,
          requiresReauth: true,
        };
      }

      if (response.status === 403) {
        return {
          success: false,
          error: 'Access forbidden - calendar permissions may have been revoked',
          statusCode: 403,
          requiresReauth: true,
        };
      }

      return {
        success: false,
        error: `API error: ${response.status}`,
        statusCode: response.status,
      };
    }

    const data = await response.json();
    return { success: true, data: data as T };
  } catch (error) {
    loggers.api.error('Google Calendar API request failed', error as Error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * IO function: List events from a calendar
 *
 * Handles pagination automatically. For large calendars, consider using
 * incremental sync with syncToken instead.
 */
// Safety limit to prevent unbounded pagination from consuming excessive memory
const MAX_PAGES = 20; // ~5000 events at 250 per page

export const listEvents = async (
  accessToken: string,
  calendarId: string,
  options: {
    timeMin?: Date;
    timeMax?: Date;
    maxResults?: number;
    syncToken?: string;
  } = {}
): Promise<GoogleApiResult<{ events: GoogleCalendarEvent[]; nextSyncToken?: string }>> => {
  const events: GoogleCalendarEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  let pageCount = 0;

  // If using syncToken, don't set time range (Google API requirement)
  const listOptions = options.syncToken
    ? { syncToken: options.syncToken, singleEvents: true }
    : {
        timeMin: options.timeMin,
        timeMax: options.timeMax,
        maxResults: options.maxResults || 250,
        singleEvents: true,
        orderBy: 'startTime' as const,
      };

  do {
    const url = buildEventsListUrl(calendarId, { ...listOptions, pageToken });
    const result = await makeGoogleApiRequest<GoogleEventsListResponse>(url, accessToken);

    if (!result.success) {
      // Handle "sync token invalid" error - need full sync
      if (result.statusCode === 410) {
        return {
          success: false,
          error: 'Sync token expired - full sync required',
          statusCode: 410,
        };
      }
      return result;
    }

    events.push(...result.data.items);
    pageToken = result.data.nextPageToken;
    nextSyncToken = result.data.nextSyncToken;
    pageCount++;

    if (pageCount >= MAX_PAGES && pageToken) {
      loggers.api.warn('Google Calendar pagination safety limit reached', {
        calendarId,
        pageCount,
        eventsCollected: events.length,
      });
      break;
    }
  } while (pageToken);

  return { success: true, data: { events, nextSyncToken } };
};

/**
 * IO function: List all calendars the user has access to
 */
export const listCalendars = async (
  accessToken: string
): Promise<GoogleApiResult<GoogleCalendarListEntry[]>> => {
  const url = `${GOOGLE_CALENDAR_API_BASE}/users/me/calendarList`;
  const result = await makeGoogleApiRequest<GoogleCalendarListResponse>(url, accessToken);

  if (!result.success) return result;
  return { success: true, data: result.data.items };
};

/**
 * IO function: Set up push notifications (watch) for a calendar
 *
 * Google will POST notifications to the webhookUrl when events change.
 * Channels expire after the given ttlSeconds (max ~30 days).
 */
export const watchCalendar = async (
  accessToken: string,
  calendarId: string,
  webhookUrl: string,
  channelId: string,
  ttlSeconds: number = 7 * 24 * 3600, // 7 days default
  channelToken?: string
): Promise<GoogleApiResult<GoogleWatchResponse>> => {
  const url = `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/watch`;
  const expiration = Date.now() + ttlSeconds * 1000;

  try {
    const body: Record<string, unknown> = {
      id: channelId,
      type: 'web_hook',
      address: webhookUrl,
      expiration,
    };
    if (channelToken) {
      body.token = channelToken;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: buildAuthHeader(accessToken),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      loggers.api.warn('Google Calendar watch API error', {
        status: response.status,
        error: errorBody.slice(0, 500),
      });
      return {
        success: false,
        error: `Watch API error: ${response.status}`,
        statusCode: response.status,
        requiresReauth: response.status === 401 || response.status === 403,
      };
    }

    const data = await response.json();
    return { success: true, data: data as GoogleWatchResponse };
  } catch (error) {
    loggers.api.error('Google Calendar watch request failed', error as Error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * IO function: Stop push notifications for a channel
 */
export const stopChannel = async (
  accessToken: string,
  channelId: string,
  resourceId: string
): Promise<GoogleApiResult<void>> => {
  const url = 'https://www.googleapis.com/calendar/v3/channels/stop';

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: buildAuthHeader(accessToken),
      body: JSON.stringify({ id: channelId, resourceId }),
    });

    if (!response.ok && response.status !== 404) {
      // 404 means channel already expired/stopped, which is fine
      const errorBody = await response.text();
      loggers.api.warn('Google Calendar stop channel error', {
        status: response.status,
        error: errorBody.slice(0, 500),
      });
      return {
        success: false,
        error: `Stop channel error: ${response.status}`,
        statusCode: response.status,
      };
    }

    return { success: true, data: undefined };
  } catch (error) {
    loggers.api.error('Google Calendar stop channel failed', error as Error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * IO function: Create an event on Google Calendar (for two-way sync)
 */
export const createGoogleEvent = async (
  accessToken: string,
  calendarId: string,
  event: {
    summary: string;
    description?: string;
    location?: string;
    start: GoogleEventDateTime;
    end: GoogleEventDateTime;
    attendees?: Array<{ email: string }>;
  }
): Promise<GoogleApiResult<GoogleCalendarEvent>> => {
  const url = `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: buildAuthHeader(accessToken),
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      loggers.api.warn('Google Calendar create event error', {
        status: response.status,
        error: errorBody.slice(0, 500),
      });
      return {
        success: false,
        error: `Create event error: ${response.status}`,
        statusCode: response.status,
        requiresReauth: response.status === 401 || response.status === 403,
      };
    }

    const data = await response.json();
    return { success: true, data: data as GoogleCalendarEvent };
  } catch (error) {
    loggers.api.error('Google Calendar create event failed', error as Error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * IO function: Update an event on Google Calendar (for two-way sync)
 */
export const updateGoogleEvent = async (
  accessToken: string,
  calendarId: string,
  eventId: string,
  event: {
    summary?: string;
    description?: string;
    location?: string;
    start?: GoogleEventDateTime;
    end?: GoogleEventDateTime;
    attendees?: Array<{ email: string }>;
  }
): Promise<GoogleApiResult<GoogleCalendarEvent>> => {
  const url = `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;

  try {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: buildAuthHeader(accessToken),
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      loggers.api.warn('Google Calendar update event error', {
        status: response.status,
        error: errorBody.slice(0, 500),
      });
      return {
        success: false,
        error: `Update event error: ${response.status}`,
        statusCode: response.status,
        requiresReauth: response.status === 401 || response.status === 403,
      };
    }

    const data = await response.json();
    return { success: true, data: data as GoogleCalendarEvent };
  } catch (error) {
    loggers.api.error('Google Calendar update event failed', error as Error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

/**
 * IO function: Delete an event on Google Calendar (for two-way sync)
 */
export const deleteGoogleEvent = async (
  accessToken: string,
  calendarId: string,
  eventId: string
): Promise<GoogleApiResult<void>> => {
  const url = `${GOOGLE_CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;

  try {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: buildAuthHeader(accessToken),
    });

    if (!response.ok && response.status !== 404 && response.status !== 410) {
      const errorBody = await response.text();
      loggers.api.warn('Google Calendar delete event error', {
        status: response.status,
        error: errorBody.slice(0, 500),
      });
      return {
        success: false,
        error: `Delete event error: ${response.status}`,
        statusCode: response.status,
        requiresReauth: response.status === 401 || response.status === 403,
      };
    }

    return { success: true, data: undefined };
  } catch (error) {
    loggers.api.error('Google Calendar delete event failed', error as Error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};
