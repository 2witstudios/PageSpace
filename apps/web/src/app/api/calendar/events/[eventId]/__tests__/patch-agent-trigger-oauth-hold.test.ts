/**
 * Agent triggers are held from OAuth applications (point-guard ruling, pending
 * Phase 2b / [D-15]): PATCH /api/calendar/events/[eventId] refuses an OAuth
 * principal's `agentTrigger` — set OR clear — with a constant 403 before any
 * write; the rest of the route stays at mcp parity, mcp_ keys unchanged.
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
  upsertCalendarTriggerWorkflowInTx: vi.fn().mockResolvedValue({ workflowId: 'wf-1', triggerId: 'trg-1' }),
  removeCalendarTrigger: vi.fn().mockResolvedValue(undefined),
  validateCalendarAgentTrigger: vi.fn().mockResolvedValue({ agentPageId: 'agent-1' }),
  resyncCalendarTriggerTimings: vi.fn().mockResolvedValue(undefined),
}));

// timestamp-utils is pure and cheap; these cases all pass absolute (Z) datetimes,
// so the real parser is used rather than a stub that would have to fake the
// naive-datetime rule.

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isUserDriveMember: vi.fn(),
  isDriveOwnerOrAdmin: vi.fn(),
}));

vi.mock('@pagespace/lib/services/calendar-event-drive-service', () => ({
  isUserMemberOfAnyEventDrive: vi.fn().mockResolvedValue(false),
  getAllDriveIdsForEvent: vi.fn().mockResolvedValue([]),
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
  // The personal-event rule (personal-event-scope.ts) asks whether the caller is an OAuth application.
  isScopedOAuthAuth: (auth: { tokenType?: string; scopes?: { account?: boolean } }) => auth?.tokenType === 'oauth' && !auth.scopes?.account,
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => typeof r === 'object' && r !== null && 'error' in r),
  checkMCPDriveScope: vi.fn(() => null),
  isDriveScopedPrincipal: (auth: { tokenType?: string; allowedDriveIds?: string[] }) =>
    auth?.tokenType === 'mcp' && ((auth.allowedDriveIds?.length ?? 0) > 0),
  // Session auth falls through to the user-level checks.
  isPrincipalDriveMember: vi.fn(async (auth: { userId: string }, driveId: string) => {
    const { isUserDriveMember } = await import('@pagespace/lib/permissions/permissions');
    return isUserDriveMember(auth.userId, driveId);
  }),
  isPrincipalDriveOwnerOrAdmin: vi.fn(async (auth: { userId: string }, driveId: string) => {
    const { isDriveOwnerOrAdmin } = await import('@pagespace/lib/permissions/permissions');
    return isDriveOwnerOrAdmin(auth.userId, driveId);
  }),
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
  upsertCalendarTriggerWorkflowInTx,
  removeCalendarTrigger,
} from '@/lib/workflows/calendar-trigger-helpers';

import { mcpDriveKey, oauthDriveGrant, PARITY_USER_ID } from '@/lib/auth/__tests__/oauth-principal-fixture';

const USER_ID = PARITY_USER_ID;
const EVENT_ID = 'event_123';
const DRIVE_ID = 'drive_456';
const HELD = { error: 'Agent triggers are not available to OAuth applications' };

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
  (db.query.calendarEvents.findFirst as Mock)
    .mockResolvedValueOnce(baseEvent)
    .mockResolvedValueOnce(baseEvent);

  const returningMock = vi.fn().mockResolvedValue([baseEvent]);
  const whereMock = vi.fn(() => ({ returning: returningMock }));
  const setMock = vi.fn(() => ({ where: whereMock }));
  (db.update as Mock).mockReturnValue({ set: setMock });

  const selectWhereMock = vi.fn().mockResolvedValue([]);
  const selectFromMock = vi.fn(() => ({ where: selectWhereMock }));
  (db.select as Mock).mockReturnValue({ from: selectFromMock });

  // tx exposes the same select/update so the in-tx remove/upsert helpers
  // and the trigger-time re-aim sweep all chain through the same mocks.
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

const ctx = (): { params: Promise<{ eventId: string }> } => ({
  params: Promise.resolve({ eventId: EVENT_ID }),
});

describe('PATCH /api/calendar/events/[eventId] — agent triggers held from OAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupSuccessfulPatch();
  });

  for (const [label, agentTrigger] of [
    ['setting', { agentPageId: 'agent-1', prompt: 'Run prep' }],
    ['clearing', null],
  ] as const) {
    it(`refuses a drive:X:admin OAuth grant ${label} an agentTrigger — nothing written`, async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue(oauthDriveGrant(DRIVE_ID, 'admin'));
      const res = await PATCH(makeRequest({ title: 'Renamed', agentTrigger }), ctx());
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(HELD);
      expect(db.transaction).not.toHaveBeenCalled();
      expect(upsertCalendarTriggerWorkflowInTx).not.toHaveBeenCalled();
      expect(removeCalendarTrigger).not.toHaveBeenCalled();
    });
  }

  it('applies the same edit without an agentTrigger (parity)', async () => {
    (authenticateRequestWithOptions as Mock).mockResolvedValue(oauthDriveGrant(DRIVE_ID, 'admin'));
    const res = await PATCH(makeRequest({ title: 'Renamed' }), ctx());
    expect(res.status).toBe(200);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('leaves a drive-scoped mcp_ key setting an agentTrigger unchanged', async () => {
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mcpDriveKey(DRIVE_ID));
    const res = await PATCH(makeRequest({ agentTrigger: { agentPageId: 'agent-1', prompt: 'Run prep' } }), ctx());
    expect(res.status).toBe(200);
    expect(upsertCalendarTriggerWorkflowInTx).toHaveBeenCalledTimes(1);
  });
});
