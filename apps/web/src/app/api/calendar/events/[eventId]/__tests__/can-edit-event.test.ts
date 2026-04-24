/**
 * Contract tests for canEditEvent auth policy in /api/calendar/events/[eventId]
 *
 * Tests the updated authorization logic: event creator, drive admin, and drive
 * owner can edit drive events. Personal events remain creator-only.
 * Tested through the PATCH handler since canEditEvent is a private function.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

// Mock next/server (must come before route import)
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return {
    ...actual,
    after: vi.fn((fn) => fn()),
  };
});

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      calendarEvents: { findFirst: vi.fn() },
      eventAttendees: { findFirst: vi.fn() },
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(),
        })),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
  },
  calendarEvents: {
    id: 'id',
    driveId: 'driveId',
    createdById: 'createdById',
    isTrashed: 'isTrashed',
    title: 'title',
  },
  eventAttendees: {
    eventId: 'eventId',
    userId: 'userId',
  },
  eq: vi.fn(),
  and: vi.fn((...args: unknown[]) => args),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isUserDriveMember: vi.fn(),
  isDriveOwnerOrAdmin: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('../../../../../../lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => {
    return typeof result === 'object' && result !== null && 'error' in result;
  }),
  checkMCPDriveScope: vi.fn(() => null), // Default: MCP scope check passes
}));

vi.mock('../../../../../../lib/websocket/calendar-events', () => ({
  broadcastCalendarEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../../../lib/integrations/google-calendar/push-service', () => ({
  pushEventUpdateToGoogle: vi.fn().mockResolvedValue(undefined),
  pushEventDeleteToGoogle: vi.fn().mockResolvedValue(undefined),
}));

import { PATCH } from '../route';
import { db } from '@pagespace/db';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { authenticateRequestWithOptions } from '../../../../../../lib/auth';

// ============================================================================
// Test Helpers
// ============================================================================

const CREATOR_ID = 'user_creator';
const ADMIN_ID = 'user_admin';
const OWNER_ID = 'user_owner';
const MEMBER_ID = 'user_member';
const OUTSIDER_ID = 'user_outsider';
const EVENT_ID = 'event_123';
const DRIVE_ID = 'drive_456';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const createMockEvent = (overrides: Record<string, unknown> = {}) => ({
  id: EVENT_ID,
  driveId: DRIVE_ID,
  createdById: CREATOR_ID,
  pageId: null,
  title: 'Team Standup',
  description: null,
  location: null,
  startAt: new Date('2025-06-01T09:00:00Z'),
  endAt: new Date('2025-06-01T10:00:00Z'),
  allDay: false,
  timezone: 'UTC',
  recurrenceRule: null,
  recurrenceExceptions: [],
  recurringEventId: null,
  originalStartAt: null,
  visibility: 'DRIVE' as const,
  color: 'default',
  metadata: null,
  isTrashed: false,
  trashedAt: null,
  googleEventId: null,
  googleCalendarId: null,
  syncedFromGoogle: false,
  lastGoogleSync: null,
  googleSyncReadOnly: false,
  createdAt: new Date('2025-05-01'),
  updatedAt: new Date('2025-05-01'),
  ...overrides,
});

const validPatchBody = {
  title: 'Updated Standup',
};

function createPatchRequest(body: Record<string, unknown> = validPatchBody): Request {
  return new Request('http://localhost:3000/api/calendar/events/' + EVENT_ID, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createContext(): { params: Promise<{ eventId: string }> } {
  return { params: Promise.resolve({ eventId: EVENT_ID }) };
}

/**
 * Helper to set up db mocks for a PATCH request flow.
 * The PATCH handler calls:
 *   1. db.query.calendarEvents.findFirst (get existing event)
 *   2. db.update().set().where().returning() (update the event)
 *   3. db.query.calendarEvents.findFirst (fetch complete event with relations)
 *   4. db.select().from().where() (get attendee IDs)
 */
function setupDbMocksForPatch(event: ReturnType<typeof createMockEvent>) {
  const findFirstMock = vi.fn()
    .mockResolvedValueOnce(event)        // 1st call: get existing event
    .mockResolvedValueOnce(event);       // 3rd call: fetch complete event

  (db.query.calendarEvents.findFirst as Mock) = findFirstMock;

  const returningMock = vi.fn().mockResolvedValue([event]);
  const whereMock = vi.fn(() => ({ returning: returningMock }));
  const setMock = vi.fn(() => ({ where: whereMock }));
  (db.update as Mock).mockReturnValue({ set: setMock });

  const selectWhereMock = vi.fn().mockResolvedValue([]);
  const selectFromMock = vi.fn(() => ({ where: selectWhereMock }));
  (db.select as Mock).mockReturnValue({ from: selectFromMock });
}

// ============================================================================
// Tests
// ============================================================================

describe('PATCH /api/calendar/events/[eventId] — canEditEvent auth policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 when the event creator edits their own event', async () => {
    const event = createMockEvent();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(CREATOR_ID));
    setupDbMocksForPatch(event);

    const response = await PATCH(createPatchRequest(), createContext());
    expect(response.status).toBe(200);

    // isDriveOwnerOrAdmin should not be called; creator short-circuits
    expect(isDriveOwnerOrAdmin).not.toHaveBeenCalled();
  });

  it('returns 200 when a drive admin edits a drive event', async () => {
    const event = createMockEvent();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(ADMIN_ID));
    (isDriveOwnerOrAdmin as Mock).mockResolvedValue(true);
    setupDbMocksForPatch(event);

    const response = await PATCH(createPatchRequest(), createContext());
    expect(response.status).toBe(200);

    expect(isDriveOwnerOrAdmin).toHaveBeenCalledWith(ADMIN_ID, DRIVE_ID);
  });

  it('returns 200 when a drive owner edits a drive event', async () => {
    const event = createMockEvent();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(OWNER_ID));
    (isDriveOwnerOrAdmin as Mock).mockResolvedValue(true);
    setupDbMocksForPatch(event);

    const response = await PATCH(createPatchRequest(), createContext());
    expect(response.status).toBe(200);

    expect(isDriveOwnerOrAdmin).toHaveBeenCalledWith(OWNER_ID, DRIVE_ID);
  });

  it('returns 403 when a regular drive member tries to edit', async () => {
    const event = createMockEvent();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(MEMBER_ID));
    (isDriveOwnerOrAdmin as Mock).mockResolvedValue(false);
    (db.query.calendarEvents.findFirst as Mock).mockResolvedValue(event);

    const response = await PATCH(createPatchRequest(), createContext());
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe('You do not have permission to edit this event');
  });

  it('returns 403 when a non-member tries to edit', async () => {
    const event = createMockEvent();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(OUTSIDER_ID));
    (isDriveOwnerOrAdmin as Mock).mockResolvedValue(false);
    (db.query.calendarEvents.findFirst as Mock).mockResolvedValue(event);

    const response = await PATCH(createPatchRequest(), createContext());
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe('You do not have permission to edit this event');
  });

  it('returns 403 for a personal event when non-creator tries to edit (no driveId)', async () => {
    const personalEvent = createMockEvent({ driveId: null });
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(OUTSIDER_ID));
    (db.query.calendarEvents.findFirst as Mock).mockResolvedValue(personalEvent);

    const response = await PATCH(createPatchRequest(), createContext());
    expect(response.status).toBe(403);

    // isDriveOwnerOrAdmin should NOT be called for personal events (no driveId)
    expect(isDriveOwnerOrAdmin).not.toHaveBeenCalled();

    const body = await response.json();
    expect(body.error).toBe('You do not have permission to edit this event');
  });

  it('returns 200 for a personal event when the creator edits it', async () => {
    const personalEvent = createMockEvent({ driveId: null });
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockWebAuth(CREATOR_ID));
    setupDbMocksForPatch(personalEvent);

    const response = await PATCH(createPatchRequest(), createContext());
    expect(response.status).toBe(200);

    // isDriveOwnerOrAdmin should NOT be called; creator short-circuits
    expect(isDriveOwnerOrAdmin).not.toHaveBeenCalled();
  });
});
