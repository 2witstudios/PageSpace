/**
 * #1837 finding #2 — a scoped MCP token creating a driveless (personal)
 * calendar event was 403ing with "Scoped tokens cannot create new drives".
 *
 * checkMCPCreateScope(auth, targetDriveId) treats `targetDriveId === null` as
 * "this call is creating a brand-new drive" (its real caller is POST
 * /api/drives). The events route reused it as `checkMCPCreateScope(auth,
 * data.driveId ?? null)`, so an event with NO driveId (a personal event, not a
 * drive at all) tripped the same "cannot create new drives" guard. Personal
 * events aren't scoped to any drive, so a scoped token should be able to
 * create one for its own user unconditionally — the guard should only apply
 * when a driveId is actually supplied.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return { ...actual, after: vi.fn((fn) => fn()) };
});

vi.mock('@pagespace/db/db', () => {
  const db = {
    query: {
      calendarEvents: { findFirst: vi.fn() },
      eventAttendees: { findFirst: vi.fn() },
      pages: { findFirst: vi.fn(), findMany: vi.fn() },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'evt-new' }]) })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
    transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: 'evt-new', startAt: new Date('2026-07-04T14:00:00Z') }]),
        })),
      })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
    })),
  };
  return { db };
});

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn((...args: unknown[]) => args),
  or: vi.fn((...args: unknown[]) => args),
  gte: vi.fn(),
  lte: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  asc: vi.fn(),
  desc: vi.fn(),
}));

vi.mock('@pagespace/db/schema/calendar', () => ({
  calendarEvents: { id: 'id', driveId: 'driveId', createdById: 'createdById' },
  eventAttendees: { eventId: 'eventId', userId: 'userId' },
}));
vi.mock('@pagespace/db/schema/calendar-triggers', () => ({
  calendarTriggers: { id: 'id', workflowId: 'workflowId', calendarEventId: 'calendarEventId' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', type: 'type', isTrashed: 'isTrashed', driveId: 'driveId' },
}));
vi.mock('@pagespace/db/schema/workflows', () => ({ workflows: { id: 'id' } }));
vi.mock('@pagespace/db/schema/workflow-runs', () => ({ workflowRuns: { id: 'id', sourceTable: 'sourceTable', sourceId: 'sourceId' } }));

vi.mock('@/lib/workflows/calendar-trigger-helpers', () => ({
  upsertCalendarTriggerWorkflowInTx: vi.fn().mockResolvedValue({ workflowId: 'wf-1', triggerId: 'trg-1' }),
  validateCalendarAgentTrigger: vi.fn().mockResolvedValue({ agentPageId: 'agent-1' }),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isUserDriveMember: vi.fn().mockResolvedValue(true),
  getDriveIdsForUser: vi.fn().mockResolvedValue(['drive-1']),
  canUserViewPage: vi.fn().mockResolvedValue(true),
}));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveMemberUserIds: vi.fn().mockResolvedValue(['user-1']),
}));

// Mirrors the REAL semantics of checkMCPCreateScope: null targetDriveId is
// treated as "creating a new drive" and denied for a scoped token.
const checkMCPCreateScope = vi.fn((_auth: unknown, targetDriveId: string | null) => {
  if (targetDriveId === null) {
    return new Response(
      JSON.stringify({ error: 'Scoped tokens cannot create new drives' }),
      { status: 403 },
    );
  }
  return null;
});

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn((r: unknown) => typeof r === 'object' && r !== null && 'error' in r),
  checkMCPDriveScope: vi.fn(() => null),
  checkMCPCreateScope: (...args: [unknown, string | null]) => checkMCPCreateScope(...args),
  filterDrivesByMCPScope: vi.fn((_: unknown, ids: string[]) => ids),
}));
vi.mock('@/lib/auth/principal-permissions', () => ({
  isScopedMCPAuth: vi.fn(() => true),
  isPrincipalDriveMember: vi.fn(async (auth: { userId: string }, driveId: string) => {
    const { isUserDriveMember } = await import('@pagespace/lib/permissions/permissions');
    return isUserDriveMember(auth.userId, driveId);
  }),
  getPrincipalDriveIds: vi.fn(async (auth: { userId: string }) => {
    const { getDriveIdsForUser } = await import('@pagespace/lib/permissions/permissions');
    return getDriveIdsForUser(auth.userId);
  }),
  canPrincipalViewPage: vi.fn(async (auth: { userId: string }, pageId: string) => {
    const { canUserViewPage } = await import('@pagespace/lib/permissions/permissions');
    return canUserViewPage(auth.userId, pageId);
  }),
}));

vi.mock('@/lib/websocket/calendar-events', () => ({
  broadcastCalendarEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/integrations/google-calendar/push-service', () => ({
  pushEventToGoogle: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/ai/core/timestamp-utils', () => ({
  isNaiveISODatetime: vi.fn(() => false),
  parseNaiveDatetimeInTimezone: vi.fn((dt: string) => new Date(dt)),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: {
      child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('cron-parser', () => ({ CronExpressionParser: { parse: vi.fn() } }));

import { POST } from '../route';
import { db } from '@pagespace/db/db';
import type { SessionAuthResult } from '@/lib/auth/auth-types';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';

const USER_ID = 'user-1';

const mockAuth = (): SessionAuthResult => ({
  userId: USER_ID,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'session-1',
  role: 'user',
  adminRoleVersion: 0,
});

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost:3000/api/calendar/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/calendar/events — scoped token + driveless personal event', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuth());
    (db.query.calendarEvents.findFirst as Mock).mockResolvedValue({
      id: 'evt-new',
      driveId: null,
      createdById: USER_ID,
      title: 'Personal event',
      startAt: new Date('2026-07-04T14:00:00Z'),
      endAt: new Date('2026-07-04T15:00:00Z'),
      attendees: [],
    });
  });

  it('does not 403 a personal (driveless) event for a scoped token', async () => {
    const res = await POST(makeRequest({
      title: 'Personal event',
      startAt: '2026-07-04T14:00:00Z',
      endAt: '2026-07-04T15:00:00Z',
      timezone: 'UTC',
      visibility: 'PRIVATE',
    }));

    const body = await res.json();
    expect(body.error).not.toBe('Scoped tokens cannot create new drives');
    expect(res.status).toBeLessThan(400);
  });

  it('still enforces drive scope when a driveId IS supplied', async () => {
    (db.query.calendarEvents.findFirst as Mock).mockResolvedValue({
      id: 'evt-new',
      driveId: 'out-of-scope-drive',
      createdById: USER_ID,
      title: 'Drive event',
      startAt: new Date('2026-07-04T14:00:00Z'),
      endAt: new Date('2026-07-04T15:00:00Z'),
      attendees: [],
    });

    await POST(makeRequest({
      driveId: 'out-of-scope-drive',
      title: 'Drive event',
      startAt: '2026-07-04T14:00:00Z',
      endAt: '2026-07-04T15:00:00Z',
      timezone: 'UTC',
    }));

    expect(checkMCPCreateScope).toHaveBeenCalledWith(expect.anything(), 'out-of-scope-drive');
  });
});
