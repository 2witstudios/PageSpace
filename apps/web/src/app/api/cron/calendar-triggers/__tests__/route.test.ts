import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for /api/cron/calendar-triggers
// ============================================================================

const {
  mockReturning,
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
  mockSelectWhere,
  mockSelectFrom,
  mockSelect,
  mockSelectOrderBy,
  mockSelectLimit,
  mockExecuteCalendarTrigger,
} = vi.hoisted(() => ({
  mockReturning: vi.fn().mockResolvedValue([]),
  mockUpdateWhere: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdate: vi.fn(),
  mockSelectWhere: vi.fn().mockResolvedValue([]),
  mockSelectFrom: vi.fn(),
  mockSelect: vi.fn(),
  mockSelectOrderBy: vi.fn(),
  mockSelectLimit: vi.fn(),
  mockExecuteCalendarTrigger: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@/lib/workflows/calendar-trigger-executor', () => ({
  executeCalendarTrigger: mockExecuteCalendarTrigger,
}));

const mockSecurityAudit = vi.hoisted(() => ({
  logDataAccess: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      child: vi.fn(() => ({
        info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
      })),
    },
  },
  securityAudit: mockSecurityAudit,
}));

vi.mock('@pagespace/db', () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
  },
  calendarTriggers: {
    id: 'id',
    status: 'status',
    triggerAt: 'triggerAt',
    startedAt: 'startedAt',
    calendarEventId: 'calendarEventId',
  },
  calendarEvents: {
    id: 'id',
  },
  eq: vi.fn(),
  and: vi.fn(),
  lte: vi.fn(),
  inArray: vi.fn(),
  asc: vi.fn(),
}));

import { POST } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';

// ============================================================================
// Fixtures
// ============================================================================

const MOCK_TRIGGER = {
  id: 'trg-1',
  calendarEventId: 'evt-1',
  agentPageId: 'agent-1',
  driveId: 'drive-1',
  scheduledById: 'user-123',
  prompt: 'Check status',
  status: 'pending',
  triggerAt: new Date('2026-01-01T09:00:00Z'),
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
    mockSecurityAudit.logDataAccess.mockResolvedValue(undefined);

    // Default: stuck trigger reset (update returns nothing special)
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockImplementation(() => {
      const p = Promise.resolve(undefined) as Promise<undefined> & { returning: typeof mockReturning };
      p.returning = mockReturning;
      return p;
    });
    mockReturning.mockResolvedValue([]);

    // Default: no due triggers found (select chain)
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
    // Step 1: due triggers found
    mockSelectLimit.mockResolvedValue([MOCK_TRIGGER]);

    // Step 2: atomic claim returns the trigger
    mockReturning.mockResolvedValueOnce([MOCK_TRIGGER]);

    // Step 3: load events
    // Need a fresh select chain for the events query
    let selectCallCount = 0;
    mockSelect.mockImplementation(() => {
      selectCallCount++;
      return { from: mockSelectFrom };
    });
    mockSelectFrom.mockImplementation(() => {
      if (selectCallCount <= 1) {
        // First: due triggers query
        return { where: mockSelectWhere };
      }
      // Second: events query
      return {
        where: vi.fn().mockResolvedValue([MOCK_EVENT]),
      };
    });

    mockExecuteCalendarTrigger.mockResolvedValue({
      success: true,
      durationMs: 500,
    });

    const request = new Request('https://example.com/api/cron/calendar-triggers', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executed).toBe(1);
    expect(body.total).toBe(1);
  });

  it('cancels triggers whose calendar events are trashed', async () => {
    mockSelectLimit.mockResolvedValue([MOCK_TRIGGER]);
    mockReturning.mockResolvedValueOnce([MOCK_TRIGGER]);

    let selectCallCount = 0;
    mockSelect.mockImplementation(() => {
      selectCallCount++;
      return { from: mockSelectFrom };
    });
    mockSelectFrom.mockImplementation(() => {
      if (selectCallCount <= 1) {
        return { where: mockSelectWhere };
      }
      return {
        where: vi.fn().mockResolvedValue([{ ...MOCK_EVENT, isTrashed: true }]),
      };
    });

    const request = new Request('https://example.com/api/cron/calendar-triggers', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    // Trashed event trigger should not count as executed
    expect(body.executed).toBe(0);
    // Should not call executeCalendarTrigger
    expect(mockExecuteCalendarTrigger).not.toHaveBeenCalled();
  });

  it('handles execution errors gracefully', async () => {
    mockSelectLimit.mockResolvedValue([MOCK_TRIGGER]);
    mockReturning.mockResolvedValueOnce([MOCK_TRIGGER]);

    let selectCallCount = 0;
    mockSelect.mockImplementation(() => {
      selectCallCount++;
      return { from: mockSelectFrom };
    });
    mockSelectFrom.mockImplementation(() => {
      if (selectCallCount <= 1) {
        return { where: mockSelectWhere };
      }
      return {
        where: vi.fn().mockResolvedValue([MOCK_EVENT]),
      };
    });

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

  it('handles thrown exceptions during trigger execution', async () => {
    mockSelectLimit.mockResolvedValue([MOCK_TRIGGER]);
    mockReturning.mockResolvedValueOnce([MOCK_TRIGGER]);

    let selectCallCount = 0;
    mockSelect.mockImplementation(() => {
      selectCallCount++;
      return { from: mockSelectFrom };
    });
    mockSelectFrom.mockImplementation(() => {
      if (selectCallCount <= 1) {
        return { where: mockSelectWhere };
      }
      return {
        where: vi.fn().mockResolvedValue([MOCK_EVENT]),
      };
    });

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
    mockSelectLimit.mockResolvedValue([MOCK_TRIGGER]);
    mockReturning.mockResolvedValueOnce([MOCK_TRIGGER]);

    let selectCallCount = 0;
    mockSelect.mockImplementation(() => {
      selectCallCount++;
      return { from: mockSelectFrom };
    });
    mockSelectFrom.mockImplementation(() => {
      if (selectCallCount <= 1) {
        return { where: mockSelectWhere };
      }
      return {
        where: vi.fn().mockResolvedValue([MOCK_EVENT]),
      };
    });

    mockExecuteCalendarTrigger.mockResolvedValue({ success: true, durationMs: 500 });

    const request = new Request('https://example.com/api/cron/calendar-triggers', { method: 'POST' });
    await POST(request);

    expect(mockSecurityAudit.logDataAccess).toHaveBeenCalledWith(
      'system', 'write', 'cron_job', 'calendar_triggers',
      { executed: 1, failed: 0 }
    );
  });

  it('logs audit event with zero executed when no triggers are due', async () => {
    const request = new Request('https://example.com/api/cron/calendar-triggers', { method: 'POST' });
    await POST(request);

    expect(mockSecurityAudit.logDataAccess).toHaveBeenCalledWith(
      'system', 'write', 'cron_job', 'calendar_triggers',
      { executed: 0, failed: 0 }
    );
  });

  it('returns 500 on catastrophic error', async () => {
    // Make the entire pipeline blow up before any trigger processing
    mockUpdate.mockImplementation(() => {
      throw new Error('Database connection lost');
    });

    const request = new Request('https://example.com/api/cron/calendar-triggers', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(500);
  });
});
