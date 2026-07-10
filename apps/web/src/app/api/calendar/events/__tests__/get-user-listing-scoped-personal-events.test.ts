/**
 * #1846 Codex P2 (2nd round): GET /api/calendar/events (context=user) must
 * list back a personal (driveless) event that a scoped MCP token itself
 * created (the create fix in this same PR would otherwise produce a
 * permanently unlistable event), while still excluding a driveless event
 * created by a DIFFERENT user (identity-scoped condition + the
 * scoped-token cap filter must both allow the caller's own creation through).
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return { ...actual, after: vi.fn((fn) => fn()) };
});

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((...a: unknown[]) => ({ __op: 'eq', a })),
  and: vi.fn((...a: unknown[]) => ({ __op: 'and', a })),
  or: vi.fn((...a: unknown[]) => ({ __op: 'or', a })),
  gte: vi.fn(),
  lte: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(() => ({ __op: 'isNull' })),
  isNotNull: vi.fn(),
  asc: vi.fn(),
  desc: vi.fn(),
}));

vi.mock('@pagespace/db/schema/calendar', () => ({
  calendarEvents: { id: 'id', driveId: 'driveId', createdById: 'createdById', isTrashed: 'isTrashed', visibility: 'visibility', recurrenceRule: 'recurrenceRule', startAt: 'startAt', endAt: 'endAt' },
  eventAttendees: { eventId: 'eventId', userId: 'userId' },
  calendarEventDrives: { eventId: 'eventId', driveId: 'driveId' },
}));
vi.mock('@pagespace/db/schema/calendar-triggers', () => ({
  calendarTriggers: { calendarEventId: 'calendarEventId' },
}));
vi.mock('@pagespace/db/schema/workflows', () => ({ workflows: { id: 'id', driveId: 'driveId' } }));
vi.mock('@pagespace/db/schema/workflow-runs', () => ({ workflowRuns: { id: 'id' } }));

vi.mock('@/lib/workflows/calendar-trigger-helpers', () => ({
  upsertCalendarTriggerWorkflowInTx: vi.fn(),
  validateCalendarAgentTrigger: vi.fn(),
}));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/websocket/calendar-events', () => ({ broadcastCalendarEvent: vi.fn() }));
vi.mock('@/lib/integrations/google-calendar/push-service', () => ({ pushEventToGoogle: vi.fn() }));
vi.mock('@/lib/ai/core/timestamp-utils', () => ({
  isNaiveISODatetime: vi.fn(() => false),
  parseNaiveDatetimeInTimezone: vi.fn((dt: string) => new Date(dt)),
}));
vi.mock('@/lib/workflows/recurrence-utils', () => ({
  expandRecurringEvents: vi.fn((events: unknown[]) => events),
}));
vi.mock('cron-parser', () => ({ CronExpressionParser: { parse: vi.fn() } }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

const CREATOR_ID = 'user-creator';
const OUTSIDER_ID = 'user-outsider';

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn((r: unknown) => typeof r === 'object' && r !== null && 'error' in r),
  checkMCPDriveScope: vi.fn(() => null),
  checkMCPCreateScope: vi.fn(() => null),
}));
vi.mock('@/lib/auth/principal-permissions', () => ({
  isPrincipalDriveMember: vi.fn(),
  getPrincipalDriveIds: vi.fn().mockResolvedValue([]),
  canPrincipalViewPage: vi.fn(),
  isScopedMCPAuth: (auth: { tokenType?: string; allowedDriveIds?: string[] }) =>
    auth?.tokenType === 'mcp' && ((auth.allowedDriveIds?.length ?? 0) > 0),
}));

const PERSONAL_EVENT = {
  id: 'evt-personal',
  driveId: null,
  createdById: CREATOR_ID,
  visibility: 'PRIVATE',
  isTrashed: false,
  startAt: new Date('2026-07-04T10:00:00Z'),
  endAt: new Date('2026-07-04T11:00:00Z'),
  recurrenceRule: null,
};

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      calendarEvents: { findMany: vi.fn() },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
  },
}));

import { GET } from '../route';
import { db } from '@pagespace/db/db';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';

const mockScopedMcpAuth = (userId: string) => ({
  userId,
  tokenType: 'mcp' as const,
  tokenId: 'mcp-token-1',
  allowedDriveIds: ['some-other-drive'],
});

function makeGetRequest(): Request {
  const url = new URL('http://localhost:3000/api/calendar/events');
  url.searchParams.set('context', 'user');
  url.searchParams.set('startDate', '2026-07-01T00:00:00Z');
  url.searchParams.set('endDate', '2026-07-31T00:00:00Z');
  return new Request(url.toString(), { method: 'GET' });
}

describe('GET /api/calendar/events (context=user) — scoped token + personal events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.query.calendarEvents.findMany as Mock).mockResolvedValue([PERSONAL_EVENT]);
  });

  it('lists a personal event a scoped MCP token created itself', async () => {
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockScopedMcpAuth(CREATOR_ID));

    const response = await GET(makeGetRequest());
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.events.map((e: { id: string }) => e.id)).toContain('evt-personal');
  });

  it('does not leak a personal event created by a different user to a scoped MCP token', async () => {
    // The event fixture is fixed to CREATOR_ID; a different caller querying
    // under a scoped token must not see it even if it somehow surfaced
    // (e.g. via the attendee branch) — the final cap filter must exclude it.
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockScopedMcpAuth(OUTSIDER_ID));

    const response = await GET(makeGetRequest());
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.events.map((e: { id: string }) => e.id)).not.toContain('evt-personal');
  });
});
