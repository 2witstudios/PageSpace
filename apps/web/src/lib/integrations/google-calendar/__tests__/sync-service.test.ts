import { describe, it, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

// Mock database
const mockFindFirst = vi.fn();
const mockFindMany = vi.fn();
const mockUpdate = vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn() }) });
const mockInsert = vi.fn().mockReturnValue({
  values: vi.fn().mockReturnValue({
    onConflictDoNothing: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: 'new-event-1' }]),
    }),
    onConflictDoUpdate: vi.fn(),
  }),
});
const mockSelect = vi.fn().mockReturnValue({
  from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
});
const mockTransaction = vi.fn(async (cb: (tx: unknown) => Promise<void>) => {
  await cb({
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn(),
      }),
    }),
  });
});

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      googleCalendarConnections: { findFirst: mockFindFirst, findMany: mockFindMany },
      calendarEvents: { findFirst: vi.fn() },
    },
    update: mockUpdate,
    insert: mockInsert,
    select: mockSelect,
    transaction: mockTransaction,
  },
  googleCalendarConnections: {
    userId: 'userId',
    status: 'status',
    syncCursor: 'syncCursor',
    lastSyncAt: 'lastSyncAt',
    lastSyncError: 'lastSyncError',
    updatedAt: 'updatedAt',
    webhookChannels: 'webhookChannels',
    syncFrequencyMinutes: 'syncFrequencyMinutes',
  },
  calendarEvents: {
    id: 'id',
    createdById: 'createdById',
    googleEventId: 'googleEventId',
    googleCalendarId: 'googleCalendarId',
  },
  eventAttendees: {
    eventId: 'eventId',
    userId: 'userId',
  },
  users: {
    id: 'id',
    email: 'email',
  },
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  inArray: vi.fn(),
  sql: vi.fn(),
  desc: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

const mockGetValidAccessToken = vi.fn();
const mockUpdateConnectionStatus = vi.fn();
vi.mock('../token-refresh', () => ({
  getValidAccessToken: (...args: unknown[]) => mockGetValidAccessToken(...args),
  updateConnectionStatus: (...args: unknown[]) => mockUpdateConnectionStatus(...args),
}));

const mockListEvents = vi.fn();
const mockWatchCalendar = vi.fn();
const mockStopChannel = vi.fn();
vi.mock('../api-client', () => ({
  listEvents: (...args: unknown[]) => mockListEvents(...args),
  watchCalendar: (...args: unknown[]) => mockWatchCalendar(...args),
  stopChannel: (...args: unknown[]) => mockStopChannel(...args),
}));

vi.mock('../event-transform', () => ({
  transformGoogleEventToPageSpace: vi.fn().mockReturnValue({
    title: 'Test Event',
    startAt: new Date('2025-01-01T10:00:00Z'),
    endAt: new Date('2025-01-01T11:00:00Z'),
    allDay: false,
    timezone: 'UTC',
  }),
  shouldSyncEvent: vi.fn().mockReturnValue(true),
  needsUpdate: vi.fn().mockReturnValue(true),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('mock-cuid'),
}));

vi.mock('../webhook-token', () => ({
  generateWebhookToken: vi.fn().mockReturnValue('user1.mockhash'),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('syncGoogleCalendar', () => {
  it('should return error when token refresh fails', async () => {
    mockGetValidAccessToken.mockResolvedValue({
      success: false,
      error: 'Token expired',
    });

    const { syncGoogleCalendar } = await import('../sync-service');
    const result = await syncGoogleCalendar('user-1');

    assert({
      given: 'token refresh fails',
      should: 'return unsuccessful result with error',
      actual: result.success,
      expected: false,
    });

    assert({
      given: 'token refresh fails',
      should: 'include the error message',
      actual: result.error,
      expected: 'Token expired',
    });
  });

  it('should return error when no connection found', async () => {
    mockGetValidAccessToken.mockResolvedValue({
      success: true,
      accessToken: 'valid-token',
    });
    mockFindFirst.mockResolvedValue(null);

    const { syncGoogleCalendar } = await import('../sync-service');
    const result = await syncGoogleCalendar('user-1');

    assert({
      given: 'no connection found',
      should: 'return unsuccessful result',
      actual: result.success,
      expected: false,
    });

    assert({
      given: 'no connection found',
      should: 'include descriptive error',
      actual: result.error,
      expected: 'No connection found',
    });
  });

  it('should return error when connection is not active', async () => {
    mockGetValidAccessToken.mockResolvedValue({
      success: true,
      accessToken: 'valid-token',
    });
    mockFindFirst.mockResolvedValue({
      status: 'expired',
      selectedCalendars: ['primary'],
      syncCursor: null,
      targetDriveId: null,
      markAsReadOnly: false,
      googleEmail: 'user@gmail.com',
    });

    const { syncGoogleCalendar } = await import('../sync-service');
    const result = await syncGoogleCalendar('user-1');

    assert({
      given: 'connection is expired',
      should: 'return unsuccessful result',
      actual: result.success,
      expected: false,
    });

    assert({
      given: 'connection is expired',
      should: 'report connection status in error',
      actual: result.error,
      expected: 'Connection is expired',
    });
  });

  it('should sync successfully and return event counts', async () => {
    mockGetValidAccessToken.mockResolvedValue({
      success: true,
      accessToken: 'valid-token',
    });
    mockFindFirst.mockResolvedValue({
      status: 'active',
      selectedCalendars: ['primary'],
      syncCursor: null,
      targetDriveId: null,
      markAsReadOnly: false,
      webhookChannels: null,
      googleEmail: 'user@gmail.com',
    });
    mockListEvents.mockResolvedValue({
      success: true,
      data: {
        events: [
          {
            id: 'evt-1',
            status: 'confirmed',
            summary: 'Meeting',
            start: { dateTime: '2025-01-01T10:00:00Z' },
            end: { dateTime: '2025-01-01T11:00:00Z' },
          },
        ],
        nextSyncToken: 'new-sync-token',
      },
    });

    // Mock the calendarEvents findFirst to return null (new event)
    const { db } = await import('@pagespace/db');
    (db.query.calendarEvents.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    // Mock watchCalendar for the post-sync webhook registration
    mockWatchCalendar.mockResolvedValue({
      success: true,
      data: { resourceId: 'res-1', expiration: String(Date.now() + 7 * 24 * 3600 * 1000) },
    });

    const { syncGoogleCalendar } = await import('../sync-service');
    const result = await syncGoogleCalendar('user-1');

    assert({
      given: 'successful sync with one new event',
      should: 'report success',
      actual: result.success,
      expected: true,
    });

    assert({
      given: 'successful sync with one new event',
      should: 'count 1 created event',
      actual: result.eventsCreated,
      expected: 1,
    });
  });
});

describe('parseSyncCursors (tested via syncGoogleCalendar)', () => {
  it('should handle null syncCursor gracefully', async () => {
    mockGetValidAccessToken.mockResolvedValue({
      success: true,
      accessToken: 'valid-token',
    });
    mockFindFirst.mockResolvedValue({
      status: 'active',
      selectedCalendars: ['primary'],
      syncCursor: null,
      targetDriveId: null,
      markAsReadOnly: false,
      webhookChannels: null,
      googleEmail: 'user@gmail.com',
    });
    mockListEvents.mockResolvedValue({
      success: true,
      data: { events: [], nextSyncToken: 'token-1' },
    });
    mockWatchCalendar.mockResolvedValue({ success: false, error: 'skip' });

    const { syncGoogleCalendar } = await import('../sync-service');
    const result = await syncGoogleCalendar('user-1');

    assert({
      given: 'null syncCursor',
      should: 'sync successfully',
      actual: result.success,
      expected: true,
    });
  });

  it('should handle valid JSON syncCursor', async () => {
    mockGetValidAccessToken.mockResolvedValue({
      success: true,
      accessToken: 'valid-token',
    });
    mockFindFirst.mockResolvedValue({
      status: 'active',
      selectedCalendars: ['user@gmail.com'],
      syncCursor: JSON.stringify({ 'user@gmail.com': 'existing-token' }),
      targetDriveId: null,
      markAsReadOnly: false,
      webhookChannels: null,
      googleEmail: 'user@gmail.com',
    });
    mockListEvents.mockResolvedValue({
      success: true,
      data: { events: [], nextSyncToken: 'updated-token' },
    });
    mockWatchCalendar.mockResolvedValue({ success: false, error: 'skip' });

    const { syncGoogleCalendar } = await import('../sync-service');
    const result = await syncGoogleCalendar('user-1');

    assert({
      given: 'valid JSON syncCursor',
      should: 'sync successfully using existing token',
      actual: result.success,
      expected: true,
    });

    // Verify listEvents was called with the existing sync token
    assert({
      given: 'valid JSON syncCursor with calendar token',
      should: 'pass sync token to listEvents',
      actual: mockListEvents.mock.calls[0][2]?.syncToken,
      expected: 'existing-token',
    });
  });

  it('should handle old single-string syncCursor format by discarding it', async () => {
    mockGetValidAccessToken.mockResolvedValue({
      success: true,
      accessToken: 'valid-token',
    });
    mockFindFirst.mockResolvedValue({
      status: 'active',
      selectedCalendars: ['primary'],
      syncCursor: 'not-json-string',
      targetDriveId: null,
      markAsReadOnly: false,
      webhookChannels: null,
      googleEmail: 'user@gmail.com',
    });
    mockListEvents.mockResolvedValue({
      success: true,
      data: { events: [], nextSyncToken: 'fresh-token' },
    });
    mockWatchCalendar.mockResolvedValue({ success: false, error: 'skip' });

    const { syncGoogleCalendar } = await import('../sync-service');
    const result = await syncGoogleCalendar('user-1');

    assert({
      given: 'old single-string syncCursor',
      should: 'sync successfully (discards old format)',
      actual: result.success,
      expected: true,
    });

    // Verify listEvents was called WITHOUT a sync token (old format discarded)
    assert({
      given: 'old single-string syncCursor',
      should: 'not pass a sync token to listEvents',
      actual: mockListEvents.mock.calls[0][2]?.syncToken,
      expected: undefined,
    });
  });
});

describe('syncGoogleCalendar error handling', () => {
  it('should handle token expiration (410) with sync token fallback', async () => {
    mockGetValidAccessToken.mockResolvedValue({
      success: true,
      accessToken: 'valid-token',
    });
    mockFindFirst.mockResolvedValue({
      status: 'active',
      selectedCalendars: ['cal-1'],
      syncCursor: JSON.stringify({ 'cal-1': 'old-token' }),
      targetDriveId: null,
      markAsReadOnly: false,
      webhookChannels: null,
      googleEmail: 'user@gmail.com',
    });

    // First call returns 410 (expired sync token), second succeeds
    mockListEvents
      .mockResolvedValueOnce({
        success: false,
        error: 'Sync token expired',
        statusCode: 410,
      })
      .mockResolvedValueOnce({
        success: true,
        data: { events: [], nextSyncToken: 'fresh-token' },
      });
    mockWatchCalendar.mockResolvedValue({ success: false, error: 'skip' });

    const { syncGoogleCalendar } = await import('../sync-service');
    const result = await syncGoogleCalendar('user-1');

    assert({
      given: 'sync token expired (410)',
      should: 'retry without sync token and succeed',
      actual: result.success,
      expected: true,
    });

    assert({
      given: 'sync token expired (410)',
      should: 'call listEvents twice (retry)',
      actual: mockListEvents.mock.calls.length,
      expected: 2,
    });
  });
});

describe('webhook token', () => {
  it('should generate and verify tokens correctly', async () => {
    // Reset module mock for this test to use real implementation
    vi.doUnmock('../webhook-token');

    // Set env variable for HMAC
    const originalSecret = process.env.OAUTH_STATE_SECRET;
    process.env.OAUTH_STATE_SECRET = 'test-secret-key-123';

    try {
      const { generateWebhookToken, verifyWebhookToken } = await import('../webhook-token');

      const token = generateWebhookToken('user-42');

      assert({
        given: 'a generated webhook token',
        should: 'contain the userId',
        actual: token.startsWith('user-42.'),
        expected: true,
      });

      const verified = verifyWebhookToken(token);

      assert({
        given: 'a valid webhook token',
        should: 'verify and return the userId',
        actual: verified,
        expected: 'user-42',
      });

      const tampered = verifyWebhookToken('user-42.0000000000000000000000000000000000000000000000000000000000000000');

      assert({
        given: 'a tampered webhook token',
        should: 'return null',
        actual: tampered,
        expected: null,
      });

      const invalid = verifyWebhookToken('no-dot-here');

      assert({
        given: 'a malformed token without separator',
        should: 'return null',
        actual: invalid,
        expected: null,
      });
    } finally {
      process.env.OAUTH_STATE_SECRET = originalSecret;
      vi.doMock('../webhook-token', () => ({
        generateWebhookToken: vi.fn().mockReturnValue('user1.mockhash'),
      }));
    }
  });

  it('should return empty string when OAUTH_STATE_SECRET is missing', async () => {
    vi.doUnmock('../webhook-token');

    const originalSecret = process.env.OAUTH_STATE_SECRET;
    delete process.env.OAUTH_STATE_SECRET;

    try {
      const { generateWebhookToken } = await import('../webhook-token');
      const token = generateWebhookToken('user-1');

      assert({
        given: 'no OAUTH_STATE_SECRET',
        should: 'return empty string',
        actual: token,
        expected: '',
      });
    } finally {
      process.env.OAUTH_STATE_SECRET = originalSecret;
      vi.doMock('../webhook-token', () => ({
        generateWebhookToken: vi.fn().mockReturnValue('user1.mockhash'),
      }));
    }
  });
});
