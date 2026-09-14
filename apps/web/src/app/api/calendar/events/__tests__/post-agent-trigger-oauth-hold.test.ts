/**
 * Agent triggers are held from OAuth applications (point-guard ruling, pending
 * Phase 2b / [D-15]): POST /api/calendar/events refuses an OAuth principal's
 * `agentTrigger` with a constant 403 before anything is written, while the
 * rest of the route stays at mcp parity and mcp_ keys are unchanged.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return { ...actual, after: vi.fn((fn) => fn()) };
});

vi.mock('@pagespace/db/db', () => {
  const txStub = {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: 'evt-new' }]),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
  };
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
  // POST route uses upsertCalendarTriggerWorkflowInTx (not createCalendarTriggerWorkflow)
  // since recurring and one-shot events share the same upsert path in this branch.
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

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => typeof r === 'object' && r !== null && 'error' in r),
  checkMCPDriveScope: vi.fn(() => null),
  checkMCPCreateScope: vi.fn(() => null),
  filterDrivesByMCPScope: vi.fn((_: unknown, ids: string[]) => ids),
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

// timestamp-utils is pure and cheap; these cases all pass absolute (Z) datetimes,
// so the real parser is used rather than a stub that would have to fake the
// naive-datetime rule.

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
import { authenticateRequestWithOptions } from '@/lib/auth';
import {
  upsertCalendarTriggerWorkflowInTx,
  validateCalendarAgentTrigger,
} from '@/lib/workflows/calendar-trigger-helpers';

import { mcpDriveKey, oauthDriveGrant, PARITY_USER_ID } from '@/lib/auth/__tests__/oauth-principal-fixture';

const DRIVE_ID = 'drive-1';
const HELD = { error: 'Agent triggers are not available to OAuth applications' };

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost:3000/api/calendar/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const eventBody = {
  driveId: DRIVE_ID,
  title: 'Standup',
  startAt: '2026-06-01T09:00:00Z',
  endAt: '2026-06-01T10:00:00Z',
  timezone: 'UTC',
};
const agentTrigger = { agentPageId: 'agent-1', prompt: 'Run standup prep' };

describe('POST /api/calendar/events — agent triggers held from OAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.transaction as Mock).mockImplementation(async (cb: (tx: unknown) => unknown) => cb({
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: 'evt-new', startAt: new Date('2026-06-01T09:00:00Z') }]) })) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
    }));
    (db.query.calendarEvents.findFirst as Mock).mockResolvedValue({
      id: 'evt-new', driveId: DRIVE_ID, createdById: PARITY_USER_ID, title: 'Standup',
      startAt: new Date('2026-06-01T09:00:00Z'), endAt: new Date('2026-06-01T10:00:00Z'), attendees: [],
    });
  });

  it('refuses a drive:X:admin OAuth grant creating an event with an agentTrigger — nothing persisted', async () => {
    (authenticateRequestWithOptions as Mock).mockResolvedValue(oauthDriveGrant(DRIVE_ID, 'admin'));
    const res = await POST(makeRequest({ ...eventBody, agentTrigger }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(HELD);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(validateCalendarAgentTrigger).not.toHaveBeenCalled();
    expect(upsertCalendarTriggerWorkflowInTx).not.toHaveBeenCalled();
  });

  it('creates the same event without the agentTrigger (the rest of the route stays at parity)', async () => {
    (authenticateRequestWithOptions as Mock).mockResolvedValue(oauthDriveGrant(DRIVE_ID, 'admin'));
    const res = await POST(makeRequest(eventBody));
    expect(res.status).toBe(201);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('leaves a drive-scoped mcp_ key creating an agentTrigger unchanged', async () => {
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mcpDriveKey(DRIVE_ID));
    const res = await POST(makeRequest({ ...eventBody, agentTrigger }));
    expect(res.status).toBe(201);
    expect(upsertCalendarTriggerWorkflowInTx).toHaveBeenCalledTimes(1);
  });
});
