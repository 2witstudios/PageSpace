import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// ============================================================================
// Contract Tests for /api/cron/workflows
// ============================================================================

const {
  mockReturning,
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
} = vi.hoisted(() => ({
  mockReturning: vi.fn().mockResolvedValue([]),
  mockUpdateWhere: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdate: vi.fn(),
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

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/db', () => ({
  db: {
    update: mockUpdate,
  },
  workflows: {
    id: 'id',
    isEnabled: 'isEnabled',
    nextRunAt: 'nextRunAt',
    lastRunStatus: 'lastRunStatus',
    lastRunAt: 'lastRunAt',
    triggerType: 'triggerType',
  },
  eq: vi.fn(),
  and: vi.fn(),
  lte: vi.fn(),
  ne: vi.fn(),
}));

import { POST } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { executeWorkflow } from '@/lib/workflows/workflow-executor';
import { getNextRunDate } from '@/lib/workflows/cron-utils';

// ============================================================================
// Fixtures
// ============================================================================

const mockWorkflow = {
  id: 'wf_1',
  driveId: 'drive_abc',
  name: 'Daily Report',
  cronExpression: '0 9 * * 1-5',
  timezone: 'UTC',
  isEnabled: true,
  agentPageId: 'page_1',
  prompt: 'Generate report',
  contextPageIds: [],
  lastRunStatus: 'never_run',
  lastRunAt: null,
  lastRunError: null,
  lastRunDurationMs: null,
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
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    // mockUpdateWhere must work as both a thenable (await for non-returning calls)
    // and an object with .returning() (for atomic claim). We achieve this by
    // making it return a promise-like that also has a returning property.
    mockUpdateWhere.mockImplementation(() => {
      const p = Promise.resolve(undefined) as Promise<undefined> & { returning: typeof mockReturning };
      p.returning = mockReturning;
      return p;
    });
    mockReturning.mockResolvedValue([]);
  });

  it('should return auth error when cron request is invalid', async () => {
    const errorResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(errorResponse);

    const request = new Request('https://example.com/api/cron/workflows', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it('should return success with 0 executed when no workflows are due', async () => {
    // mockReturning defaults to [] — no due workflows claimed

    const request = new Request('https://example.com/api/cron/workflows', { method: 'POST' });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.executed).toBe(0);
    expect(body.message).toBe('No workflows due');
  });

  it('should execute due workflows and return counts', async () => {
    mockReturning.mockResolvedValue([mockWorkflow]);
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
    expect(executeWorkflow).toHaveBeenCalledWith(mockWorkflow);
  });

  it('should handle workflow execution errors gracefully', async () => {
    mockReturning.mockResolvedValue([mockWorkflow]);
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

  it('should handle thrown exceptions during execution', async () => {
    mockReturning.mockResolvedValue([mockWorkflow]);
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
});
