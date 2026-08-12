/**
 * Contract test for PATCH /api/calendar/events/[eventId] timezone resolution (#2404).
 *
 * An edit reinterprets naive datetimes against: the body's timezone, else the
 * event's own stored zone, else the caller's profile, else UTC. The stored zone
 * is NOT NULL so the profile tier is a guard rather than a routine path, but
 * the chain has to reach it — stopping one tier short is what left create
 * booking events at the wrong instant in the first place.
 *
 * Equally pinned here: an edit that says nothing about the timezone must not
 * REWRITE the event's stored zone. Resolution decides how to read this
 * request's datetimes; it is not an implicit write of the caller's profile
 * onto someone else's event.
 *
 * `timestamp-utils` and `personalization-utils` stay real — the naive→instant
 * conversion and the profile lookup are the behaviour under test.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

const { profileWhere } = vi.hoisted(() => ({
  profileWhere: vi.fn<() => Promise<Array<{ timezone: string | null }>>>(),
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
    },
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn() })) })),
    })),
    // Stands in for getUserTimezone's profile read (and the attendee lookup,
    // which ignores the rows).
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: profileWhere })) })),
    transaction: vi.fn(),
  };
  return { db };
});
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn((...args: unknown[]) => args),
  sql: vi.fn(() => ({})),
}));
vi.mock('@pagespace/db/schema/calendar', () => ({
  calendarEvents: { id: 'id', driveId: 'driveId', createdById: 'createdById', isTrashed: 'isTrashed' },
  eventAttendees: { eventId: 'eventId', userId: 'userId' },
}));
vi.mock('@pagespace/db/schema/calendar-triggers', () => ({
  calendarTriggers: { calendarEventId: 'calendarEventId', id: 'id' },
}));
vi.mock('@pagespace/db/schema/workflow-runs', () => ({
  workflowRuns: { sourceTable: 'sourceTable', sourceId: 'sourceId' },
}));
// Pulled in by personalization-utils, which stays real here.
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', timezone: 'timezone' } }));
vi.mock('@pagespace/db/schema/personalization', () => ({ userPersonalization: { userId: 'userId' } }));
vi.mock('@pagespace/lib/memory/memory-pages', () => ({ readMemoryPages: vi.fn().mockResolvedValue({}) }));

vi.mock('@/lib/workflows/calendar-trigger-helpers', () => ({
  upsertCalendarTriggerWorkflowInTx: vi.fn().mockResolvedValue({ workflowId: 'wf-1', triggerId: 'trg-1' }),
  removeCalendarTrigger: vi.fn().mockResolvedValue(undefined),
  validateCalendarAgentTrigger: vi.fn().mockResolvedValue({ agentPageId: 'agent-1' }),
  resyncCalendarTriggerTimings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isUserDriveMember: vi.fn().mockResolvedValue(true),
  isDriveOwnerOrAdmin: vi.fn().mockResolvedValue(true),
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

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => typeof r === 'object' && r !== null && 'error' in r),
  checkMCPDriveScope: vi.fn(() => null),
  isScopedMCPAuth: vi.fn(() => false),
  isPrincipalDriveMember: vi.fn().mockResolvedValue(true),
  isPrincipalDriveOwnerOrAdmin: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/websocket/calendar-events', () => ({
  broadcastCalendarEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/integrations/google-calendar/push-service', () => ({
  pushEventUpdateToGoogle: vi.fn().mockResolvedValue(undefined),
  pushEventDeleteToGoogle: vi.fn().mockResolvedValue(undefined),
}));

import { PATCH } from '../route';
import { db } from '@pagespace/db/db';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { upsertCalendarTriggerWorkflowInTx } from '@/lib/workflows/calendar-trigger-helpers';

const USER_ID = 'user_creator';
const EVENT_ID = 'event_123';
const DRIVE_ID = 'drive_456';

const mockAuth = (): SessionAuthResult => ({
  userId: USER_ID,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess',
  role: 'user',
  adminRoleVersion: 0,
});

const baseEvent = {
  id: EVENT_ID,
  driveId: DRIVE_ID,
  createdById: USER_ID,
  pageId: null,
  title: 'Dinner',
  description: null,
  location: null,
  startAt: new Date('2026-02-19T19:00:00Z'),
  endAt: new Date('2026-02-19T20:00:00Z'),
  allDay: false,
  timezone: 'UTC',
  recurrenceRule: null,
  recurrenceExceptions: [],
  visibility: 'DRIVE' as const,
  color: 'default',
  metadata: null,
  isTrashed: false,
};

/** Captures the column values the update writes. */
let setMock: Mock;

function setupPatch(event: Partial<typeof baseEvent> = {}) {
  const storedEvent = { ...baseEvent, ...event };
  (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuth());
  (db.query.calendarEvents.findFirst as Mock).mockResolvedValue(storedEvent);

  const returningMock = vi.fn().mockResolvedValue([storedEvent]);
  const whereMock = vi.fn(() => ({ returning: returningMock }));
  setMock = vi.fn(() => ({ where: whereMock }));
  (db.update as Mock).mockReturnValue({ set: setMock });

  const txStub = {
    select: db.select,
    update: db.update,
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'wf-1' }]) })),
    })),
  };
  (db.transaction as Mock).mockImplementation(async (cb: (tx: unknown) => unknown) => cb(txStub));
}

const makeRequest = (body: Record<string, unknown>) =>
  new Request(`http://localhost:3000/api/calendar/events/${EVENT_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const params = Promise.resolve({ eventId: EVENT_ID });

/** The moved dinner, as a naive wall-clock time. */
const movedToSeven = { startAt: '2026-02-19T19:00:00', endAt: '2026-02-19T20:00:00' };

describe('PATCH /api/calendar/events/[eventId] — timezone resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profileWhere.mockResolvedValue([]);
  });

  it('reinterprets a naive datetime in the timezone the body names', async () => {
    setupPatch({ timezone: 'America/Chicago' });

    const res = await PATCH(makeRequest({ ...movedToSeven, timezone: 'Asia/Tokyo' }), { params });

    expect(res.status).toBe(200);
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      startAt: new Date('2026-02-19T10:00:00Z'),
      timezone: 'Asia/Tokyo',
    }));
  });

  it("uses the event's own stored zone, not the editor's profile, when the body omits one", async () => {
    setupPatch({ timezone: 'America/Chicago' });
    // A traveller editing from Tokyo must not drag the event's hour with them:
    // the event's zone outranks the profile.
    profileWhere.mockResolvedValue([{ timezone: 'Asia/Tokyo' }]);

    const res = await PATCH(makeRequest(movedToSeven), { params });

    expect(res.status).toBe(200);
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      startAt: new Date('2026-02-20T01:00:00Z'),
    }));
  });

  it('leaves the stored zone untouched when the body does not name one', async () => {
    setupPatch({ timezone: 'America/Chicago' });
    profileWhere.mockResolvedValue([{ timezone: 'Asia/Tokyo' }]);

    const res = await PATCH(makeRequest({ title: 'Dinner, later' }), { params });

    expect(res.status).toBe(200);
    // undefined = "no change" to Drizzle. Resolution reads this request; it must
    // never quietly stamp the editor's profile zone onto the event row.
    expect(setMock.mock.calls[0][0]).toMatchObject({ timezone: undefined });
  });

  it("falls back to the caller's profile when the event has no usable zone", async () => {
    setupPatch({ timezone: '' });
    profileWhere.mockResolvedValue([{ timezone: 'America/Chicago' }]);

    const res = await PATCH(makeRequest(movedToSeven), { params });

    expect(res.status).toBe(200);
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      startAt: new Date('2026-02-20T01:00:00Z'),
    }));
  });

  it('falls back to UTC when neither the event nor the profile has a zone', async () => {
    setupPatch({ timezone: '' });
    profileWhere.mockResolvedValue([{ timezone: null }]);

    const res = await PATCH(makeRequest(movedToSeven), { params });

    expect(res.status).toBe(200);
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      startAt: new Date('2026-02-19T19:00:00Z'),
    }));
  });

  it('hands the agent trigger the same resolved zone the datetimes were read in', async () => {
    setupPatch({ timezone: 'America/Chicago' });

    const res = await PATCH(makeRequest({
      ...movedToSeven,
      agentTrigger: { agentPageId: 'agent-1', prompt: 'prep dinner' },
    }), { params });

    expect(res.status).toBe(200);
    expect(upsertCalendarTriggerWorkflowInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        timezone: 'America/Chicago',
        triggerAt: new Date('2026-02-20T01:00:00Z'),
      }),
    );
  });
});
