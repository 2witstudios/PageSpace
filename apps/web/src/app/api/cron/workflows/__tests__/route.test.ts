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
} = vi.hoisted(() => ({
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
      creditGate: { skipDailyCap: true },
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

  it('given a transient credit refusal inside its retry window, should keep the slot (no nextRunAt advance) so the next tick retries, and not report an error', async () => {
    mockSelectWhere.mockResolvedValue([MOCK_WORKFLOW]);
    vi.mocked(executeWorkflow).mockResolvedValue({
      success: false,
      durationMs: 0,
      error: 'AI credit gate denied: too_many_in_flight',
      retryable: true,
      refusal: { reason: 'too_many_in_flight', kind: 'transient' },
    });

    const response = await POST(new Request('https://example.com/api/cron/workflows', { method: 'POST' }));
    const body = await response.json();

    expect(getNextRunDate).not.toHaveBeenCalled();
    expect(body).toMatchObject({ executed: 0, deferred: 1 });
    expect(body.errors).toBeUndefined();
  });

  it('given the credit gate itself THREW inside the retry window (retryable, no refusal), should keep the slot so the next tick retries it, and not report an error', async () => {
    mockSelectWhere.mockResolvedValue([MOCK_WORKFLOW]);
    vi.mocked(executeWorkflow).mockResolvedValue({
      success: false,
      durationMs: 0,
      error: 'connection terminated unexpectedly',
      retryable: true,
    });

    const response = await POST(new Request('https://example.com/api/cron/workflows', { method: 'POST' }));
    const body = await response.json();

    expect(getNextRunDate).not.toHaveBeenCalled();
    expect(body).toMatchObject({ executed: 0, deferred: 1 });
    expect(body.errors).toBeUndefined();
  });

  it('given a terminal credit refusal, should count it as skipped and advance to the next slot (the workflow stays enabled)', async () => {
    mockSelectWhere.mockResolvedValue([MOCK_WORKFLOW]);
    vi.mocked(executeWorkflow).mockResolvedValue({
      success: false,
      skipped: true,
      durationMs: 0,
      runId: 'run_refused',
      error: 'AI credit gate denied: out_of_credits',
      refusal: { reason: 'out_of_credits', kind: 'terminal' },
    });
    vi.mocked(getNextRunDate).mockReturnValue(new Date('2025-01-02T09:00:00Z'));

    const response = await POST(new Request('https://example.com/api/cron/workflows', { method: 'POST' }));
    const body = await response.json();

    expect(getNextRunDate).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).toHaveBeenCalledWith({ nextRunAt: new Date('2025-01-02T09:00:00Z') });
    expect(mockUpdateSet).not.toHaveBeenCalledWith(expect.objectContaining({ isEnabled: false }));
    expect(body).toMatchObject({ skipped: 1, deferred: 0 });
    expect(body.errors).toBeUndefined();
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
      expect.objectContaining({ eventType: 'data.write', resourceType: 'cron_job', resourceId: 'workflows', details: { executed: 1, deferred: 0, failed: 0, skipped: 0 } })
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

    it('hands the executor only the run input — the executor gates the owner itself, inside its claim, as a scheduled run', async () => {
      await tick();

      const call = vi.mocked(executeWorkflow).mock.calls[0];
      expect(call).toHaveLength(1);
      expect(call[0].createdBy).toBe(MOCK_WORKFLOW.createdBy);
      expect(call[0].creditGate).toEqual({ skipDailyCap: true });
    });

    it('a refused fire advances the schedule and counts as skipped, not as a failure', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue({
        success: false, skipped: true, durationMs: 0, runId: 'run_1', error: 'AI credit gate denied: out_of_credits',
      });

      const body = await tick();

      // Advancing is what stops the next tick re-firing it: no per-minute storm.
      expect(getNextRunDate).toHaveBeenCalledWith(MOCK_WORKFLOW.cronExpression, MOCK_WORKFLOW.timezone);
      expect(body.skipped).toBe(1);
      expect(body.executed).toBe(0);
      expect(body.total).toBe(0);
      expect(body.errors).toBeUndefined();
    });

    it('a fire that lost the claim to an overlapping run is neither skipped nor advanced', async () => {
      vi.mocked(executeWorkflow).mockResolvedValue({
        success: false, claimConflict: true, durationMs: 0, error: 'Workflow already running',
      });

      const body = await tick();

      expect(getNextRunDate).not.toHaveBeenCalled();
      expect(body.skipped).toBe(0);
    });
  });
});
