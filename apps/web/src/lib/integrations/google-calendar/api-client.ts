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
