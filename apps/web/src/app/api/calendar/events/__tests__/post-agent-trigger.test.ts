/**
 * Contract test for POST /api/calendar/events agent-trigger context fields.
 *
 * The REST POST path used to throw away instructionPageId and contextPageIds
 * even when the schema accepted them — humans got less than the AI tool did.
 * This test pins the new behavior: both fields make it through validation and
 * land on the createCalendarTriggerWorkflow call so they end up on the linked
 * workflows row.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

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
  createCalendarTriggerWorkflow: vi.fn().mockResolvedValue({ workflowId: 'wf-1', triggerId: 'trg-1' }),
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
import { authenticateRequestWithOptions } from '@/lib/auth';
import {
  createCalendarTriggerWorkflow,
  validateCalendarAgentTrigger,
} from '@/lib/workflows/calendar-trigger-helpers';

const USER_ID = 'user-1';
const DRIVE_ID = 'drive-1';

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

describe('POST /api/calendar/events — agent trigger context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuth());

    // db.transaction passes a tx that captures inserts and returns a created row.
    (db.transaction as Mock).mockImplementation(async (cb: (tx: unknown) => unknown) => {
      const tx = {
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            returning: vi.fn().mockResolvedValue([{ id: 'evt-new', startAt: new Date('2026-06-01T09:00:00Z') }]),
          })),
        })),
        update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
      };
      return cb(tx);
    });

    (db.query.calendarEvents.findFirst as Mock).mockResolvedValue({
      id: 'evt-new',
      driveId: DRIVE_ID,
      createdById: USER_ID,
      title: 'Standup',
      startAt: new Date('2026-06-01T09:00:00Z'),
      endAt: new Date('2026-06-01T10:00:00Z'),
      attendees: [],
    });
  });

  it('forwards agentTrigger.instructionPageId and contextPageIds to createCalendarTriggerWorkflow', async () => {
    const res = await POST(makeRequest({
      driveId: DRIVE_ID,
      title: 'Standup with prep',
      startAt: '2026-06-01T09:00:00Z',
      endAt: '2026-06-01T10:00:00Z',
      timezone: 'UTC',
      agentTrigger: {
        agentPageId: 'agent-1',
        prompt: 'Run standup prep',
        instructionPageId: 'page-instr',
        contextPageIds: ['ctx-a', 'ctx-b'],
      },
    }));

    expect(res.status).toBeLessThan(400);

    expect(validateCalendarAgentTrigger).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        driveId: DRIVE_ID,
        agentTrigger: expect.objectContaining({
          agentPageId: 'agent-1',
          instructionPageId: 'page-instr',
          contextPageIds: ['ctx-a', 'ctx-b'],
        }),
      }),
    );

    expect(createCalendarTriggerWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        driveId: DRIVE_ID,
        agentTrigger: expect.objectContaining({
          instructionPageId: 'page-instr',
          contextPageIds: ['ctx-a', 'ctx-b'],
        }),
      }),
    );
  });

  it('accepts agentTrigger with only an instruction page (no prompt) once schema is loosened', async () => {
    const res = await POST(makeRequest({
      driveId: DRIVE_ID,
      title: 'Doc-driven run',
      startAt: '2026-06-01T09:00:00Z',
      endAt: '2026-06-01T10:00:00Z',
      timezone: 'UTC',
      agentTrigger: {
        agentPageId: 'agent-1',
        instructionPageId: 'page-instr',
      },
    }));

    expect(res.status).toBeLessThan(400);
    expect(validateCalendarAgentTrigger).toHaveBeenCalled();
  });
});
