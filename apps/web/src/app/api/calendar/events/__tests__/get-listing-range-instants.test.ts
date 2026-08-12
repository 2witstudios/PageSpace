/**
 * GET /api/calendar/events range bounds are absolute instants (#2404).
 *
 * `startDate`/`endDate` used to be plain `z.coerce.date()`, so a naive value
 * went through `new Date("2026-02-19T19:00:00")` — which the spec parses in the
 * *server process's* local zone. That is UTC in deployment but the developer's
 * zone under `next dev`, so a range query silently meant different windows in
 * different environments and boundary bugs would not reproduce locally.
 *
 * This file runs with TZ deliberately set away from UTC: under the old schema
 * these assertions would read the bounds as Chicago wall-clock times.
 */
process.env.TZ = 'America/Chicago';

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return { ...actual, after: vi.fn((fn: () => void) => fn()) };
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
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', timezone: 'timezone' } }));
vi.mock('@pagespace/db/schema/personalization', () => ({ userPersonalization: { userId: 'userId' } }));
vi.mock('@pagespace/lib/memory/memory-pages', () => ({ readMemoryPages: vi.fn().mockResolvedValue({}) }));

vi.mock('@/lib/workflows/calendar-trigger-helpers', () => ({
  upsertCalendarTriggerWorkflowInTx: vi.fn(),
  validateCalendarAgentTrigger: vi.fn(),
}));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/websocket/calendar-events', () => ({ broadcastCalendarEvent: vi.fn() }));
vi.mock('@/lib/integrations/google-calendar/push-service', () => ({ pushEventToGoogle: vi.fn() }));
vi.mock('@/lib/workflows/recurrence-utils', () => ({
  expandRecurringEvents: vi.fn((events: unknown[]) => events),
}));
vi.mock('cron-parser', () => ({ CronExpressionParser: { parse: vi.fn() } }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => typeof r === 'object' && r !== null && 'error' in r),
  checkMCPDriveScope: vi.fn(() => null),
  checkMCPCreateScope: vi.fn(() => null),
  isPrincipalDriveMember: vi.fn(),
  getPrincipalDriveIds: vi.fn().mockResolvedValue([]),
  canPrincipalViewPage: vi.fn(),
  isScopedMCPAuth: vi.fn(() => false),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { calendarEvents: { findMany: vi.fn() } },
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
  },
}));

import { GET } from '../route';
import { db } from '@pagespace/db/db';
import { lte } from '@pagespace/db/operators';
import { authenticateRequestWithOptions } from '@/lib/auth';

function makeGetRequest(startDate: string, endDate: string): Request {
  const url = new URL('http://localhost:3000/api/calendar/events');
  url.searchParams.set('context', 'user');
  url.searchParams.set('startDate', startDate);
  url.searchParams.set('endDate', endDate);
  return new Request(url.toString(), { method: 'GET' });
}

/** The upper bound the route compares startAt against. */
function upperBound(): Date {
  const call = (lte as Mock).mock.calls.find(([column]) => column === 'startAt');
  return call?.[1] as Date;
}

describe('GET /api/calendar/events — range bounds are absolute instants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue({ userId: 'user-1', tokenType: 'session' });
    (db.query.calendarEvents.findMany as Mock).mockResolvedValue([]);
  });

  it('reads a naive range bound as UTC, not as the server process local time', async () => {
    const response = await GET(makeGetRequest('2026-02-19T00:00:00', '2026-02-19T19:00:00'));

    expect(response.status).toBe(200);
    // Under TZ=America/Chicago, an unpinned `new Date()` would make this
    // 2026-02-20T01:00:00Z — a window six hours wider than the caller asked for.
    expect(upperBound()).toEqual(new Date('2026-02-19T19:00:00Z'));
  });

  it('leaves a bound that already carries an offset alone', async () => {
    const response = await GET(makeGetRequest('2026-02-19T00:00:00Z', '2026-02-19T19:00:00+09:00'));

    expect(response.status).toBe(200);
    expect(upperBound()).toEqual(new Date('2026-02-19T10:00:00Z'));
  });
});
