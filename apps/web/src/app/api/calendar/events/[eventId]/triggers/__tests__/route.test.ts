/**
 * Contract tests for /api/calendar/events/[eventId]/triggers
 * (GET / PUT / DELETE) — the calendar twin of /api/tasks/[taskId]/triggers.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

vi.mock('@pagespace/db/db', () => {
  const db = {
    query: { calendarEvents: { findFirst: vi.fn() } },
    select: vi.fn(),
  };
  return { db };
});
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn((...args: unknown[]) => args),
  desc: vi.fn(),
}));
vi.mock('@pagespace/db/schema/calendar', () => ({
  calendarEvents: { id: 'id', driveId: 'driveId', createdById: 'createdById', isTrashed: 'isTrashed' },
  eventAttendees: { eventId: 'eventId', userId: 'userId' },
}));
vi.mock('@pagespace/db/schema/calendar-triggers', () => ({
  calendarTriggers: { id: 'id', calendarEventId: 'calendarEventId', workflowId: 'workflowId', triggerAt: 'triggerAt' },
}));
vi.mock('@pagespace/db/schema/workflows', () => ({
  workflows: { id: 'id', agentPageId: 'agentPageId', prompt: 'prompt', instructionPageId: 'instructionPageId', contextPageIds: 'contextPageIds' },
}));
vi.mock('@pagespace/db/schema/workflow-runs', () => ({
  workflowRuns: { sourceTable: 'sourceTable', sourceId: 'sourceId', startedAt: 'startedAt', endedAt: 'endedAt', status: 'status', error: 'error' },
}));

vi.mock('@/lib/workflows/calendar-trigger-helpers', () => ({
  upsertCalendarTriggerWorkflow: vi.fn().mockResolvedValue({ workflowId: 'wf-1', triggerId: 'trg-1' }),
  removeCalendarTrigger: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => typeof r === 'object' && r !== null && 'error' in r),
  checkMCPDriveScope: vi.fn(() => null),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isDriveOwnerOrAdmin: vi.fn().mockResolvedValue(false),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

vi.mock('@/lib/websocket/calendar-events', () => ({
  broadcastCalendarEvent: vi.fn().mockResolvedValue(undefined),
}));

import { GET, PUT, DELETE } from '../route';
import { db } from '@pagespace/db/db';
import { authenticateRequestWithOptions } from '@/lib/auth';
import {
  upsertCalendarTriggerWorkflow,
  removeCalendarTrigger,
} from '@/lib/workflows/calendar-trigger-helpers';

const USER_ID = 'user_creator';
const OUTSIDER_ID = 'user_outsider';
const EVENT_ID = 'evt-1';
const DRIVE_ID = 'drive-1';

const mockAuth = (uid: string): SessionAuthResult => ({
  userId: uid,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 's',
  role: 'user',
  adminRoleVersion: 0,
});

const baseEvent = {
  id: EVENT_ID,
  driveId: DRIVE_ID as string | null,
  createdById: USER_ID,
  startAt: new Date('2026-06-01T09:00:00Z'),
  timezone: 'UTC',
  isTrashed: false,
};

const ctx = (): { params: Promise<{ eventId: string }> } => ({
  params: Promise.resolve({ eventId: EVENT_ID }),
});

const url = `http://localhost:3000/api/calendar/events/${EVENT_ID}/triggers`;
const mkRequest = (method: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

function setupSelectChainForGet(triggerRow: unknown[], runRow: unknown[]) {
  // First call: trigger row join
  const firstWhere = vi.fn().mockResolvedValue(triggerRow);
  const firstInnerJoin = vi.fn(() => ({ where: firstWhere }));
  const firstFrom = vi.fn(() => ({ innerJoin: firstInnerJoin }));

  // Second call: latest run lookup
  const limit = vi.fn().mockResolvedValue(runRow);
  const orderBy = vi.fn(() => ({ limit }));
  const secondWhere = vi.fn(() => ({ orderBy }));
  const secondFrom = vi.fn(() => ({ where: secondWhere }));

  let calls = 0;
  (db.select as Mock).mockImplementation(() => {
    calls++;
    return calls === 1 ? { from: firstFrom } : { from: secondFrom };
  });
}

describe('GET /api/calendar/events/[eventId]/triggers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuth(USER_ID));
    (db.query.calendarEvents.findFirst as Mock).mockResolvedValue(baseEvent);
  });

  it('returns 404 when the event does not exist', async () => {
    (db.query.calendarEvents.findFirst as Mock).mockResolvedValue(null);
    const res = await GET(mkRequest('GET'), ctx());
    expect(res.status).toBe(404);
  });

  it('returns trigger=null when the event has no trigger', async () => {
    setupSelectChainForGet([], []);
    const res = await GET(mkRequest('GET'), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ trigger: null });
  });

  it('returns the trigger row joined with last-run status', async () => {
    setupSelectChainForGet(
      [{
        id: 'trg-1',
        calendarEventId: EVENT_ID,
        triggerAt: new Date('2026-06-01T09:00:00Z'),
        workflowId: 'wf-1',
        agentPageId: 'agent-1',
        prompt: 'Run prep',
        instructionPageId: 'instr-1',
        contextPageIds: ['ctx-a'],
      }],
      [{
        status: 'success',
        startedAt: new Date('2026-06-01T09:00:01Z'),
        endedAt: new Date('2026-06-01T09:00:05Z'),
        error: null,
      }],
    );

    const res = await GET(mkRequest('GET'), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.trigger).toMatchObject({
      id: 'trg-1',
      agentPageId: 'agent-1',
      instructionPageId: 'instr-1',
      contextPageIds: ['ctx-a'],
      lastRunStatus: 'success',
      lastFireError: null,
    });
    expect(body.trigger.lastFiredAt).toBeTruthy();
  });

  it('returns 403 when an outsider asks (not creator, not admin)', async () => {
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuth(OUTSIDER_ID));
    const res = await GET(mkRequest('GET'), ctx());
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/calendar/events/[eventId]/triggers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuth(USER_ID));
    (db.query.calendarEvents.findFirst as Mock).mockResolvedValue(baseEvent);
    // loadAttendeeIds: empty list by default
    (db.select as Mock).mockReturnValue({
      from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
    });
  });

  it('forwards the validated payload to upsertCalendarTriggerWorkflow', async () => {
    const res = await PUT(mkRequest('PUT', {
      agentPageId: 'agent-1',
      prompt: 'Run prep',
      instructionPageId: 'instr-1',
      contextPageIds: ['ctx-a'],
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
  });

  it('rejects payloads without prompt or instructionPageId', async () => {
    const res = await PUT(mkRequest('PUT', { agentPageId: 'agent-1' }), ctx());
    expect(res.status).toBe(400);
    expect(upsertCalendarTriggerWorkflow).not.toHaveBeenCalled();
  });

  it('rejects more than 10 context pages', async () => {
    const res = await PUT(mkRequest('PUT', {
      agentPageId: 'agent-1',
      prompt: 'p',
      contextPageIds: Array.from({ length: 11 }, (_, i) => `ctx-${i}`),
    }), ctx());
    expect(res.status).toBe(400);
  });

  it('rejects an upsert on a personal event', async () => {
    (db.query.calendarEvents.findFirst as Mock).mockResolvedValue({ ...baseEvent, driveId: null });
    const res = await PUT(mkRequest('PUT', { agentPageId: 'agent-1', prompt: 'p' }), ctx());
    expect(res.status).toBe(400);
    expect(upsertCalendarTriggerWorkflow).not.toHaveBeenCalled();
  });

  it('rejects an upsert on a recurring event', async () => {
    (db.query.calendarEvents.findFirst as Mock).mockResolvedValue({
      ...baseEvent,
      recurrenceRule: { frequency: 'WEEKLY', interval: 1 },
    });
    const res = await PUT(mkRequest('PUT', { agentPageId: 'agent-1', prompt: 'p' }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/recur/i);
    expect(upsertCalendarTriggerWorkflow).not.toHaveBeenCalled();
  });

  it('returns 403 when an outsider asks', async () => {
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuth(OUTSIDER_ID));
    const res = await PUT(mkRequest('PUT', { agentPageId: 'agent-1', prompt: 'p' }), ctx());
    expect(res.status).toBe(403);
  });

  it('returns 400 with the helper message when validation throws', async () => {
    (upsertCalendarTriggerWorkflow as Mock).mockRejectedValueOnce(new Error('Agent must be in the same drive as the event'));
    const res = await PUT(mkRequest('PUT', { agentPageId: 'agent-1', prompt: 'p' }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/same drive/);
  });
});

describe('DELETE /api/calendar/events/[eventId]/triggers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuth(USER_ID));
    (db.query.calendarEvents.findFirst as Mock).mockResolvedValue(baseEvent);
    (db.select as Mock).mockReturnValue({
      from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
    });
  });

  it('calls removeCalendarTrigger', async () => {
    const res = await DELETE(mkRequest('DELETE'), ctx());
    expect(res.status).toBe(200);
    expect(removeCalendarTrigger).toHaveBeenCalledWith(db, EVENT_ID);
  });

  it('returns 403 when an outsider asks', async () => {
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuth(OUTSIDER_ID));
    const res = await DELETE(mkRequest('DELETE'), ctx());
    expect(res.status).toBe(403);
    expect(removeCalendarTrigger).not.toHaveBeenCalled();
  });
});
