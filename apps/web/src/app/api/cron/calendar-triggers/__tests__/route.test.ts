import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for /api/cron/calendar-triggers
// ============================================================================

const {
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
  mockSelectWhere,
  mockSelectFrom,
  mockSelect,
  mockSelectOrderBy,
  mockSelectLimit,
  mockExecuteCalendarTrigger,
  mockInsert,
  mockInsertValues,
  mockOnConflictDoNothing,
} = vi.hoisted(() => ({
  mockUpdateWhere: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdate: vi.fn(),
  mockSelectWhere: vi.fn().mockResolvedValue([]),
  mockSelectFrom: vi.fn(),
  mockSelect: vi.fn(),
  mockSelectOrderBy: vi.fn(),
  mockSelectLimit: vi.fn(),
  mockExecuteCalendarTrigger: vi.fn(),
  mockInsert: vi.fn(),
  mockInsertValues: vi.fn(),
  mockOnConflictDoNothing: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@/lib/workflows/calendar-trigger-executor', () => ({
  executeCalendarTrigger: mockExecuteCalendarTrigger,
}));

const mockAudit = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: {
      child: vi.fn(() => ({
        info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
      })),
    },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: mockAudit,
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
    insert: mockInsert,
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  lte: vi.fn(),
  inArray: vi.fn(),
  asc: vi.fn(),
  sql: vi.fn(),
}));
vi.mock('@pagespace/db/schema/calendar', () => ({
  calendarEvents: {
    id: 'id',
  },
}));
vi.mock('@pagespace/db/schema/calendar-triggers', () => ({
  calendarTriggers: {
    id: 'id',
    triggerAt: 'triggerAt',
    calendarEventId: 'calendarEventId',
  },
}));
vi.mock('@pagespace/db/schema/workflow-runs', () => ({
  workflowRuns: {
    id: 'id',
    workflowId: 'workflowId',
    sourceTable: 'sourceTable',
    sourceId: 'sourceId',
    status: 'status',
    startedAt: 'startedAt',
  },
}));

import { POST } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

// ============================================================================
// Fixtures
// ============================================================================

const MOCK_TRIGGER = {
  id: 'trg-1',
  workflowId: 'wf-1',
  calendarEventId: 'evt-1',
  driveId: 'drive-1',
  scheduledById: 'user-123',
  triggerAt: new Date('2026-01-01T09:00:00Z'),
  occurrenceDate: new Date(0),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_EVENT = {
  id: 'evt-1',
  title: 'Deploy check',
  isTrashed: false,
};

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/cron/calendar-triggers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);

    // Default: stuck-run sweeper update returns nothing special
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);

    // Default: cancellation insert chain (used when event is trashed/missing)
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockInsertValues.mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing });
    mockOnConflictDoNothing.mockResolvedValue(undefined);

    // Default: no due triggers found (select chain — discovery query)
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockReturnValue({ orderBy: mockSelectOrderBy });
    mockSelectOrderBy.mockReturnValue({ limit: mockSelectLimit });
    mockSelectLimit.mockResolvedValue([]);
  });

  it('returns auth error when cron request is invalid', async () => {
    const errorResponse = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(errorResponse);

    const request = new Request('https://example.com/api/cron/calendar-triggers', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(403);
  });

  it('returns success with 0 executed when no triggers are due', async () => {
    const request = new Request('https://example.com/api/cron/calendar-triggers', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executed).toBe(0);
    expect(body.message).toContain('No calendar triggers due');
  });

  it('executes due triggers and returns counts', async () => {
    let selectCallCount = 0;
    mockSelect.mockImplementation(() => {
      selectCallCount++;
      return { from: mockSelectFrom };
    });
    mockSelectFrom.mockImplementation(() => {
      if (selectCallCount === 1) {
        // discovery: chained .where().orderBy().limit()
        return { where: mockSelectWhere };
      }
      // events query: select(...).from(events).where()
      return { where: vi.fn().mockResolvedValue([MOCK_EVENT]) };
    });
    mockSelectLimit.mockResolvedValue([MOCK_TRIGGER]);

    mockExecuteCalendarTrigger.mockResolvedValue({ success: true, durationMs: 500 });

    const request = new Request('https://example.com/api/cron/calendar-triggers', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executed).toBe(1);
    expect(body.total).toBe(1);
  });

  it('writes a cancelled run when calendar events are trashed', async () => {
    let selectCallCount = 0;
    mockSelect.mockImplementation(() => {
      selectCallCount++;
      return { from: mockSelectFrom };
    });
    mockSelectFrom.mockImplementation(() => {
      if (selectCallCount === 1) return { where: mockSelectWhere };
      return { where: vi.fn().mockResolvedValue([{ ...MOCK_EVENT, isTrashed: true }]) };
    });
    mockSelectLimit.mockResolvedValue([MOCK_TRIGGER]);

    const request = new Request('https://example.com/api/cron/calendar-triggers', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executed).toBe(0);
    expect(mockExecuteCalendarTrigger).not.toHaveBeenCalled();
    // The cancellation insert was attempted
    expect(mockInsert).toHaveBeenCalled();
    expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      sourceTable: 'calendarTriggers',
      sourceId: MOCK_TRIGGER.id,
      status: 'cancelled',
    }));
  });

  it('handles execution errors gracefully', async () => {
    let selectCallCount = 0;
    mockSelect.mockImplementation(() => {
      selectCallCount++;
      return { from: mockSelectFrom };
    });
    mockSelectFrom.mockImplementation(() => {
      if (selectCallCount === 1) return { where: mockSelectWhere };
      return { where: vi.fn().mockResolvedValue([MOCK_EVENT]) };
    });
    mockSelectLimit.mockResolvedValue([MOCK_TRIGGER]);

    mockExecuteCalendarTrigger.mockResolvedValue({
      success: false,
      durationMs: 100,
      error: 'Rate limited',
    });

    const request = new Request('https://example.com/api/cron/calendar-triggers', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executed).toBe(0);
    expect(body.errors).toBeDefined();
    expect(body.errors[0]).toContain('Rate limited');
  });

  it('skips claim-conflict results without recording an error', async () => {
    let selectCallCount = 0;
    mockSelect.mockImplementation(() => {
      selectCallCount++;
      return { from: mockSelectFrom };
    });
    mockSelectFrom.mockImplementation(() => {
      if (selectCallCount === 1) return { where: mockSelectWhere };
      return { where: vi.fn().mockResolvedValue([MOCK_EVENT]) };
    });
    mockSelectLimit.mockResolvedValue([MOCK_TRIGGER]);

    mockExecuteCalendarTrigger.mockResolvedValue({
      success: false,
      durationMs: 0,
      error: 'Workflow already running',
      claimConflict: true,
    });

    const request = new Request('https://example.com/api/cron/calendar-triggers', { method: 'POST' });
    const response = await POST(request);

    const body = await response.json();
    expect(body.executed).toBe(0);
    expect(body.errors).toBeUndefined();
  });

  it('handles thrown exceptions during trigger execution', async () => {
    let selectCallCount = 0;
    mockSelect.mockImplementation(() => {
      selectCallCount++;
      return { from: mockSelectFrom };
    });
    mockSelectFrom.mockImplementation(() => {
      if (selectCallCount === 1) return { where: mockSelectWhere };
      return { where: vi.fn().mockResolvedValue([MOCK_EVENT]) };
    });
    mockSelectLimit.mockResolvedValue([MOCK_TRIGGER]);

    mockExecuteCalendarTrigger.mockRejectedValue(new Error('Unexpected crash'));

    const request = new Request('https://example.com/api/cron/calendar-triggers', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executed).toBe(0);
    expect(body.errors).toBeDefined();
    expect(body.errors[0]).toContain('Unexpected crash');
  });

  it('logs audit event after trigger execution', async () => {
    let selectCallCount = 0;
    mockSelect.mockImplementation(() => {
      selectCallCount++;
      return { from: mockSelectFrom };
    });
    mockSelectFrom.mockImplementation(() => {
      if (selectCallCount === 1) return { where: mockSelectWhere };
      return { where: vi.fn().mockResolvedValue([MOCK_EVENT]) };
    });
    mockSelectLimit.mockResolvedValue([MOCK_TRIGGER]);

    mockExecuteCalendarTrigger.mockResolvedValue({ success: true, durationMs: 500 });

    const request = new Request('https://example.com/api/cron/calendar-triggers', { method: 'POST' });
    await POST(request);

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'data.write', resourceType: 'cron_job', resourceId: 'calendar_triggers', details: { executed: 1, failed: 0 } })
    );
  });

  it('logs audit event with zero executed when no triggers are due', async () => {
    const request = new Request('https://example.com/api/cron/calendar-triggers', { method: 'POST' });
    await POST(request);

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'data.write', resourceType: 'cron_job', resourceId: 'calendar_triggers', details: { executed: 0, failed: 0 } })
    );
  });

  it('returns 500 on catastrophic error', async () => {
    mockUpdate.mockImplementation(() => {
      throw new Error('Database connection lost');
    });

    const request = new Request('https://example.com/api/cron/calendar-triggers', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(500);
  });
});
