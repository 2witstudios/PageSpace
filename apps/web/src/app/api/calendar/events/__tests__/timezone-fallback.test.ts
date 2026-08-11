/**
 * Calendar routes must interpret wall-clock times in the CALLER'S timezone,
 * not UTC.
 *
 * The AI tool path gets this right because chat routes load the user's profile
 * timezone into ToolExecutionContext and the calendar tools read it. The REST
 * routes had no equivalent: POST hardcoded `timezone: z.string().default('UTC')`
 * and GET coerced its date window with `z.coerce.date()`. Every caller that
 * reaches the routes directly — the SDK, and therefore every calendar MCP tool
 * the CLI serves — sends no timezone, so naive times were reinterpreted as UTC
 * and the stored event was stamped 'UTC', which then propagated to the event's
 * agent trigger and to every later PATCH falling back to `event.timezone`.
 *
 * These tests pin the three-step fallback (explicit -> profile -> UTC) on the
 * write path and the timezone-aware window on the read path.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return { ...actual, after: vi.fn((fn) => fn()) };
});

/** Captures the values handed to the calendarEvents insert inside the tx. */
const insertedValues = vi.fn();

vi.mock('@pagespace/db/db', () => {
  const txStub = {
    insert: vi.fn(() => ({
      values: vi.fn((values: unknown) => {
        insertedValues(values);
        return {
          returning: vi.fn().mockResolvedValue([
            { id: 'evt-new', startAt: new Date('2026-02-20T01:00:00Z') },
          ]),
        };
      }),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
  };
  const db = {
    query: {
      calendarEvents: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      eventAttendees: { findFirst: vi.fn() },
      pages: { findFirst: vi.fn(), findMany: vi.fn() },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'evt-new' }]) })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
    transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(txStub)),
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
  calendarTriggers: { id: 'id', workflowId: 'workflowId', calendarEventId: 'calendarEventId' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', type: 'type', isTrashed: 'isTrashed', driveId: 'driveId' },
}));
vi.mock('@pagespace/db/schema/workflows', () => ({ workflows: { id: 'id', driveId: 'driveId' } }));
vi.mock('@pagespace/db/schema/workflow-runs', () => ({ workflowRuns: { id: 'id', sourceTable: 'sourceTable', sourceId: 'sourceId' } }));

const upsertCalendarTriggerWorkflowInTx = vi.fn().mockResolvedValue({ workflowId: 'wf-1', triggerId: 'trg-1' });
vi.mock('@/lib/workflows/calendar-trigger-helpers', () => ({
  upsertCalendarTriggerWorkflowInTx: (...args: unknown[]) => upsertCalendarTriggerWorkflowInTx(...args),
  validateCalendarAgentTrigger: vi.fn().mockResolvedValue({ agentPageId: 'agent-1' }),
}));

vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/websocket/calendar-events', () => ({ broadcastCalendarEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/integrations/google-calendar/push-service', () => ({ pushEventToGoogle: vi.fn().mockResolvedValue(undefined) }));
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
  isPrincipalDriveMember: vi.fn().mockResolvedValue(true),
  getPrincipalDriveIds: vi.fn().mockResolvedValue([]),
  canPrincipalViewPage: vi.fn().mockResolvedValue(true),
  isScopedMCPAuth: vi.fn(() => false),
}));

// The one thing these tests stub: what the caller's timezone resolves to. The
// resolution itself (explicit -> profile -> UTC) is pinned in
// lib/ai/core/__tests__/resolve-request-timezone.test.ts. timestamp-utils is
// deliberately NOT mocked — the point is that real parsing lands the right
// instant.
const resolveRequestTimezone = vi.fn();
vi.mock('@/lib/ai/core/personalization-utils', () => ({
  resolveRequestTimezone: (...args: unknown[]) => resolveRequestTimezone(...args),
}));

import { GET, POST } from '../route';
import { db } from '@pagespace/db/db';
import { authenticateRequestWithOptions } from '@/lib/auth';

const USER_ID = 'user-1';

const mockAuth = (): SessionAuthResult => ({
  userId: USER_ID,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'session-1',
  role: 'user',
  adminRoleVersion: 0,
});

function postRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost:3000/api/calendar/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest(startDate: string, endDate: string): Request {
  const url = new URL('http://localhost:3000/api/calendar/events');
  url.searchParams.set('context', 'user');
  url.searchParams.set('startDate', startDate);
  url.searchParams.set('endDate', endDate);
  return new Request(url.toString(), { method: 'GET' });
}

/** The values the route handed to the calendarEvents insert. */
function insertedEvent() {
  return insertedValues.mock.calls[0]?.[0] as { startAt: Date; endAt: Date; timezone: string };
}

describe('POST /api/calendar/events — timezone resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuth());
    resolveRequestTimezone.mockResolvedValue('America/Chicago');
    (db.query.calendarEvents.findFirst as Mock).mockResolvedValue({
      id: 'evt-new',
      driveId: null,
      createdById: USER_ID,
      title: 'Dinner',
      startAt: new Date('2026-02-20T01:00:00Z'),
      endAt: new Date('2026-02-20T02:00:00Z'),
      attendees: [],
    });
  });

  it('interprets a naive datetime in the resolved timezone, not UTC', async () => {
    const res = await POST(postRequest({
      title: 'Dinner',
      startAt: '2026-02-19T19:00:00',
      endAt: '2026-02-19T20:00:00',
      visibility: 'PRIVATE',
    }));

    expect(res.status).toBeLessThan(400);
    // 7pm Central (CST, UTC-6) = 01:00Z the next day — NOT 19:00Z.
    expect(insertedEvent().startAt.toISOString()).toBe('2026-02-20T01:00:00.000Z');
    expect(insertedEvent().endAt.toISOString()).toBe('2026-02-20T02:00:00.000Z');
  });

  it('stores the resolved timezone on the event instead of UTC', async () => {
    await POST(postRequest({
      title: 'Dinner',
      startAt: '2026-02-19T19:00:00',
      endAt: '2026-02-19T20:00:00',
      visibility: 'PRIVATE',
    }));

    expect(insertedEvent().timezone).toBe('America/Chicago');
  });

  it('asks the resolver with whatever the caller sent, so an explicit value can win', async () => {
    resolveRequestTimezone.mockResolvedValue('Europe/Berlin');

    await POST(postRequest({
      title: 'Dinner',
      startAt: '2026-02-19T19:00:00',
      endAt: '2026-02-19T20:00:00',
      timezone: 'Europe/Berlin',
      visibility: 'PRIVATE',
    }));

    expect(resolveRequestTimezone).toHaveBeenCalledWith('Europe/Berlin', USER_ID);
    // 7pm Berlin (CET, UTC+1) = 18:00Z.
    expect(insertedEvent().startAt.toISOString()).toBe('2026-02-19T18:00:00.000Z');
    expect(insertedEvent().timezone).toBe('Europe/Berlin');
  });

  it('leaves a datetime that already carries an offset alone', async () => {
    await POST(postRequest({
      title: 'Dinner',
      startAt: '2026-02-19T19:00:00Z',
      endAt: '2026-02-19T20:00:00Z',
      visibility: 'PRIVATE',
    }));

    expect(insertedEvent().startAt.toISOString()).toBe('2026-02-19T19:00:00.000Z');
  });

  it('gives the event agent trigger the same resolved timezone', async () => {
    await POST(postRequest({
      driveId: 'drive-1',
      title: 'Standup',
      startAt: '2026-02-19T19:00:00',
      endAt: '2026-02-19T20:00:00',
      agentTrigger: { agentPageId: 'agent-1', prompt: 'summarize' },
    }));

    expect(upsertCalendarTriggerWorkflowInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timezone: 'America/Chicago' }),
    );
  });
});

describe('GET /api/calendar/events — timezone-aware date window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuth());
    resolveRequestTimezone.mockResolvedValue('America/Chicago');
    (db.query.calendarEvents.findMany as Mock).mockResolvedValue([]);
  });

  /** The date window the handler actually queried, read off the lte/gte calls. */
  async function windowFor(startDate: string, endDate: string) {
    const { gte, lte } = await import('@pagespace/db/operators');
    await GET(getRequest(startDate, endDate));
    const ends = (lte as Mock).mock.calls.map(c => c[1] as Date);
    const starts = (gte as Mock).mock.calls.map(c => c[1] as Date);
    return { start: starts[0], end: ends[0] };
  }

  it('starts a date-only window at local midnight, not UTC midnight', async () => {
    const { start, end } = await windowFor('2026-02-19', '2026-02-20');

    expect(start?.toISOString()).toBe('2026-02-19T06:00:00.000Z');
    expect(end?.toISOString()).toBe('2026-02-20T06:00:00.000Z');
  });

  it('reads a naive datetime window in the caller timezone', async () => {
    const { start } = await windowFor('2026-02-19T09:00:00', '2026-02-19T17:00:00');

    expect(start?.toISOString()).toBe('2026-02-19T15:00:00.000Z');
  });

  it('leaves a window that already names instants exactly as sent', async () => {
    const { start, end } = await windowFor('2026-02-19T00:00:00Z', '2026-02-20T00:00:00Z');

    expect(start?.toISOString()).toBe('2026-02-19T00:00:00.000Z');
    expect(end?.toISOString()).toBe('2026-02-20T00:00:00.000Z');
  });

  it('does not look up the caller timezone when the window is already absolute', async () => {
    // The web client always sends toISOString() values; that path should cost
    // no extra profile read.
    await GET(getRequest('2026-02-19T00:00:00Z', '2026-02-20T00:00:00Z'));

    expect(resolveRequestTimezone).not.toHaveBeenCalled();
  });
});
