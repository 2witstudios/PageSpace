import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for /api/cron/workflows
// ============================================================================

const {
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
  mockSelectWhere,
  mockSelectFrom,
  mockSelect,
  mockAcquireHold,
  mockReleaseHold,
  mockRecordSkip,
} = vi.hoisted(() => ({
  mockAcquireHold: vi.fn(),
  mockReleaseHold: vi.fn(),
  mockRecordSkip: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdate: vi.fn(),
  mockSelectWhere: vi.fn().mockResolvedValue([]),
  mockSelectFrom: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@/lib/workflows/workflow-executor', () => ({
  executeWorkflow: vi.fn(),
}));

vi.mock('@/lib/workflows/cron-utils', () => ({
  getNextRunDate: vi.fn(),
}));

vi.mock('@/lib/workflows/workflow-credit-gate', () => ({
  acquireWorkflowCreditHold: mockAcquireHold,
  recordCreditSkippedRun: mockRecordSkip,
  creditDeniedError: (reason: string) => `AI credit gate denied: ${reason}`,
}));

const mockAudit = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
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
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  lte: vi.fn(),
  sql: vi.fn(),
}));
vi.mock('@pagespace/db/schema/workflows', () => ({
  workflows: {
    id: 'id',
    isEnabled: 'isEnabled',
    nextRunAt: 'nextRunAt',
    triggerType: 'triggerType',
  },
}));
vi.mock('@pagespace/db/schema/workflow-runs', () => ({
  workflowRuns: {
    id: 'id',
    workflowId: 'workflowId',
    status: 'status',
    startedAt: 'startedAt',
  },
}));

import { POST } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { executeWorkflow } from '@/lib/workflows/workflow-executor';
import { getNextRunDate } from '@/lib/workflows/cron-utils';

// ============================================================================
// Fixtures
// ============================================================================

const MOCK_WORKFLOW = {
  id: 'wf_1',
  driveId: 'drive_abc',
  name: 'Daily Report',
  triggerType: 'cron' as const,
  cronExpression: '0 9 * * 1-5',
  timezone: 'UTC',
  isEnabled: true,
  agentPageId: 'page_1',
  prompt: 'Generate report',
  contextPageIds: [],
  eventTriggers: null,
  watchedFolderIds: null,
  eventDebounceSecs: null,
  instructionPageId: null,
  nextRunAt: new Date('2025-01-01T09:00:00Z'),
  createdBy: 'user_123',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

// ============================================================================
// POST /api/cron/workflows
// ============================================================================

describe('POST /api/cron/workflows', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);

    // db.select().from(workflows).where(...) — discovery query
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockResolvedValue([]);

    // db.update(workflows | workflowRuns).set(...).where(...) — stuck-run sweep + advance nextRunAt
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);

    mockAcquireHold.mockResolvedValue({ allowed: true, release: mockReleaseHold });
    mockRecordSkip.mockResolvedValue(undefined);
  });

  it('should return auth error when cron request is invalid', async () => {
    const errorResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(errorResponse);

    const request = new Request('https://example.com/api/cron/workflows', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it('should return success with 0 executed when no workflows are due', async () => {
    // mockSelectWhere defaults to [] — no due workflows discovered

    const request = new Request('https://example.com/api/cron/workflows', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executed).toBe(0);
    expect(body.message).toBe('No workflows due');
  });

  it('should execute due workflows and return counts', async () => {
    mockSelectWhere.mockResolvedValue([MOCK_WORKFLOW]);
    vi.mocked(executeWorkflow).mockResolvedValue({
      success: true,
      responseText: 'Report generated',
      toolCallCount: 2,
      durationMs: 5000,
    });
    vi.mocked(getNextRunDate).mockReturnValue(new Date('2025-01-02T09:00:00Z'));

    const request = new Request('https://example.com/api/cron/workflows', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executed).toBe(1);
    expect(body.total).toBe(1);
    expect(executeWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: MOCK_WORKFLOW.id,
      workflowName: MOCK_WORKFLOW.name,
      driveId: MOCK_WORKFLOW.driveId,
      createdBy: MOCK_WORKFLOW.createdBy,
      agentPageId: MOCK_WORKFLOW.agentPageId,
      prompt: MOCK_WORKFLOW.prompt,
      timezone: MOCK_WORKFLOW.timezone,
      source: { table: 'cron', id: null, triggerAt: MOCK_WORKFLOW.nextRunAt },
    }));
  });

  it('should not advance nextRunAt when the executor reports a claim conflict', async () => {
    mockSelectWhere.mockResolvedValue([MOCK_WORKFLOW]);
    vi.mocked(executeWorkflow).mockResolvedValue({
      success: false,
      durationMs: 0,
      error: 'Workflow already running',
      claimConflict: true,
    });
    vi.mocked(getNextRunDate).mockReturnValue(new Date('2025-01-02T09:00:00Z'));

    const request = new Request('https://example.com/api/cron/workflows', { method: 'POST' });
    const response = await POST(request);

    const body = await response.json();
    expect(body.executed).toBe(0);
    expect(body.total).toBe(0);
    // Stuck-run sweep is the only update call; no nextRunAt advancement.
    expect(getNextRunDate).not.toHaveBeenCalled();
  });

  it('should handle workflow execution errors gracefully', async () => {
    mockSelectWhere.mockResolvedValue([MOCK_WORKFLOW]);
    vi.mocked(executeWorkflow).mockResolvedValue({
      success: false,
      durationMs: 1000,
      error: 'Agent failed',
    });
    vi.mocked(getNextRunDate).mockReturnValue(new Date('2025-01-02T09:00:00Z'));

    const request = new Request('https://example.com/api/cron/workflows', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executed).toBe(0);
    expect(body.errors).toBeDefined();
    expect(body.errors[0]).toContain('Agent failed');
  });

  it('should log audit event after workflow execution', async () => {
    mockSelectWhere.mockResolvedValue([MOCK_WORKFLOW]);
    vi.mocked(executeWorkflow).mockResolvedValue({
      success: true,
      responseText: 'Report generated',
      toolCallCount: 2,
      durationMs: 5000,
    });
    vi.mocked(getNextRunDate).mockReturnValue(new Date('2025-01-02T09:00:00Z'));

    const request = new Request('https://example.com/api/cron/workflows', { method: 'POST' });
    await POST(request);

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'data.write', resourceType: 'cron_job', resourceId: 'workflows', details: { executed: 1, failed: 0, skipped: 0 } })
    );
    expect(mockAudit).not.toHaveBeenCalledWith(expect.objectContaining({ userId: expect.anything() }));
  });

  it('should log audit event with zero executed when no workflows are due', async () => {
    const request = new Request('https://example.com/api/cron/workflows', { method: 'POST' });
    await POST(request);

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'data.write', resourceType: 'cron_job', resourceId: 'workflows', details: { executed: 0, failed: 0 } })
    );
    expect(mockAudit).not.toHaveBeenCalledWith(expect.objectContaining({ userId: expect.anything() }));
  });

  it('sweeps stuck workflow_runs (status=running, startedAt < cutoff) before discovery', async () => {
    // Stuck-run sweep is the very first thing the route does on each tick.
    const request = new Request('https://example.com/api/cron/workflows', { method: 'POST' });
    await POST(request);

    // First update call is the sweep — set status='error' with the timeout error message.
    expect(mockUpdateSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      endedAt: expect.any(Date),
      error: expect.stringContaining('timed out'),
    }));
  });

  it('should handle thrown exceptions during execution', async () => {
    mockSelectWhere.mockResolvedValue([MOCK_WORKFLOW]);
    vi.mocked(executeWorkflow).mockRejectedValue(new Error('Network error'));
    vi.mocked(getNextRunDate).mockReturnValue(new Date('2025-01-02T09:00:00Z'));

    const request = new Request('https://example.com/api/cron/workflows', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executed).toBe(0);
    expect(body.errors).toBeDefined();
    expect(body.errors[0]).toContain('Network error');
  });

  describe('credit gate', () => {
    const tick = async () => {
      const response = await POST(new Request('https://example.com/api/cron/workflows', { method: 'POST' }));
      return response.json();
    };

    beforeEach(() => {
      mockSelectWhere.mockResolvedValue([MOCK_WORKFLOW]);
      vi.mocked(getNextRunDate).mockReturnValue(new Date('2025-01-02T09:00:00Z'));
      vi.mocked(executeWorkflow).mockResolvedValue({ success: true, durationMs: 1 });
    });

    it('gates the workflow owner as a scheduled run before executing', async () => {
      await tick();

      expect(mockAcquireHold).toHaveBeenCalledWith(
        MOCK_WORKFLOW.createdBy,
        { steps: undefined, prompt: MOCK_WORKFLOW.prompt, agentPageId: MOCK_WORKFLOW.agentPageId },
        'scheduled',
      );
      expect(mockAcquireHold.mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(executeWorkflow).mock.invocationCallOrder[0]);
    });

    it('out of credits: never runs, records a skipped run, advances the schedule, reports no failure', async () => {
      mockAcquireHold.mockResolvedValue({ allowed: false, reason: 'out_of_credits' });

      const body = await tick();

      expect(executeWorkflow).not.toHaveBeenCalled();
      expect(mockRecordSkip).toHaveBeenCalledWith({
        workflowId: MOCK_WORKFLOW.id,
        source: { table: 'cron', id: null, triggerAt: MOCK_WORKFLOW.nextRunAt },
        reason: 'out_of_credits',
      });
      // Advancing is what stops the next tick re-firing it: no per-minute storm.
      expect(getNextRunDate).toHaveBeenCalledWith(MOCK_WORKFLOW.cronExpression, MOCK_WORKFLOW.timezone);
      expect(body.skipped).toBe(1);
      expect(body.executed).toBe(0);
      expect(body.total).toBe(0);
      expect(body.errors).toBeUndefined();
    });

    it('releases the hold exactly once, after the run settles', async () => {
      await tick();

      expect(mockReleaseHold).toHaveBeenCalledTimes(1);
      expect(vi.mocked(executeWorkflow).mock.invocationCallOrder[0])
        .toBeLessThan(mockReleaseHold.mock.invocationCallOrder[0]);
    });

    it('releases the hold when the executor throws', async () => {
      vi.mocked(executeWorkflow).mockRejectedValue(new Error('Network error'));

      await tick();

      expect(mockReleaseHold).toHaveBeenCalledTimes(1);
    });
  });
});
