/**
 * [D-OW-33] orchestrator ruling (review #2849 r2): an org-drive calendar event made MORE visible (Private < Attendees
 * only < Drive) loosens who reads it, so PATCH refuses it while the drive's org is lapsed (402 org_lapsed, nothing
 * written), judged on the event row locked in the update's transaction. Making an event less visible still applies,
 * and a paid org's drive is unaffected. Harness: patch-timezone-resolution.test.ts.
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

// [D-OW-33] the calendar lapse guard (locks the event row, refuses a widening while lapsed; real-PG tested in lib
// org-lapse-loosening.integration). Each test says whether the drive is lapsed.
const lapsedDrive = vi.hoisted(() => ({ current: false }));
const checkCalendarVisibilityMayLoosen = vi.hoisted(() => vi.fn());
vi.mock('@pagespace/lib/permissions/org-lapse-guard', async (importOriginal) => {
  const real = await importOriginal<typeof import('@pagespace/lib/permissions/org-lapse-guard')>();
  const { calendarVisibilityWidens } = await import('@pagespace/lib/organizations/loosening-core');
  checkCalendarVisibilityMayLoosen.mockImplementation(async (tx: { select: () => { from: () => { where: () => { for: () => Promise<Array<{ visibility: string }>> } } } }, _eventId: string, next: string) => {
    const [row] = await tx.select().from().where().for();
    return lapsedDrive.current && calendarVisibilityWidens(row.visibility, next) ? { ok: false, code: 'org_lapsed', status: 402, message: 'lapsed' } : null;
  });
  return { ...real, checkCalendarVisibilityMayLoosen };
});

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

let setMock: Mock;

function setupPatch(stored: 'PRIVATE' | 'ATTENDEES_ONLY' | 'DRIVE') {
  const storedEvent = { ...baseEvent, visibility: stored };
  (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuth());
  (db.query.calendarEvents.findFirst as Mock).mockResolvedValue(storedEvent);
  const returningMock = vi.fn().mockResolvedValue([storedEvent]);
  setMock = vi.fn(() => ({ where: vi.fn(() => ({ returning: returningMock })) }));
  (db.update as Mock).mockReturnValue({ set: setMock });
  const txStub = {
    // The event row read FOR UPDATE inside the transaction.
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ for: vi.fn().mockResolvedValue([{ visibility: stored }]) })) })) })),
    update: db.update,
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'wf-1' }]) })) })),
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

describe('PATCH /api/calendar/events/[eventId] — a lapsed org drive only restricts event visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    profileWhere.mockResolvedValue([]);
    lapsedDrive.current = true;
  });

  it('SEAT-9 (partial) [D-OW-33] ruling: Private → Drive while lapsed answers 402 org_lapsed and writes nothing', async () => {
    setupPatch('PRIVATE');
    const res = await PATCH(makeRequest({ visibility: 'DRIVE' }), { params });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'org_lapsed' });
    expect(checkCalendarVisibilityMayLoosen).toHaveBeenCalledWith(expect.anything(), EVENT_ID, 'DRIVE');
    expect(setMock).not.toHaveBeenCalled();
  });

  it('SEAT-9 (partial) [D-OW-33] ruling: Drive → Private while lapsed only restricts and applies', async () => {
    setupPatch('DRIVE');
    const res = await PATCH(makeRequest({ visibility: 'PRIVATE' }), { params });
    expect(res.status).toBe(200);
    expect(checkCalendarVisibilityMayLoosen).toHaveBeenCalledWith(expect.anything(), EVENT_ID, 'PRIVATE');
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'PRIVATE' }));
  });

  it('SEAT-9 (partial) [D-OW-33] ruling: paid, Private → Drive applies', async () => {
    lapsedDrive.current = false;
    setupPatch('PRIVATE');
    const res = await PATCH(makeRequest({ visibility: 'DRIVE' }), { params });
    expect(res.status).toBe(200);
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'DRIVE' }));
  });
});
