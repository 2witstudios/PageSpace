/**
 * Contract test for POST /api/calendar/events timezone resolution (#2404).
 *
 * The schema used to declare `timezone: z.string().default('UTC')`, so a client
 * that omitted the field — which the API contract explicitly permits — had its
 * naive wall-clock datetime interpreted as UTC and silently booked at the wrong
 * instant, while the task routes resolved the same omission against the
 * caller's profile. This pins the three-tier order (body → profile → UTC) and,
 * just as importantly, that the RESOLVED zone is what lands in the event row —
 * otherwise the next PATCH inherits the wrong zone.
 *
 * `timestamp-utils` and `personalization-utils` are deliberately NOT mocked:
 * the naive→instant conversion and the profile lookup are the behaviour under
 * test, so only the database underneath them is stubbed.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

const { selectWhere, capturedEventValues } = vi.hoisted(() => ({
  selectWhere: vi.fn<() => Promise<Array<{ timezone: string | null }>>>(),
  capturedEventValues: { current: null as Record<string, unknown> | null },
}));

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return { ...actual, after: vi.fn((fn: () => void) => fn()) };
});

vi.mock('@pagespace/db/db', () => {
  const db = {
    query: {
      calendarEvents: { findFirst: vi.fn() },
      eventAttendees: { findFirst: vi.fn() },
      pages: { findFirst: vi.fn(), findMany: vi.fn() },
    },
    // The only db.select() in the POST path is getUserTimezone's profile read.
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: selectWhere })) })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'evt-new' }]) })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
    transaction: vi.fn(),
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
  calendarEvents: { id: 'id', driveId: 'driveId', createdById: 'createdById' },
  eventAttendees: { eventId: 'eventId', userId: 'userId' },
  calendarEventDrives: { eventId: 'eventId', driveId: 'driveId' },
}));
vi.mock('@pagespace/db/schema/calendar-triggers', () => ({
  calendarTriggers: { id: 'id', workflowId: 'workflowId', calendarEventId: 'calendarEventId' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', type: 'type', isTrashed: 'isTrashed', driveId: 'driveId' },
}));
vi.mock('@pagespace/db/schema/workflows', () => ({ workflows: { id: 'id', timezone: 'timezone' } }));
vi.mock('@pagespace/db/schema/workflow-runs', () => ({ workflowRuns: { id: 'id', sourceTable: 'sourceTable', sourceId: 'sourceId' } }));
// Pulled in by personalization-utils, which stays real here.
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', timezone: 'timezone' } }));
vi.mock('@pagespace/db/schema/personalization', () => ({ userPersonalization: { userId: 'userId' } }));
vi.mock('@pagespace/lib/memory/memory-pages', () => ({ readMemoryPages: vi.fn().mockResolvedValue({}) }));

vi.mock('@/lib/workflows/calendar-trigger-helpers', () => ({
  upsertCalendarTriggerWorkflowInTx: vi.fn().mockResolvedValue({ workflowId: 'wf-1', triggerId: 'trg-1' }),
  validateCalendarAgentTrigger: vi.fn().mockResolvedValue({ agentPageId: 'agent-1' }),
}));

vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  getDriveRecipientUserIds: vi.fn().mockResolvedValue(['user-1']),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => typeof r === 'object' && r !== null && 'error' in r),
  checkMCPDriveScope: vi.fn(() => null),
  checkMCPCreateScope: vi.fn(() => null),
  isPrincipalDriveMember: vi.fn().mockResolvedValue(true),
  getPrincipalDriveIds: vi.fn().mockResolvedValue(['drive-1']),
  canPrincipalViewPage: vi.fn().mockResolvedValue(true),
  isScopedMCPAuth: vi.fn(() => false),
}));

vi.mock('@/lib/websocket/calendar-events', () => ({
  broadcastCalendarEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/integrations/google-calendar/push-service', () => ({
  pushEventToGoogle: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/workflows/recurrence-utils', () => ({ expandRecurringEvents: vi.fn(() => []) }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: {
      child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    },
  },
}));
vi.mock('cron-parser', () => ({ CronExpressionParser: { parse: vi.fn() } }));

import { POST } from '../route';
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

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost:3000/api/calendar/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A personal (driveless) 7pm dinner, expressed as a naive wall-clock time. */
const dinnerAtSeven = {
  title: 'Dinner',
  startAt: '2026-02-19T19:00:00',
  endAt: '2026-02-19T20:00:00',
};

describe('POST /api/calendar/events — timezone resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEventValues.current = null;
    selectWhere.mockResolvedValue([]);
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuth());

    (db.transaction as Mock).mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        insert: vi.fn(() => ({
          values: vi.fn((values: Record<string, unknown>) => {
            // The first insert in the tx is the event itself; attendee inserts follow.
            if (capturedEventValues.current === null) capturedEventValues.current = values;
            return { returning: vi.fn().mockResolvedValue([{ id: 'evt-new' }]) };
          }),
        })),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
      };
      return cb(tx);
    });

    (db.query.calendarEvents.findFirst as Mock).mockResolvedValue({ id: 'evt-new', attendees: [] });
  });

  it("interprets a naive datetime in the caller's profile timezone when the body omits one", async () => {
    selectWhere.mockResolvedValue([{ timezone: 'America/Chicago' }]);

    const res = await POST(makeRequest(dinnerAtSeven));

    expect(res.status).toBe(201);
    // 7pm Central on a February date = 01:00 UTC the next day. Under the old
    // `.default('UTC')` this stored 19:00Z — 1pm local, six hours early.
    expect(capturedEventValues.current?.startAt).toEqual(new Date('2026-02-20T01:00:00Z'));
    expect(capturedEventValues.current?.endAt).toEqual(new Date('2026-02-20T02:00:00Z'));
  });

  it('stores the resolved zone on the event, so a later edit inherits it', async () => {
    selectWhere.mockResolvedValue([{ timezone: 'America/Chicago' }]);

    const res = await POST(makeRequest(dinnerAtSeven));

    expect(res.status).toBe(201);
    expect(capturedEventValues.current?.timezone).toBe('America/Chicago');
  });

  it('lets an explicit body timezone win, without reading the profile', async () => {
    selectWhere.mockResolvedValue([{ timezone: 'America/Chicago' }]);

    const res = await POST(makeRequest({ ...dinnerAtSeven, timezone: 'Asia/Tokyo' }));

    expect(res.status).toBe(201);
    expect(capturedEventValues.current?.startAt).toEqual(new Date('2026-02-19T10:00:00Z'));
    expect(capturedEventValues.current?.timezone).toBe('Asia/Tokyo');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('falls back to UTC when neither the body nor the profile supplies a timezone', async () => {
    selectWhere.mockResolvedValue([{ timezone: null }]);

    const res = await POST(makeRequest(dinnerAtSeven));

    expect(res.status).toBe(201);
    expect(capturedEventValues.current?.startAt).toEqual(new Date('2026-02-19T19:00:00Z'));
    expect(capturedEventValues.current?.timezone).toBe('UTC');
  });

  it('leaves an absolute datetime alone — the profile zone must not re-offset it', async () => {
    selectWhere.mockResolvedValue([{ timezone: 'America/Chicago' }]);

    const res = await POST(makeRequest({
      title: 'Dinner',
      startAt: '2026-02-19T19:00:00Z',
      endAt: '2026-02-19T20:00:00Z',
    }));

    expect(res.status).toBe(201);
    expect(capturedEventValues.current?.startAt).toEqual(new Date('2026-02-19T19:00:00Z'));
    // The zone is still recorded — it describes how to DISPLAY the event.
    expect(capturedEventValues.current?.timezone).toBe('America/Chicago');
  });

  it('gives the agent trigger the same resolved zone as the event', async () => {
    selectWhere.mockResolvedValue([{ timezone: 'America/Chicago' }]);
    const { upsertCalendarTriggerWorkflowInTx } = await import('@/lib/workflows/calendar-trigger-helpers');

    const res = await POST(makeRequest({
      ...dinnerAtSeven,
      driveId: 'drive-1',
      agentTrigger: { agentPageId: 'agent-1', prompt: 'prep dinner' },
    }));

    expect(res.status).toBe(201);
    expect(upsertCalendarTriggerWorkflowInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        timezone: 'America/Chicago',
        triggerAt: new Date('2026-02-20T01:00:00Z'),
      }),
    );
  });
});
