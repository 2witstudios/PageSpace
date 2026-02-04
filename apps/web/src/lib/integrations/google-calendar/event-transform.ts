/**
 * Event Transformation
 *
 * Pure functions for transforming between Google Calendar and PageSpace event formats.
 * All functions are side-effect free and can be unit tested in isolation.
 */

import type { GoogleCalendarEvent, GoogleEventDateTime } from './api-client';
import type { NewCalendarEvent } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';

// Map Google color IDs to PageSpace color categories
const GOOGLE_COLOR_MAP: Record<string, string> = {
  '1': 'default', // Lavender
  '2': 'default', // Sage
  '3': 'default', // Grape
  '4': 'personal', // Flamingo
  '5': 'default', // Banana
  '6': 'meeting', // Tangerine
  '7': 'default', // Peacock
  '8': 'default', // Graphite
  '9': 'focus', // Blueberry
  '10': 'default', // Basil
  '11': 'deadline', // Tomato
};

// Map Google visibility to PageSpace visibility
const VISIBILITY_MAP: Record<string, 'DRIVE' | 'ATTENDEES_ONLY' | 'PRIVATE'> = {
  default: 'DRIVE',
  public: 'DRIVE',
  private: 'PRIVATE',
  confidential: 'PRIVATE',
};

/**
 * Pure function: Parse Google datetime to JavaScript Date
 */
export const parseGoogleDateTime = (dt: GoogleEventDateTime): { date: Date; allDay: boolean } => {
  if (dt.date) {
    // All-day event - date is in YYYY-MM-DD format
    // Parse as local date, not UTC
    const [year, month, day] = dt.date.split('-').map(Number);
    return {
      date: new Date(year, month - 1, day),
      allDay: true,
    };
  }

  if (dt.dateTime) {
    return {
      date: new Date(dt.dateTime),
      allDay: false,
    };
  }

  // Fallback to current time if neither is present
  return { date: new Date(), allDay: false };
};

/**
 * Pure function: Extract timezone from Google event
 */
export const extractTimezone = (event: GoogleCalendarEvent): string => {
  return event.start.timeZone || event.end.timeZone || 'UTC';
};

/**
 * Pure function: Map Google color ID to PageSpace color
 */
export const mapGoogleColor = (colorId?: string): string => {
  if (!colorId) return 'default';
  return GOOGLE_COLOR_MAP[colorId] || 'default';
};

/**
 * Pure function: Map Google visibility to PageSpace visibility
 */
export const mapGoogleVisibility = (
  visibility?: string
): 'DRIVE' | 'ATTENDEES_ONLY' | 'PRIVATE' => {
  if (!visibility) return 'DRIVE';
  return VISIBILITY_MAP[visibility] || 'DRIVE';
};

/**
 * Pure function: Sanitize HTML description to plain text
 *
 * Google Calendar descriptions can contain HTML. We strip tags
 * and decode entities for safe storage.
 */
export const sanitizeDescription = (html?: string): string | null => {
  if (!html) return null;

  // Remove HTML tags
  let text = html.replace(/<[^>]*>/g, ' ');

  // Decode common HTML entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");

  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text || null;
};

/**
 * Pure function: Parse Google RRULE to PageSpace recurrence format
 *
 * Example RRULE: "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20240101T000000Z"
 */
export const parseRecurrenceRule = (
  recurrence?: string[]
): NewCalendarEvent['recurrenceRule'] => {
  if (!recurrence || recurrence.length === 0) return null;

  // Find the RRULE line
  const rruleLine = recurrence.find((r) => r.startsWith('RRULE:'));
  if (!rruleLine) return null;

  const ruleStr = rruleLine.substring(6); // Remove "RRULE:" prefix
  const parts = ruleStr.split(';');
  const ruleMap: Record<string, string> = {};

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key && value) {
      ruleMap[key] = value;
    }
  }

  const freq = ruleMap.FREQ;
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) {
    return null;
  }

  const rule: NonNullable<NewCalendarEvent['recurrenceRule']> = {
    frequency: freq as 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY',
    interval: ruleMap.INTERVAL ? parseInt(ruleMap.INTERVAL, 10) : 1,
  };

  // Parse BYDAY (for weekly)
  if (ruleMap.BYDAY) {
    const days = ruleMap.BYDAY.split(',') as ('MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU')[];
    rule.byDay = days.filter((d) =>
      ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].includes(d)
    );
  }

  // Parse BYMONTHDAY (for monthly)
  if (ruleMap.BYMONTHDAY) {
    rule.byMonthDay = ruleMap.BYMONTHDAY.split(',').map(Number).filter((n) => !isNaN(n));
  }

  // Parse BYMONTH (for yearly)
  if (ruleMap.BYMONTH) {
    rule.byMonth = ruleMap.BYMONTH.split(',').map(Number).filter((n) => !isNaN(n));
  }

  // Parse COUNT
  if (ruleMap.COUNT) {
    rule.count = parseInt(ruleMap.COUNT, 10);
  }

  // Parse UNTIL
  if (ruleMap.UNTIL) {
    // UNTIL format: 20240101T000000Z or 20240101
    const until = ruleMap.UNTIL;
    if (until.length === 8) {
      // Date only
      rule.until = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`;
    } else {
      // Full datetime
      const date = new Date(
        `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}T${until.slice(9, 11)}:${until.slice(11, 13)}:${until.slice(13, 15)}Z`
      );
      rule.until = date.toISOString();
    }
  }

  return rule;
};

/**
 * Pure function: Transform Google Calendar event to PageSpace event format
 *
 * @param googleEvent - The Google Calendar event
 * @param context - Additional context for the transformation
 * @returns A partial PageSpace event ready for insertion
 */
export const transformGoogleEventToPageSpace = (
  googleEvent: GoogleCalendarEvent,
  context: {
    userId: string;
    driveId: string | null;
    googleCalendarId: string;
    markAsReadOnly: boolean;
  }
): Omit<NewCalendarEvent, 'createdAt' | 'updatedAt'> => {
  const start = parseGoogleDateTime(googleEvent.start);
  const end = parseGoogleDateTime(googleEvent.end);

  return {
    id: createId(),
    driveId: context.driveId,
    createdById: context.userId,
    pageId: null,

    // Event details
    title: googleEvent.summary || '(No title)',
    description: sanitizeDescription(googleEvent.description),
    location: googleEvent.location || null,

    // Temporal fields
    startAt: start.date,
    endAt: end.date,
    allDay: start.allDay,
    timezone: extractTimezone(googleEvent),

    // Recurrence
    recurrenceRule: parseRecurrenceRule(googleEvent.recurrence),
    recurrenceExceptions: [],
    recurringEventId: googleEvent.recurringEventId || null,
    originalStartAt: googleEvent.originalStartTime
      ? parseGoogleDateTime(googleEvent.originalStartTime).date
      : null,

    // Visibility and appearance
    visibility: mapGoogleVisibility(googleEvent.visibility),
    color: mapGoogleColor(googleEvent.colorId),

    // Metadata
    metadata: {
      googleHtmlLink: googleEvent.htmlLink,
      googleCreator: googleEvent.creator?.email,
      googleOrganizer: googleEvent.organizer?.email,
      googleStatus: googleEvent.status,
      googleEventType: googleEvent.eventType,
    },

    // Soft delete
    isTrashed: googleEvent.status === 'cancelled',
    trashedAt: googleEvent.status === 'cancelled' ? new Date() : null,

    // Google sync tracking
    googleEventId: googleEvent.id,
    googleCalendarId: context.googleCalendarId,
    syncedFromGoogle: true,
    lastGoogleSync: new Date(),
    googleSyncReadOnly: context.markAsReadOnly,
  };
};

/**
 * Pure function: Check if a Google event should be synced
 *
 * Filters out events that shouldn't be imported.
 */
export const shouldSyncEvent = (event: GoogleCalendarEvent): boolean => {
  // Skip declined events
  if (event.status === 'cancelled') {
    // Still sync cancelled events to mark as trashed
    return true;
  }

  // Skip events without a start time
  if (!event.start) {
    return false;
  }

  // Skip out-of-office and working location events (optional)
  if (event.eventType === 'outOfOffice' || event.eventType === 'workingLocation') {
    return false;
  }

  return true;
};

/**
 * Pure function: Determine if a PageSpace event needs updating from Google
 *
 * Compares timestamps and key fields to decide if an update is needed.
 */
export const needsUpdate = (
  pageSpaceEvent: { lastGoogleSync: Date | null; title: string; startAt: Date; endAt: Date },
  googleEvent: GoogleCalendarEvent
): boolean => {
  // If never synced, needs update
  if (!pageSpaceEvent.lastGoogleSync) {
    return true;
  }

  // Check if Google event was updated after our last sync
  if (googleEvent.updated) {
    const googleUpdated = new Date(googleEvent.updated);
    if (googleUpdated > pageSpaceEvent.lastGoogleSync) {
      return true;
    }
  }

  return false;
};
