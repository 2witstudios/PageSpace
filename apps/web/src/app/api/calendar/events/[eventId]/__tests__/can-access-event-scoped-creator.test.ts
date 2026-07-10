/**
 * #1846 Codex P2 (2nd round): a scoped MCP token can now create a personal
 * (driveless) calendar event (calendar/events/route.ts POST fix). It must
 * also be able to read that SAME event back via GET, or the create is a
 * permanent dead end — but must still have no read power over a driveless
 * event created by a DIFFERENT user. Tests canAccessEvent via the GET handler.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      calendarEvents: { findFirst: vi.fn() },
      eventAttendees: { findFirst: vi.fn() },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn((...args: unknown[]) => args),
}));
vi.mock('@pagespace/db/schema/calendar', () => ({
  calendarEvents: {
    id: 'id',
    driveId: 'driveId',
    createdById: 'createdById',
    isTrashed: 'isTrashed',
  },
  eventAttendees: {
    eventId: 'eventId',
    userId: 'userId',
  },
}));
vi.mock('@pagespace/db/schema/calendar-triggers', () => ({
  calendarTriggers: { calendarEventId: 'calendarEventId', status: 'status' },
}));
vi.mock('../../../../../../lib/ai/core/timestamp-utils', () => ({
  isNaiveISODatetime: vi.fn(() => false),
  parseNaiveDatetimeInTimezone: vi.fn((dt: string) => new Date(dt)),
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isUserDriveMember: vi.fn(),
  isDriveOwnerOrAdmin: vi.fn(),
}));
vi.mock('@pagespace/lib/services/calendar-event-drive-service', () => ({
  isUserMemberOfAnyEventDrive: vi.fn().mockResolvedValue(false),
  getAllDriveIdsForEvent: vi.fn().mockResolvedValue([]),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('../../../../../../lib/websocket/calendar-events', () => ({
  broadcastCalendarEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../../../lib/integrations/google-calendar/push-service', () => ({
  pushEventUpdateToGoogle: vi.fn().mockResolvedValue(undefined),
  pushEventDeleteToGoogle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn((result: unknown) => typeof result === 'object' && result !== null && 'error' in result),
  checkMCPDriveScope: vi.fn(() => null),
}));
vi.mock('@/lib/auth/principal-permissions', () => ({
  isScopedMCPAuth: (auth: { tokenType?: string; allowedDriveIds?: string[] }) =>
    auth?.tokenType === 'mcp' && ((auth.allowedDriveIds?.length ?? 0) > 0),
  isPrincipalDriveMember: vi.fn(),
  isPrincipalDriveOwnerOrAdmin: vi.fn(),
}));

import { GET } from '../route';
import { db } from '@pagespace/db/db';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';

const CREATOR_ID = 'user_creator';
const OUTSIDER_ID = 'user_outsider';
const EVENT_ID = 'event_123';

const mockScopedMcpAuth = (userId: string) => ({
  userId,
  tokenType: 'mcp' as const,
  tokenId: 'mcp-token-1',
  allowedDriveIds: ['drive_456'],
});

const createMockPersonalEvent = (overrides: Record<string, unknown> = {}) => ({
  id: EVENT_ID,
  driveId: null,
  createdById: CREATOR_ID,
  visibility: 'PRIVATE' as const,
  title: 'Personal reminder',
  ...overrides,
});

function createGetRequest(): Request {
  return new Request('http://localhost:3000/api/calendar/events/' + EVENT_ID, { method: 'GET' });
}

function createContext(): { params: Promise<{ eventId: string }> } {
  return { params: Promise.resolve({ eventId: EVENT_ID }) };
}

describe('GET /api/calendar/events/[eventId] — canAccessEvent for scoped tokens on driveless events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 when a scoped MCP token reads a personal event it created itself', async () => {
    const event = createMockPersonalEvent();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockScopedMcpAuth(CREATOR_ID));
    (db.query.calendarEvents.findFirst as Mock).mockResolvedValue(event);

    const response = await GET(createGetRequest(), createContext());
    expect(response.status).toBe(200);
  });

  it('returns 403 when a scoped MCP token tries to read a personal event created by someone else', async () => {
    const event = createMockPersonalEvent();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockScopedMcpAuth(OUTSIDER_ID));
    (db.query.calendarEvents.findFirst as Mock).mockResolvedValue(event);

    const response = await GET(createGetRequest(), createContext());
    expect(response.status).toBe(403);
  });
});
