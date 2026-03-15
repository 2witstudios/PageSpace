/**
 * Tests for event-transform.ts
 * Pure functions for transforming between Google Calendar and PageSpace event formats.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @paralleldrive/cuid2 so createId is deterministic
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'test-cuid-id'),
}));

// Mock @pagespace/db - only the types are needed (NewCalendarEvent)
vi.mock('@pagespace/db', () => ({}));

import {
  parseGoogleDateTime,
  extractTimezone,
  mapGoogleColor,
  mapGoogleVisibility,
  mapEventColor,
  extractConferenceLink,
  sanitizeDescription,
  parseRecurrenceRule,
  transformGoogleEventToPageSpace,
  shouldSyncEvent,
  needsUpdate,
} from '../event-transform';
import type { GoogleCalendarEvent, GoogleEventDateTime } from '../api-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent {
  return {
    id: 'google-event-1',
    status: 'confirmed',
    summary: 'Test Event',
    start: { dateTime: '2024-03-15T10:00:00Z', timeZone: 'America/New_York' },
    end: { dateTime: '2024-03-15T11:00:00Z', timeZone: 'America/New_York' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseGoogleDateTime
// ---------------------------------------------------------------------------

describe('parseGoogleDateTime', () => {
  it('should parse a dateTime string as a non-all-day event', () => {
    const dt: GoogleEventDateTime = { dateTime: '2024-03-15T10:00:00Z' };
    const result = parseGoogleDateTime(dt);
    expect(result.allDay).toBe(false);
    expect(result.date).toBeInstanceOf(Date);
    expect(result.date.toISOString()).toBe('2024-03-15T10:00:00.000Z');
  });

  it('should parse a date string as an all-day event', () => {
    const dt: GoogleEventDateTime = { date: '2024-03-15' };
    const result = parseGoogleDateTime(dt);
    expect(result.allDay).toBe(true);
    expect(result.date).toBeInstanceOf(Date);
    // Local date components
    expect(result.date.getFullYear()).toBe(2024);
    expect(result.date.getMonth()).toBe(2); // 0-indexed → March
    expect(result.date.getDate()).toBe(15);
  });

  it('should prefer date over dateTime when both are present', () => {
    const dt: GoogleEventDateTime = { date: '2024-01-01', dateTime: '2024-01-01T12:00:00Z' };
    const result = parseGoogleDateTime(dt);
    expect(result.allDay).toBe(true);
  });

  it('should fall back to current time when neither date nor dateTime is present', () => {
    const before = Date.now();
    const result = parseGoogleDateTime({});
    const after = Date.now();
    expect(result.allDay).toBe(false);
    expect(result.date.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.date.getTime()).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// extractTimezone
// ---------------------------------------------------------------------------

describe('extractTimezone', () => {
  it('should return the start timezone when present', () => {
    const event = makeEvent({ start: { dateTime: '2024-01-01T00:00:00Z', timeZone: 'Europe/London' } });
    expect(extractTimezone(event)).toBe('Europe/London');
  });

  it('should fall back to end timezone when start has no timeZone', () => {
    const event = makeEvent({
      start: { dateTime: '2024-01-01T00:00:00Z' },
      end: { dateTime: '2024-01-01T01:00:00Z', timeZone: 'Asia/Tokyo' },
    });
    expect(extractTimezone(event)).toBe('Asia/Tokyo');
  });

  it('should return UTC when neither start nor end has a timezone', () => {
    const event = makeEvent({
      start: { dateTime: '2024-01-01T00:00:00Z' },
      end: { dateTime: '2024-01-01T01:00:00Z' },
    });
    expect(extractTimezone(event)).toBe('UTC');
  });
});

// ---------------------------------------------------------------------------
// mapGoogleColor
// ---------------------------------------------------------------------------

describe('mapGoogleColor', () => {
  it('should return default for undefined colorId', () => {
    expect(mapGoogleColor(undefined)).toBe('default');
  });

  it('should map colorId 4 (Flamingo) to personal', () => {
    expect(mapGoogleColor('4')).toBe('personal');
  });

  it('should map colorId 6 (Tangerine) to meeting', () => {
    expect(mapGoogleColor('6')).toBe('meeting');
  });

  it('should map colorId 9 (Blueberry) to focus', () => {
    expect(mapGoogleColor('9')).toBe('focus');
  });

  it('should map colorId 11 (Tomato) to deadline', () => {
    expect(mapGoogleColor('11')).toBe('deadline');
  });

  it('should map colorId 1 (Lavender) to default', () => {
    expect(mapGoogleColor('1')).toBe('default');
  });

  it('should map colorId 8 (Graphite) to default', () => {
    expect(mapGoogleColor('8')).toBe('default');
  });

  it('should return default for an unknown colorId', () => {
    expect(mapGoogleColor('99')).toBe('default');
  });

  it('should return default for empty string colorId', () => {
    expect(mapGoogleColor('')).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// mapGoogleVisibility
// ---------------------------------------------------------------------------

describe('mapGoogleVisibility', () => {
  it('should return DRIVE for undefined visibility', () => {
    expect(mapGoogleVisibility(undefined)).toBe('DRIVE');
  });

  it('should return DRIVE for default visibility', () => {
    expect(mapGoogleVisibility('default')).toBe('DRIVE');
  });

  it('should return DRIVE for public visibility', () => {
    expect(mapGoogleVisibility('public')).toBe('DRIVE');
  });

  it('should return PRIVATE for private visibility', () => {
    expect(mapGoogleVisibility('private')).toBe('PRIVATE');
  });

  it('should return PRIVATE for confidential visibility', () => {
    expect(mapGoogleVisibility('confidential')).toBe('PRIVATE');
  });

  it('should return DRIVE for an unknown visibility string', () => {
    expect(mapGoogleVisibility('unknown')).toBe('DRIVE');
  });
});

// ---------------------------------------------------------------------------
// mapEventColor
// ---------------------------------------------------------------------------

describe('mapEventColor', () => {
  it('should return the mapped Google color when colorId is set', () => {
    expect(mapEventColor(makeEvent({ colorId: '9' }))).toBe('focus');
  });

  it('should return focus for focusTime events without a colorId', () => {
    expect(mapEventColor(makeEvent({ eventType: 'focusTime' }))).toBe('focus');
  });

  it('should return personal for outOfOffice events without a colorId', () => {
    expect(mapEventColor(makeEvent({ eventType: 'outOfOffice' }))).toBe('personal');
  });

  it('should return default for default event type without colorId', () => {
    expect(mapEventColor(makeEvent({ eventType: 'default' }))).toBe('default');
  });

  it('should prefer colorId over eventType semantics', () => {
    // colorId 11 = deadline, eventType = focusTime → colorId wins
    expect(mapEventColor(makeEvent({ colorId: '11', eventType: 'focusTime' }))).toBe('deadline');
  });
});

// ---------------------------------------------------------------------------
// extractConferenceLink
// ---------------------------------------------------------------------------

describe('extractConferenceLink', () => {
  it('should return null when no conference data or hangoutLink', () => {
    expect(extractConferenceLink(makeEvent())).toBeNull();
  });

  it('should return hangoutLink as fallback when no conferenceData', () => {
    const event = makeEvent({ hangoutLink: 'https://meet.google.com/abc-def-ghi' });
    expect(extractConferenceLink(event)).toBe('https://meet.google.com/abc-def-ghi');
  });

  it('should prefer video entry point from conferenceData over hangoutLink', () => {
    const event = makeEvent({
      hangoutLink: 'https://meet.google.com/old-link',
      conferenceData: {
        entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+1234567890' },
          { entryPointType: 'video', uri: 'https://meet.google.com/video-link' },
        ],
      },
    });
    expect(extractConferenceLink(event)).toBe('https://meet.google.com/video-link');
  });

  it('should fall back to any entry point URI when no video entry point exists', () => {
    const event = makeEvent({
      conferenceData: {
        entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+1234567890' },
        ],
      },
    });
    expect(extractConferenceLink(event)).toBe('tel:+1234567890');
  });

  it('should return null when conferenceData has empty entryPoints', () => {
    const event = makeEvent({
      conferenceData: { entryPoints: [] },
    });
    expect(extractConferenceLink(event)).toBeNull();
  });

  it('should return null when conferenceData entry points have no URIs', () => {
    const event = makeEvent({
      conferenceData: {
        entryPoints: [{ entryPointType: 'video' }],
      },
    });
    expect(extractConferenceLink(event)).toBeNull();
  });

  it('should return null when conferenceData has no entryPoints property', () => {
    const event = makeEvent({ conferenceData: {} });
    expect(extractConferenceLink(event)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sanitizeDescription
// ---------------------------------------------------------------------------

describe('sanitizeDescription', () => {
  it('should return null for undefined input', () => {
    expect(sanitizeDescription(undefined)).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(sanitizeDescription('')).toBeNull();
  });

  it('should strip HTML tags', () => {
    expect(sanitizeDescription('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });

  it('should decode &amp; entity', () => {
    expect(sanitizeDescription('Cats &amp; dogs')).toBe('Cats & dogs');
  });

  it('should decode &lt; and &gt; entities', () => {
    expect(sanitizeDescription('a &lt; b &gt; c')).toBe('a < b > c');
  });

  it('should decode &quot; entity', () => {
    expect(sanitizeDescription('She said &quot;hello&quot;')).toBe('She said "hello"');
  });

  it('should decode &#39; and &apos; entities', () => {
    expect(sanitizeDescription("it&#39;s &apos;fine&apos;")).toBe("it's 'fine'");
  });

  it('should decode &nbsp; as a space', () => {
    expect(sanitizeDescription('hello&nbsp;world')).toBe('hello world');
  });

  it('should normalize multiple spaces and trim', () => {
    expect(sanitizeDescription('  hello   world  ')).toBe('hello world');
  });

  it('should return null for whitespace-only input after sanitization', () => {
    expect(sanitizeDescription('   ')).toBeNull();
  });

  it('should handle mixed HTML and entities', () => {
    const input = '<div>Hello &amp; <em>welcome</em></div>';
    expect(sanitizeDescription(input)).toBe('Hello & welcome');
  });
});

// ---------------------------------------------------------------------------
// parseRecurrenceRule
// ---------------------------------------------------------------------------

describe('parseRecurrenceRule', () => {
  it('should return null for undefined recurrence', () => {
    expect(parseRecurrenceRule(undefined)).toBeNull();
  });

  it('should return null for empty array', () => {
    expect(parseRecurrenceRule([])).toBeNull();
  });

  it('should return null when no RRULE: line is present', () => {
    expect(parseRecurrenceRule(['EXDATE:20240101'])).toBeNull();
  });

  it('should return null for unsupported FREQ value', () => {
    expect(parseRecurrenceRule(['RRULE:FREQ=HOURLY'])).toBeNull();
  });

  it('should parse a simple DAILY recurrence', () => {
    const result = parseRecurrenceRule(['RRULE:FREQ=DAILY']);
    expect(result).toMatchObject({ frequency: 'DAILY', interval: 1 });
  });

  it('should parse WEEKLY recurrence with BYDAY', () => {
    const result = parseRecurrenceRule(['RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR']);
    expect(result).toMatchObject({
      frequency: 'WEEKLY',
      interval: 1,
      byDay: ['MO', 'WE', 'FR'],
    });
  });

  it('should parse MONTHLY recurrence with BYMONTHDAY', () => {
    const result = parseRecurrenceRule(['RRULE:FREQ=MONTHLY;BYMONTHDAY=15']);
    expect(result).toMatchObject({
      frequency: 'MONTHLY',
      interval: 1,
      byMonthDay: [15],
    });
  });

  it('should parse YEARLY recurrence with BYMONTH', () => {
    const result = parseRecurrenceRule(['RRULE:FREQ=YEARLY;BYMONTH=3']);
    expect(result).toMatchObject({
      frequency: 'YEARLY',
      interval: 1,
      byMonth: [3],
    });
  });

  it('should parse INTERVAL', () => {
    const result = parseRecurrenceRule(['RRULE:FREQ=WEEKLY;INTERVAL=2']);
    expect(result).toMatchObject({ frequency: 'WEEKLY', interval: 2 });
  });

  it('should parse COUNT', () => {
    const result = parseRecurrenceRule(['RRULE:FREQ=DAILY;COUNT=10']);
    expect(result).toMatchObject({ frequency: 'DAILY', count: 10 });
  });

  it('should parse UNTIL as date-only string (8 chars)', () => {
    const result = parseRecurrenceRule(['RRULE:FREQ=DAILY;UNTIL=20240315']);
    expect(result?.until).toBe('2024-03-15');
  });

  it('should parse UNTIL as full datetime string', () => {
    const result = parseRecurrenceRule(['RRULE:FREQ=DAILY;UNTIL=20240315T000000Z']);
    expect(result?.until).toBeDefined();
    // Should be an ISO string
    expect(typeof result?.until).toBe('string');
    expect(result?.until).toContain('2024-03-15');
  });

  it('should find the RRULE line among multiple recurrence strings', () => {
    const result = parseRecurrenceRule([
      'EXDATE;TZID=America/New_York:20240101T120000',
      'RRULE:FREQ=WEEKLY;BYDAY=TU',
    ]);
    expect(result).toMatchObject({ frequency: 'WEEKLY', byDay: ['TU'] });
  });

  it('should filter out invalid BYDAY values', () => {
    const result = parseRecurrenceRule(['RRULE:FREQ=WEEKLY;BYDAY=MO,XX,FR']);
    expect(result?.byDay).toEqual(['MO', 'FR']);
  });
});

// ---------------------------------------------------------------------------
// shouldSyncEvent
// ---------------------------------------------------------------------------

describe('shouldSyncEvent', () => {
  it('should sync confirmed events', () => {
    expect(shouldSyncEvent(makeEvent({ status: 'confirmed' }))).toBe(true);
  });

  it('should sync cancelled events (to mark as trashed)', () => {
    expect(shouldSyncEvent(makeEvent({ status: 'cancelled' }))).toBe(true);
  });

  it('should skip workingLocation events', () => {
    expect(shouldSyncEvent(makeEvent({ eventType: 'workingLocation' }))).toBe(false);
  });

  it('should sync focusTime events', () => {
    expect(shouldSyncEvent(makeEvent({ eventType: 'focusTime' }))).toBe(true);
  });

  it('should sync outOfOffice events', () => {
    expect(shouldSyncEvent(makeEvent({ eventType: 'outOfOffice' }))).toBe(true);
  });

  it('should skip events without a start time', () => {
    // Cast to test the guard branch
    const event = { ...makeEvent() } as Partial<GoogleCalendarEvent>;
    delete event.start;
    expect(shouldSyncEvent(event as GoogleCalendarEvent)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// needsUpdate
// ---------------------------------------------------------------------------

describe('needsUpdate', () => {
  const basePageEvent = {
    lastGoogleSync: new Date('2024-03-01T00:00:00Z'),
    title: 'Test',
    startAt: new Date('2024-03-15T10:00:00Z'),
    endAt: new Date('2024-03-15T11:00:00Z'),
  };

  it('should return true when lastGoogleSync is null', () => {
    expect(needsUpdate({ ...basePageEvent, lastGoogleSync: null }, makeEvent())).toBe(true);
  });

  it('should return true when Google event was updated after last sync', () => {
    const googleEvent = makeEvent({ updated: '2024-03-15T12:00:00Z' });
    expect(needsUpdate(basePageEvent, googleEvent)).toBe(true);
  });

  it('should return false when Google event updated before last sync', () => {
    const googleEvent = makeEvent({ updated: '2024-02-01T00:00:00Z' });
    expect(needsUpdate(basePageEvent, googleEvent)).toBe(false);
  });

  it('should return false when no updated timestamp on Google event', () => {
    const googleEvent = makeEvent();
    // No `updated` field set
    expect(needsUpdate(basePageEvent, googleEvent)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// transformGoogleEventToPageSpace
// ---------------------------------------------------------------------------

describe('transformGoogleEventToPageSpace', () => {
  const context = {
    userId: 'user-1',
    driveId: 'drive-1',
    googleCalendarId: 'calendar@example.com',
  };

  it('should transform a basic confirmed event', () => {
    const result = transformGoogleEventToPageSpace(makeEvent(), context);

    expect(result.id).toBe('test-cuid-id');
    expect(result.title).toBe('Test Event');
    expect(result.driveId).toBe('drive-1');
    expect(result.createdById).toBe('user-1');
    expect(result.googleCalendarId).toBe('calendar@example.com');
    expect(result.googleEventId).toBe('google-event-1');
    expect(result.syncedFromGoogle).toBe(true);
    expect(result.allDay).toBe(false);
    expect(result.isTrashed).toBe(false);
    expect(result.trashedAt).toBeNull();
  });

  it('should use "(No title)" when summary is missing', () => {
    const result = transformGoogleEventToPageSpace(
      makeEvent({ summary: undefined }),
      context
    );
    expect(result.title).toBe('(No title)');
  });

  it('should mark cancelled events as trashed', () => {
    const result = transformGoogleEventToPageSpace(
      makeEvent({ status: 'cancelled' }),
      context
    );
    expect(result.isTrashed).toBe(true);
    expect(result.trashedAt).toBeInstanceOf(Date);
  });

  it('should parse all-day events correctly', () => {
    const event = makeEvent({
      start: { date: '2024-06-01' },
      end: { date: '2024-06-02' },
    });
    const result = transformGoogleEventToPageSpace(event, context);
    expect(result.allDay).toBe(true);
  });

  it('should include conference link in metadata', () => {
    const event = makeEvent({
      hangoutLink: 'https://meet.google.com/abc',
    });
    const result = transformGoogleEventToPageSpace(event, context);
    expect((result.metadata as Record<string, unknown>)?.conferenceLink).toBe(
      'https://meet.google.com/abc'
    );
  });

  it('should map visibility correctly', () => {
    const result = transformGoogleEventToPageSpace(
      makeEvent({ visibility: 'private' }),
      context
    );
    expect(result.visibility).toBe('PRIVATE');
  });

  it('should set recurringEventId when present', () => {
    const result = transformGoogleEventToPageSpace(
      makeEvent({ recurringEventId: 'parent-event-id' }),
      context
    );
    expect(result.recurringEventId).toBe('parent-event-id');
  });

  it('should set originalStartAt from originalStartTime', () => {
    const result = transformGoogleEventToPageSpace(
      makeEvent({ originalStartTime: { dateTime: '2024-03-15T09:00:00Z' } }),
      context
    );
    expect(result.originalStartAt).toBeInstanceOf(Date);
  });

  it('should null originalStartAt when originalStartTime is absent', () => {
    const result = transformGoogleEventToPageSpace(makeEvent(), context);
    expect(result.originalStartAt).toBeNull();
  });

  it('should handle null driveId in context', () => {
    const result = transformGoogleEventToPageSpace(makeEvent(), {
      ...context,
      driveId: null,
    });
    expect(result.driveId).toBeNull();
  });

  it('should populate googleAttendees in metadata', () => {
    const event = makeEvent({
      attendees: [
        { email: 'alice@example.com', displayName: 'Alice', responseStatus: 'accepted' },
      ],
    });
    const result = transformGoogleEventToPageSpace(event, context);
    const meta = result.metadata as Record<string, unknown>;
    expect(Array.isArray(meta.googleAttendees)).toBe(true);
    expect((meta.googleAttendees as Array<{ email: string }>)[0].email).toBe('alice@example.com');
  });
});
