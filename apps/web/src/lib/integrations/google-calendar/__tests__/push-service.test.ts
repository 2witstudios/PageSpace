/**
 * Tests for push-service.ts
 * Pure functions: buildGoogleRRule, transformPageSpaceEventToGoogle
 * IO functions: getActiveConnection, pushEventToGoogle, pushEventUpdateToGoogle, pushEventDeleteToGoogle
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CalendarEvent } from '@pagespace/db';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbFindFirst = vi.hoisted(() => vi.fn());
const mockDbUpdateSet = vi.hoisted(() => vi.fn());
const mockDbUpdateWhere = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      googleCalendarConnections: { findFirst: mockDbFindFirst },
      calendarEvents: { findFirst: vi.fn() },
    },
    update: vi.fn(() => ({ set: mockDbUpdateSet })),
  },
  googleCalendarConnections: {
    userId: 'userId',
    status: 'status',
    selectedCalendars: 'selectedCalendars',
    googleEmail: 'googleEmail',
  },
  calendarEvents: {
    id: 'id',
    googleEventId: 'googleEventId',
    googleCalendarId: 'googleCalendarId',
    lastGoogleSync: 'lastGoogleSync',
    updatedAt: 'updatedAt',
  },
  eq: vi.fn((a, b) => ({ type: 'eq', a, b })),
  and: vi.fn((...args) => ({ type: 'and', args })),
}));

const mockApiLogger = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: { api: mockApiLogger },
}));

const mockGetValidAccessToken = vi.hoisted(() => vi.fn());
vi.mock('../token-refresh', () => ({
  getValidAccessToken: mockGetValidAccessToken,
}));

const mockCreateGoogleEvent = vi.hoisted(() => vi.fn());
const mockUpdateGoogleEvent = vi.hoisted(() => vi.fn());
const mockDeleteGoogleEvent = vi.hoisted(() => vi.fn());

vi.mock('../api-client', () => ({
  createGoogleEvent: mockCreateGoogleEvent,
  updateGoogleEvent: mockUpdateGoogleEvent,
  deleteGoogleEvent: mockDeleteGoogleEvent,
}));

import {
  buildGoogleRRule,
  transformPageSpaceEventToGoogle,
  getActiveConnection,
  pushEventToGoogle,
  pushEventUpdateToGoogle,
  pushEventDeleteToGoogle,
} from '../push-service';
import { db } from '@pagespace/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCalendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'event-1',
    title: 'Test Event',
    description: null,
    location: null,
    startAt: new Date('2024-06-01T10:00:00Z'),
    endAt: new Date('2024-06-01T11:00:00Z'),
    allDay: false,
    timezone: 'America/New_York',
    visibility: 'DRIVE',
    color: 'default',
    recurrenceRule: null,
    recurrenceExceptions: [],
    recurringEventId: null,
    originalStartAt: null,
    driveId: 'drive-1',
    createdById: 'user-1',
    pageId: null,
    metadata: null,
    isTrashed: false,
    trashedAt: null,
    googleEventId: null,
    googleCalendarId: null,
    syncedFromGoogle: false,
    lastGoogleSync: null,
    googleSyncReadOnly: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as CalendarEvent;
}

// ---------------------------------------------------------------------------
// buildGoogleRRule
// ---------------------------------------------------------------------------

describe('buildGoogleRRule', () => {
  it('should return undefined for null rule', () => {
    expect(buildGoogleRRule(null)).toBeUndefined();
  });

  it('should build a simple DAILY rule', () => {
    const result = buildGoogleRRule({ frequency: 'DAILY', interval: 1 });
    expect(result).toEqual(['RRULE:FREQ=DAILY']);
  });

  it('should include INTERVAL when greater than 1', () => {
    const result = buildGoogleRRule({ frequency: 'WEEKLY', interval: 2 });
    expect(result).toEqual(['RRULE:FREQ=WEEKLY;INTERVAL=2']);
  });

  it('should NOT include INTERVAL when it equals 1', () => {
    const result = buildGoogleRRule({ frequency: 'DAILY', interval: 1 });
    expect(result![0]).not.toContain('INTERVAL');
  });

  it('should include BYDAY for weekly rules', () => {
    const result = buildGoogleRRule({
      frequency: 'WEEKLY',
      interval: 1,
      byDay: ['MO', 'WE', 'FR'],
    });
    expect(result![0]).toContain('BYDAY=MO,WE,FR');
  });

  it('should include BYMONTHDAY for monthly rules', () => {
    const result = buildGoogleRRule({
      frequency: 'MONTHLY',
      interval: 1,
      byMonthDay: [15],
    });
    expect(result![0]).toContain('BYMONTHDAY=15');
  });

  it('should include BYMONTH for yearly rules', () => {
    const result = buildGoogleRRule({
      frequency: 'YEARLY',
      interval: 1,
      byMonth: [3],
    });
    expect(result![0]).toContain('BYMONTH=3');
  });

  it('should include COUNT when set', () => {
    const result = buildGoogleRRule({ frequency: 'DAILY', interval: 1, count: 5 });
    expect(result![0]).toContain('COUNT=5');
  });

  it('should include UNTIL when set', () => {
    const result = buildGoogleRRule({
      frequency: 'DAILY',
      interval: 1,
      until: '2024-12-31T00:00:00.000Z',
    });
    expect(result![0]).toContain('UNTIL=');
  });

  it('should not include BYDAY for empty array', () => {
    const result = buildGoogleRRule({ frequency: 'WEEKLY', interval: 1, byDay: [] });
    expect(result![0]).not.toContain('BYDAY');
  });

  it('should return an array with one RRULE string', () => {
    const result = buildGoogleRRule({ frequency: 'DAILY', interval: 1 });
    expect(Array.isArray(result)).toBe(true);
    expect(result!.length).toBe(1);
    expect(result![0]).toMatch(/^RRULE:/);
  });
});

// ---------------------------------------------------------------------------
// transformPageSpaceEventToGoogle
// ---------------------------------------------------------------------------

describe('transformPageSpaceEventToGoogle', () => {
  it('should set summary from event title', () => {
    const body = transformPageSpaceEventToGoogle(makeCalendarEvent({ title: 'My Meeting' }));
    expect(body.summary).toBe('My Meeting');
  });

  it('should set description when present', () => {
    const body = transformPageSpaceEventToGoogle(makeCalendarEvent({ description: 'Notes here' }));
    expect(body.description).toBe('Notes here');
  });

  it('should set description to undefined when null', () => {
    const body = transformPageSpaceEventToGoogle(makeCalendarEvent({ description: null }));
    expect(body.description).toBeUndefined();
  });

  it('should set location when present', () => {
    const body = transformPageSpaceEventToGoogle(makeCalendarEvent({ location: 'Conference Room A' }));
    expect(body.location).toBe('Conference Room A');
  });

  it('should set start/end as dateTime for non-all-day events', () => {
    const body = transformPageSpaceEventToGoogle(makeCalendarEvent({ allDay: false }));
    expect(body.start.dateTime).toBeDefined();
    expect(body.end.dateTime).toBeDefined();
    expect(body.start.date).toBeUndefined();
  });

  it('should set start/end as date strings for all-day events', () => {
    const body = transformPageSpaceEventToGoogle(makeCalendarEvent({ allDay: true }));
    expect(body.start.date).toBeDefined();
    expect(body.end.date).toBeDefined();
    expect(body.start.dateTime).toBeUndefined();
  });

  it('should include timezone in dateTime events', () => {
    const body = transformPageSpaceEventToGoogle(
      makeCalendarEvent({ allDay: false, timezone: 'Europe/Paris' })
    );
    expect(body.start.timeZone).toBe('Europe/Paris');
    expect(body.end.timeZone).toBe('Europe/Paris');
  });

  it('should map DRIVE visibility to default', () => {
    const body = transformPageSpaceEventToGoogle(makeCalendarEvent({ visibility: 'DRIVE' }));
    expect(body.visibility).toBe('default');
  });

  it('should map PRIVATE visibility to private', () => {
    const body = transformPageSpaceEventToGoogle(makeCalendarEvent({ visibility: 'PRIVATE' }));
    expect(body.visibility).toBe('private');
  });

  it('should set colorId for known PageSpace colors', () => {
    const body = transformPageSpaceEventToGoogle(makeCalendarEvent({ color: 'focus' }));
    expect(body.colorId).toBe('9');
  });

  it('should not set colorId for default color', () => {
    const body = transformPageSpaceEventToGoogle(makeCalendarEvent({ color: 'default' }));
    expect(body.colorId).toBeUndefined();
  });

  it('should include recurrence rules when present', () => {
    const body = transformPageSpaceEventToGoogle(
      makeCalendarEvent({ recurrenceRule: { frequency: 'WEEKLY', interval: 1, byDay: ['MO'] } })
    );
    expect(body.recurrence).toBeDefined();
    expect(body.recurrence![0]).toContain('RRULE:FREQ=WEEKLY');
  });

  it('should map meeting color to colorId 6', () => {
    const body = transformPageSpaceEventToGoogle(makeCalendarEvent({ color: 'meeting' }));
    expect(body.colorId).toBe('6');
  });

  it('should map deadline color to colorId 11', () => {
    const body = transformPageSpaceEventToGoogle(makeCalendarEvent({ color: 'deadline' }));
    expect(body.colorId).toBe('11');
  });
});

// ---------------------------------------------------------------------------
// getActiveConnection
// ---------------------------------------------------------------------------

describe('getActiveConnection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should return null when no active connection found', async () => {
    mockDbFindFirst.mockResolvedValue(null);
    const result = await getActiveConnection('user-1');
    expect(result).toBeNull();
  });

  it('should return connection info when connection exists', async () => {
    mockDbFindFirst.mockResolvedValue({
      selectedCalendars: ['primary'],
      googleEmail: 'user@gmail.com',
    });
    const result = await getActiveConnection('user-1');
    expect(result).not.toBeNull();
    expect(result?.connected).toBe(true);
    expect(result?.pushEnabled).toBe(true);
  });

  it('should use googleEmail as targetCalendarId when first calendar is primary', async () => {
    mockDbFindFirst.mockResolvedValue({
      selectedCalendars: ['primary'],
      googleEmail: 'user@gmail.com',
    });
    const result = await getActiveConnection('user-1');
    expect(result?.targetCalendarId).toBe('user@gmail.com');
  });

  it('should use first calendar ID when it is not primary', async () => {
    mockDbFindFirst.mockResolvedValue({
      selectedCalendars: ['work@example.com'],
      googleEmail: 'user@gmail.com',
    });
    const result = await getActiveConnection('user-1');
    expect(result?.targetCalendarId).toBe('work@example.com');
  });

  it('should fall back to "primary" string when no selectedCalendars and no googleEmail', async () => {
    mockDbFindFirst.mockResolvedValue({
      selectedCalendars: null,
      googleEmail: null,
    });
    const result = await getActiveConnection('user-1');
    expect(result?.targetCalendarId).toBe('primary');
  });
});

// ---------------------------------------------------------------------------
// pushEventToGoogle
// ---------------------------------------------------------------------------

describe('pushEventToGoogle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbUpdateSet.mockReturnValue({ where: mockDbUpdateWhere });
    // Wire up calendarEvents.findFirst on the db.query mock
    vi.mocked(db.query.calendarEvents.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

  it('should return success when no active connection exists', async () => {
    mockDbFindFirst.mockResolvedValue(null);
    const result = await pushEventToGoogle('user-1', 'event-1');
    expect(result.success).toBe(true);
  });

  it('should return error when event not found in db', async () => {
    mockDbFindFirst.mockResolvedValue({
      selectedCalendars: ['primary'],
      googleEmail: 'user@gmail.com',
    });
    vi.mocked(db.query.calendarEvents.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const result = await pushEventToGoogle('user-1', 'event-1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Event not found');
  });

  it('should skip push and return success for events synced from Google', async () => {
    mockDbFindFirst.mockResolvedValue({
      selectedCalendars: ['primary'],
      googleEmail: 'user@gmail.com',
    });
    vi.mocked(db.query.calendarEvents.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCalendarEvent({ syncedFromGoogle: true })
    );
    const result = await pushEventToGoogle('user-1', 'event-1');
    expect(result.success).toBe(true);
    expect(mockCreateGoogleEvent).not.toHaveBeenCalled();
  });

  it('should return error when token refresh fails', async () => {
    mockDbFindFirst.mockResolvedValue({
      selectedCalendars: ['primary'],
      googleEmail: 'user@gmail.com',
    });
    vi.mocked(db.query.calendarEvents.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCalendarEvent({ syncedFromGoogle: false })
    );
    mockGetValidAccessToken.mockResolvedValue({ success: false, error: 'auth failed', requiresReauth: true });

    const result = await pushEventToGoogle('user-1', 'event-1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('auth failed');
  });

  it('should create Google event and update local record on success', async () => {
    mockDbFindFirst.mockResolvedValue({
      selectedCalendars: ['primary'],
      googleEmail: 'user@gmail.com',
    });
    const event = makeCalendarEvent({ syncedFromGoogle: false });
    vi.mocked(db.query.calendarEvents.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(event);
    mockGetValidAccessToken.mockResolvedValue({ success: true, accessToken: 'valid-token' });
    mockCreateGoogleEvent.mockResolvedValue({
      success: true,
      data: { id: 'google-created-id', status: 'confirmed', start: {}, end: {} },
    });

    const result = await pushEventToGoogle('user-1', 'event-1');
    expect(result.success).toBe(true);
    expect(result.googleEventId).toBe('google-created-id');
    expect(db.update).toHaveBeenCalled();
  });

  it('should return error when Google create fails', async () => {
    mockDbFindFirst.mockResolvedValue({
      selectedCalendars: ['primary'],
      googleEmail: 'user@gmail.com',
    });
    vi.mocked(db.query.calendarEvents.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCalendarEvent({ syncedFromGoogle: false })
    );
    mockGetValidAccessToken.mockResolvedValue({ success: true, accessToken: 'valid-token' });
    mockCreateGoogleEvent.mockResolvedValue({ success: false, error: 'quota exceeded' });

    const result = await pushEventToGoogle('user-1', 'event-1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('quota exceeded');
  });
});

// ---------------------------------------------------------------------------
// pushEventUpdateToGoogle
// ---------------------------------------------------------------------------

describe('pushEventUpdateToGoogle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbUpdateSet.mockReturnValue({ where: mockDbUpdateWhere });
    vi.mocked(db.query.calendarEvents.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

  it('should return success when no connection', async () => {
    mockDbFindFirst.mockResolvedValue(null);
    const result = await pushEventUpdateToGoogle('user-1', 'event-1');
    expect(result.success).toBe(true);
  });

  it('should return success when event has no googleEventId', async () => {
    mockDbFindFirst.mockResolvedValue({
      selectedCalendars: ['primary'],
      googleEmail: 'user@gmail.com',
    });
    vi.mocked(db.query.calendarEvents.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCalendarEvent({ googleEventId: null })
    );
    const result = await pushEventUpdateToGoogle('user-1', 'event-1');
    expect(result.success).toBe(true);
  });

  it('should update Google event and return success', async () => {
    mockDbFindFirst.mockResolvedValue({
      selectedCalendars: ['primary'],
      googleEmail: 'user@gmail.com',
    });
    vi.mocked(db.query.calendarEvents.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCalendarEvent({ googleEventId: 'goog-evt-1', googleCalendarId: 'cal@example.com' })
    );
    mockGetValidAccessToken.mockResolvedValue({ success: true, accessToken: 'valid-token' });
    mockUpdateGoogleEvent.mockResolvedValue({
      success: true,
      data: { id: 'goog-evt-1', status: 'confirmed', start: {}, end: {} },
    });

    const result = await pushEventUpdateToGoogle('user-1', 'event-1');
    expect(result.success).toBe(true);
    expect(result.googleEventId).toBe('goog-evt-1');
  });

  it('should return error when Google update fails', async () => {
    mockDbFindFirst.mockResolvedValue({
      selectedCalendars: ['primary'],
      googleEmail: 'user@gmail.com',
    });
    vi.mocked(db.query.calendarEvents.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCalendarEvent({ googleEventId: 'goog-evt-1', googleCalendarId: 'cal@example.com' })
    );
    mockGetValidAccessToken.mockResolvedValue({ success: true, accessToken: 'valid-token' });
    mockUpdateGoogleEvent.mockResolvedValue({ success: false, error: 'update failed' });

    const result = await pushEventUpdateToGoogle('user-1', 'event-1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('update failed');
  });
});

// ---------------------------------------------------------------------------
// pushEventDeleteToGoogle
// ---------------------------------------------------------------------------

describe('pushEventDeleteToGoogle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.query.calendarEvents.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

  it('should return success when no connection', async () => {
    mockDbFindFirst.mockResolvedValue(null);
    const result = await pushEventDeleteToGoogle('user-1', 'event-1');
    expect(result.success).toBe(true);
  });

  it('should return success when event has no Google IDs', async () => {
    mockDbFindFirst.mockResolvedValue({
      selectedCalendars: ['primary'],
      googleEmail: 'user@gmail.com',
    });
    vi.mocked(db.query.calendarEvents.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCalendarEvent({ googleEventId: null, googleCalendarId: null })
    );
    const result = await pushEventDeleteToGoogle('user-1', 'event-1');
    expect(result.success).toBe(true);
  });

  it('should delete Google event and return success', async () => {
    mockDbFindFirst.mockResolvedValue({
      selectedCalendars: ['primary'],
      googleEmail: 'user@gmail.com',
    });
    vi.mocked(db.query.calendarEvents.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCalendarEvent({ googleEventId: 'goog-evt-1', googleCalendarId: 'cal@example.com' })
    );
    mockGetValidAccessToken.mockResolvedValue({ success: true, accessToken: 'valid-token' });
    mockDeleteGoogleEvent.mockResolvedValue({ success: true, data: undefined });

    const result = await pushEventDeleteToGoogle('user-1', 'event-1');
    expect(result.success).toBe(true);
    expect(result.googleEventId).toBe('goog-evt-1');
  });

  it('should return error when Google delete fails', async () => {
    mockDbFindFirst.mockResolvedValue({
      selectedCalendars: ['primary'],
      googleEmail: 'user@gmail.com',
    });
    vi.mocked(db.query.calendarEvents.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCalendarEvent({ googleEventId: 'goog-evt-1', googleCalendarId: 'cal@example.com' })
    );
    mockGetValidAccessToken.mockResolvedValue({ success: true, accessToken: 'valid-token' });
    mockDeleteGoogleEvent.mockResolvedValue({ success: false, error: 'delete failed' });

    const result = await pushEventDeleteToGoogle('user-1', 'event-1');
    expect(result.success).toBe(false);
    expect(result.error).toBe('delete failed');
  });
});
