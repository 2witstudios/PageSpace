/**
 * Contract test for PATCH /api/calendar/events/[eventId] agent-trigger handling.
 *
 *   - body.agentTrigger === undefined → no change (existing trigger left alone)
 *   - body.agentTrigger === null      → remove trigger (drop linked workflows row)
 *   - body.agentTrigger === object    → upsert via upsertCalendarTriggerWorkflow
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return { ...actual, after: vi.fn((fn) => fn()) };
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
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
    })),
    transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(db)),
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

vi.mock('@/lib/workflows/calendar-trigger-helpers', () => ({
  upsertCalendarTriggerWorkflow: vi.fn().mockResolvedValue({ workflowId: 'wf-1', triggerId: 'trg-1' }),
  removeCalendarTrigger: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../../../lib/ai/core/timestamp-utils', () => ({
  isNaiveISODatetime: vi.fn(() => false),
  parseNaiveDatetimeInTimezone: vi.fn((dt: string) => new Date(dt)),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isUserDriveMember: vi.fn(),
  isDriveOwnerOrAdmin: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('../../../../../../lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => typeof r === 'object' && r !== null && 'error' in r),
  checkMCPDriveScope: vi.fn(() => null),
}));

vi.mock('../../../../../../lib/websocket/calendar-events', () => ({
  broadcastCalendarEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../../../../lib/integrations/google-calendar/push-service', () => ({
  pushEventUpdateToGoogle: vi.fn().mockResolvedValue(undefined),
  pushEventDeleteToGoogle: vi.fn().mockResolvedValue(undefined),
}));

import { PATCH } from '../route';
import { db } from '@pagespace/db/db';
import { authenticateRequestWithOptions } from '../../../../../../lib/auth';
import {
  upsertCalendarTriggerWorkflow,
  removeCalendarTrigger,
} from '@/lib/workflows/calendar-trigger-helpers';

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
  title: 'Standup',
  description: null,
  location: null,
  startAt: new Date('2026-06-01T09:00:00Z'),
  endAt: new Date('2026-06-01T10:00:00Z'),
  allDay: false,
  timezone: 'UTC',
  recurrenceRule: null,
  visibility: 'DRIVE' as const,
  color: 'default',
  metadata: null,
  isTrashed: false,
};

function setupSuccessfulPatch() {
  (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuth());
  (db.query.calendarEvents.findFirst as Mock)
    .mockResolvedValueOnce(baseEvent)
    .mockResolvedValueOnce(baseEvent);

  const returningMock = vi.fn().mockResolvedValue([baseEvent]);
  const whereMock = vi.fn(() => ({ returning: returningMock }));
  const setMock = vi.fn(() => ({ where: whereMock }));
  (db.update as Mock).mockReturnValue({ set: setMock });

  const txStub = {
    update: db.update,
  };
  (db.transaction as Mock).mockImplementation(async (cb: (tx: unknown) => unknown) => cb(txStub));

  const selectWhereMock = vi.fn().mockResolvedValue([]);
  const selectFromMock = vi.fn(() => ({ where: selectWhereMock }));
  (db.select as Mock).mockReturnValue({ from: selectFromMock });
}

const makeRequest = (body: Record<string, unknown>) =>
  new Request(`http://localhost:3000/api/calendar/events/${EVENT_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const ctx = (): { params: Promise<{ eventId: string }> } => ({
  params: Promise.resolve({ eventId: EVENT_ID }),
});

describe('PATCH /api/calendar/events/[eventId] agentTrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessfulPatch();
  });

  it('forwards an agentTrigger object to upsertCalendarTriggerWorkflow', async () => {
    const res = await PATCH(makeRequest({
      agentTrigger: {
        agentPageId: 'agent-1',
        prompt: 'Run prep',
        instructionPageId: 'instr-1',
        contextPageIds: ['ctx-a'],
      },
    }), ctx());

    expect(res.status).toBe(200);
    expect(upsertCalendarTriggerWorkflow).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        driveId: DRIVE_ID,
        calendarEventId: EVENT_ID,
        agentTrigger: expect.objectContaining({
          agentPageId: 'agent-1',
          instructionPageId: 'instr-1',
          contextPageIds: ['ctx-a'],
        }),
      }),
    );
    expect(removeCalendarTrigger).not.toHaveBeenCalled();
  });

  it('removes the trigger when agentTrigger is explicitly null', async () => {
    const res = await PATCH(makeRequest({ agentTrigger: null }), ctx());

    expect(res.status).toBe(200);
    expect(removeCalendarTrigger).toHaveBeenCalledWith(db, EVENT_ID);
    expect(upsertCalendarTriggerWorkflow).not.toHaveBeenCalled();
  });

  it('does nothing to triggers when agentTrigger is omitted', async () => {
    const res = await PATCH(makeRequest({ title: 'Renamed' }), ctx());

    expect(res.status).toBe(200);
    expect(upsertCalendarTriggerWorkflow).not.toHaveBeenCalled();
    expect(removeCalendarTrigger).not.toHaveBeenCalled();
  });

  it('rejects an agent-trigger upsert on a personal (driveId=null) event', async () => {
    const personalEvent = { ...baseEvent, driveId: null };
    (db.query.calendarEvents.findFirst as Mock).mockReset();
    (db.query.calendarEvents.findFirst as Mock)
      .mockResolvedValueOnce(personalEvent)
      .mockResolvedValueOnce(personalEvent);

    const res = await PATCH(makeRequest({
      agentTrigger: { agentPageId: 'agent-1', prompt: 'p' },
    }), ctx());

    expect(res.status).toBe(400);
    expect(upsertCalendarTriggerWorkflow).not.toHaveBeenCalled();
  });
});
