/**
 * Tests for api-client.ts
 * Pure functions: buildAuthHeader, buildEventsListUrl
 * IO functions: listEvents, listCalendars, watchCalendar, stopChannel, createGoogleEvent, updateGoogleEvent, deleteGoogleEvent
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockApiLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: mockApiLogger,
  },
}));

// Global fetch mock
const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', mockFetch);

import {
  buildAuthHeader,
  buildEventsListUrl,
  listEvents,
  listCalendars,
  watchCalendar,
  stopChannel,
  createGoogleEvent,
  updateGoogleEvent,
  deleteGoogleEvent,
} from '../api-client';

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(JSON.stringify(data)),
  } as unknown as Response;
}

function makeErrorResponse(status: number, body = 'error'): Response {
  return {
    ok: false,
    status,
    json: vi.fn().mockResolvedValue({ error: body }),
    text: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

const ACCESS_TOKEN = 'test-access-token';

// ---------------------------------------------------------------------------
// buildAuthHeader
// ---------------------------------------------------------------------------

describe('buildAuthHeader', () => {
  it('should return Authorization header with Bearer token', () => {
    const headers = buildAuthHeader(ACCESS_TOKEN);
    expect(headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it('should include Content-Type application/json', () => {
    const headers = buildAuthHeader(ACCESS_TOKEN);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('should return a plain object', () => {
    const headers = buildAuthHeader('tok');
    expect(typeof headers).toBe('object');
    expect(Object.keys(headers)).toEqual(['Authorization', 'Content-Type']);
  });
});

// ---------------------------------------------------------------------------
// buildEventsListUrl
// ---------------------------------------------------------------------------

describe('buildEventsListUrl', () => {
  it('should build URL for a plain calendarId with no options', () => {
    const url = buildEventsListUrl('primary');
    expect(url).toBe(`${CALENDAR_API_BASE}/calendars/primary/events`);
  });

  it('should percent-encode special characters in calendarId', () => {
    const url = buildEventsListUrl('user@example.com');
    expect(url).toContain('user%40example.com');
  });

  it('should append timeMin when provided', () => {
    const date = new Date('2024-01-01T00:00:00Z');
    const url = buildEventsListUrl('primary', { timeMin: date });
    expect(url).toContain('timeMin=2024-01-01T00%3A00%3A00.000Z');
  });

  it('should append timeMax when provided', () => {
    const date = new Date('2024-12-31T23:59:59Z');
    const url = buildEventsListUrl('primary', { timeMax: date });
    expect(url).toContain('timeMax=');
  });

  it('should append maxResults when provided', () => {
    const url = buildEventsListUrl('primary', { maxResults: 50 });
    expect(url).toContain('maxResults=50');
  });

  it('should append pageToken when provided', () => {
    const url = buildEventsListUrl('primary', { pageToken: 'abc123' });
    expect(url).toContain('pageToken=abc123');
  });

  it('should append syncToken when provided', () => {
    const url = buildEventsListUrl('primary', { syncToken: 'sync-tok' });
    expect(url).toContain('syncToken=sync-tok');
  });

  it('should append singleEvents=true when set', () => {
    const url = buildEventsListUrl('primary', { singleEvents: true });
    expect(url).toContain('singleEvents=true');
  });

  it('should append singleEvents=false when set', () => {
    const url = buildEventsListUrl('primary', { singleEvents: false });
    expect(url).toContain('singleEvents=false');
  });

  it('should NOT append singleEvents when undefined', () => {
    const url = buildEventsListUrl('primary');
    expect(url).not.toContain('singleEvents');
  });

  it('should append orderBy when provided', () => {
    const url = buildEventsListUrl('primary', { orderBy: 'startTime' });
    expect(url).toContain('orderBy=startTime');
  });

  it('should build a URL with multiple options', () => {
    const url = buildEventsListUrl('cal@example.com', {
      maxResults: 100,
      singleEvents: true,
      orderBy: 'startTime',
    });
    expect(url).toContain('maxResults=100');
    expect(url).toContain('singleEvents=true');
    expect(url).toContain('orderBy=startTime');
  });
});

// ---------------------------------------------------------------------------
// listEvents
// ---------------------------------------------------------------------------

describe('listEvents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should return events on a single-page successful response', async () => {
    mockFetch.mockResolvedValue(
      makeOkResponse({
        kind: 'calendar#events',
        items: [{ id: 'evt-1', status: 'confirmed', start: {}, end: {} }],
        nextSyncToken: 'sync-token-1',
      })
    );

    const result = await listEvents(ACCESS_TOKEN, 'primary');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.events).toHaveLength(1);
      expect(result.data.nextSyncToken).toBe('sync-token-1');
    }
  });

  it('should accumulate events across multiple pages', async () => {
    mockFetch
      .mockResolvedValueOnce(
        makeOkResponse({
          items: [{ id: 'evt-1', status: 'confirmed', start: {}, end: {} }],
          nextPageToken: 'page2',
        })
      )
      .mockResolvedValueOnce(
        makeOkResponse({
          items: [{ id: 'evt-2', status: 'confirmed', start: {}, end: {} }],
          nextSyncToken: 'sync-final',
        })
      );

    const result = await listEvents(ACCESS_TOKEN, 'primary');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.events).toHaveLength(2);
    }
  });

  it('should return error result for 401 response', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(401));
    const result = await listEvents(ACCESS_TOKEN, 'primary');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(401);
      expect(result.requiresReauth).toBe(true);
    }
  });

  it('should return sync-token-expired error for 410 response', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(410));
    const result = await listEvents(ACCESS_TOKEN, 'primary', { syncToken: 'old' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(410);
    }
  });

  it('should return error result when fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    const result = await listEvents(ACCESS_TOKEN, 'primary');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('network error');
    }
  });
});

// ---------------------------------------------------------------------------
// listCalendars
// ---------------------------------------------------------------------------

describe('listCalendars', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should return calendar list on success', async () => {
    mockFetch.mockResolvedValue(
      makeOkResponse({
        kind: 'calendar#calendarList',
        etag: 'etag',
        items: [{ id: 'primary', summary: 'Primary', accessRole: 'owner' }],
      })
    );

    const result = await listCalendars(ACCESS_TOKEN);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('primary');
    }
  });

  it('should return error for 403 response', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(403));
    const result = await listCalendars(ACCESS_TOKEN);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.requiresReauth).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// watchCalendar
// ---------------------------------------------------------------------------

describe('watchCalendar', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should return watch response on success', async () => {
    const watchData = {
      kind: 'api#channel',
      id: 'channel-1',
      resourceId: 'resource-1',
      resourceUri: 'https://example.com',
      expiration: String(Date.now() + 7 * 24 * 3600 * 1000),
    };
    mockFetch.mockResolvedValue(makeOkResponse(watchData));

    const result = await watchCalendar(ACCESS_TOKEN, 'primary', 'https://webhook.example.com', 'channel-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('channel-1');
    }
  });

  it('should return error for non-ok watch response', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(400));
    const result = await watchCalendar(ACCESS_TOKEN, 'primary', 'https://hook.com', 'ch-1');
    expect(result.success).toBe(false);
  });

  it('should set requiresReauth for 401 watch response', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(401));
    const result = await watchCalendar(ACCESS_TOKEN, 'primary', 'https://hook.com', 'ch-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.requiresReauth).toBe(true);
    }
  });

  it('should return error when fetch throws during watch', async () => {
    mockFetch.mockRejectedValue(new Error('connection refused'));
    const result = await watchCalendar(ACCESS_TOKEN, 'primary', 'https://hook.com', 'ch-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('connection refused');
    }
  });
});

// ---------------------------------------------------------------------------
// stopChannel
// ---------------------------------------------------------------------------

describe('stopChannel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should return success for 200 response', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: vi.fn().mockResolvedValue('') } as unknown as Response);
    const result = await stopChannel(ACCESS_TOKEN, 'ch-1', 'res-1');
    expect(result.success).toBe(true);
  });

  it('should treat 404 as success (already stopped)', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(404));
    const result = await stopChannel(ACCESS_TOKEN, 'ch-1', 'res-1');
    expect(result.success).toBe(true);
  });

  it('should return error for 500 response', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(500));
    const result = await stopChannel(ACCESS_TOKEN, 'ch-1', 'res-1');
    expect(result.success).toBe(false);
  });

  it('should return error when fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('timeout'));
    const result = await stopChannel(ACCESS_TOKEN, 'ch-1', 'res-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('timeout');
    }
  });
});

// ---------------------------------------------------------------------------
// createGoogleEvent
// ---------------------------------------------------------------------------

describe('createGoogleEvent', () => {
  beforeEach(() => vi.clearAllMocks());

  const eventBody = {
    summary: 'New Event',
    start: { dateTime: '2024-06-01T10:00:00Z' },
    end: { dateTime: '2024-06-01T11:00:00Z' },
  };

  it('should return the created event on success', async () => {
    const created = { id: 'new-google-id', status: 'confirmed', summary: 'New Event', start: {}, end: {} };
    mockFetch.mockResolvedValue(makeOkResponse(created));

    const result = await createGoogleEvent(ACCESS_TOKEN, 'primary', eventBody);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('new-google-id');
    }
  });

  it('should return error with requiresReauth for 401', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(401));
    const result = await createGoogleEvent(ACCESS_TOKEN, 'primary', eventBody);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.requiresReauth).toBe(true);
    }
  });

  it('should return error when fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const result = await createGoogleEvent(ACCESS_TOKEN, 'primary', eventBody);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('offline');
    }
  });
});

// ---------------------------------------------------------------------------
// updateGoogleEvent
// ---------------------------------------------------------------------------

describe('updateGoogleEvent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should return updated event on success', async () => {
    const updated = { id: 'evt-1', status: 'confirmed', summary: 'Updated', start: {}, end: {} };
    mockFetch.mockResolvedValue(makeOkResponse(updated));

    const result = await updateGoogleEvent(ACCESS_TOKEN, 'primary', 'evt-1', { summary: 'Updated' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.summary).toBe('Updated');
    }
  });

  it('should return error with requiresReauth for 403', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(403));
    const result = await updateGoogleEvent(ACCESS_TOKEN, 'primary', 'evt-1', {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.requiresReauth).toBe(true);
    }
  });

  it('should return error when fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('timeout'));
    const result = await updateGoogleEvent(ACCESS_TOKEN, 'primary', 'evt-1', {});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deleteGoogleEvent
// ---------------------------------------------------------------------------

describe('deleteGoogleEvent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should return success on 204', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 204, text: vi.fn().mockResolvedValue('') } as unknown as Response);
    const result = await deleteGoogleEvent(ACCESS_TOKEN, 'primary', 'evt-1');
    expect(result.success).toBe(true);
  });

  it('should treat 404 as success (already deleted)', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(404));
    const result = await deleteGoogleEvent(ACCESS_TOKEN, 'primary', 'evt-1');
    expect(result.success).toBe(true);
  });

  it('should treat 410 as success (already gone)', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(410));
    const result = await deleteGoogleEvent(ACCESS_TOKEN, 'primary', 'evt-1');
    expect(result.success).toBe(true);
  });

  it('should return error with requiresReauth for 401', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(401));
    const result = await deleteGoogleEvent(ACCESS_TOKEN, 'primary', 'evt-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.requiresReauth).toBe(true);
    }
  });

  it('should return error for 500', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(500));
    const result = await deleteGoogleEvent(ACCESS_TOKEN, 'primary', 'evt-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.statusCode).toBe(500);
    }
  });

  it('should return error when fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('network gone'));
    const result = await deleteGoogleEvent(ACCESS_TOKEN, 'primary', 'evt-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('network gone');
    }
  });
});
