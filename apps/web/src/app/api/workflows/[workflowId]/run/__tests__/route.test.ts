import { describe, test, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import type { DriveAccessResult } from '@pagespace/lib/server';

// ============================================================================
// Contract Tests for POST /api/workflows/[workflowId]/run
// ============================================================================

const {
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
  mockSelectWhere,
  mockSelectFrom,
  mockSelect,
} = vi.hoisted(() => ({
  mockUpdateWhere: vi.fn().mockResolvedValue(undefined),
  mockUpdateSet: vi.fn(),
  mockUpdate: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
  },
  workflows: { id: 'id', driveId: 'driveId' },
  eq: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  checkDriveAccess: vi.fn(),
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/workflows/workflow-executor', () => ({
  executeWorkflow: vi.fn(),
}));

vi.mock('@/lib/workflows/cron-utils', () => ({
  getNextRunDate: vi.fn(),
}));

import { POST } from '../../run/route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDriveAccess } from '@pagespace/lib/server';
import { executeWorkflow } from '@/lib/workflows/workflow-executor';
import { getNextRunDate } from '@/lib/workflows/cron-utils';

// ============================================================================
// Fixtures
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createAccessFixture = (overrides: Partial<DriveAccessResult>): DriveAccessResult => ({
  isOwner: overrides.isOwner ?? false,
  isAdmin: overrides.isAdmin ?? false,
  isMember: overrides.isMember ?? false,
  drive: overrides.drive ?? null,
});

const createDriveFixture = (overrides: { id: string; name: string; ownerId?: string }) => ({
  id: overrides.id,
  name: overrides.name,
  slug: overrides.name.toLowerCase(),
  ownerId: overrides.ownerId ?? 'user_123',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  isTrashed: false,
  trashedAt: null,
  drivePrompt: null,
});

const mockWorkflow = {
  id: 'wf_1',
  driveId: 'drive_abc',
  name: 'Test Workflow',
  triggerType: 'cron' as const,
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
  nextRunAt: null,
  createdBy: 'user_123',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

const createContext = (workflowId: string) => ({
  params: Promise.resolve({ workflowId }),
});

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/workflows/[workflowId]/run', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_123'));
    vi.mocked(isAuthError).mockReturnValue(false);
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockResolvedValue([mockWorkflow]);
    vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
      isOwner: true,
      isMember: true,
      drive: createDriveFixture({ id: 'drive_abc', name: 'Test' }),
    }));
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue(undefined);
    vi.mocked(getNextRunDate).mockReturnValue(new Date('2025-06-01T09:00:00Z'));
  });

  test('returns 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

    const request = new Request('https://example.com/api/workflows/wf_1/run', { method: 'POST' });
    const response = await POST(request, createContext('wf_1'));

    expect(response.status).toBe(401);
  });

  test('returns 404 when workflow not found', async () => {
    mockSelectWhere.mockResolvedValue([]);

    const request = new Request('https://example.com/api/workflows/wf_missing/run', { method: 'POST' });
    const response = await POST(request, createContext('wf_missing'));

    expect(response.status).toBe(404);
  });

  test('returns 403 when user is not owner or admin', async () => {
    vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
      isMember: true,
      drive: createDriveFixture({ id: 'drive_abc', name: 'Test', ownerId: 'other' }),
    }));

    const request = new Request('https://example.com/api/workflows/wf_1/run', { method: 'POST' });
    const response = await POST(request, createContext('wf_1'));

    expect(response.status).toBe(403);
  });

  test('returns 409 when workflow is already running', async () => {
    mockSelectWhere.mockResolvedValue([{ ...mockWorkflow, lastRunStatus: 'running' }]);

    const request = new Request('https://example.com/api/workflows/wf_1/run', { method: 'POST' });
    const response = await POST(request, createContext('wf_1'));

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('Workflow is already running');
    expect(executeWorkflow).not.toHaveBeenCalled();
  });

  test('executes workflow and returns success result', async () => {
    vi.mocked(executeWorkflow).mockResolvedValue({
      success: true,
      responseText: 'Report generated',
      toolCallCount: 3,
      durationMs: 5000,
    });

    const request = new Request('https://example.com/api/workflows/wf_1/run', { method: 'POST' });
    const response = await POST(request, createContext('wf_1'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.responseText).toBe('Report generated');
    expect(body.toolCallCount).toBe(3);
    expect(executeWorkflow).toHaveBeenCalledWith(mockWorkflow);
  });

  test('event workflow with stale cronExpression does not compute nextRunAt', async () => {
    const eventWorkflow = {
      ...mockWorkflow,
      triggerType: 'event' as const,
      cronExpression: '0 9 * * 1-5', // stale leftover
    };
    mockSelectWhere.mockResolvedValue([eventWorkflow]);
    vi.mocked(executeWorkflow).mockResolvedValue({
      success: true,
      responseText: 'Done',
      toolCallCount: 0,
      durationMs: 100,
    });

    const request = new Request('https://example.com/api/workflows/wf_1/run', { method: 'POST' });
    await POST(request, createContext('wf_1'));

    expect(getNextRunDate).not.toHaveBeenCalled();
  });

  test('cron workflow computes nextRunAt after execution', async () => {
    vi.mocked(executeWorkflow).mockResolvedValue({
      success: true,
      responseText: 'Done',
      toolCallCount: 0,
      durationMs: 100,
    });

    const request = new Request('https://example.com/api/workflows/wf_1/run', { method: 'POST' });
    await POST(request, createContext('wf_1'));

    expect(getNextRunDate).toHaveBeenCalledWith('0 9 * * 1-5', 'UTC');
  });

  test('returns error details on failed execution', async () => {
    vi.mocked(executeWorkflow).mockResolvedValue({
      success: false,
      durationMs: 1000,
      error: 'Agent crashed',
    });

    const request = new Request('https://example.com/api/workflows/wf_1/run', { method: 'POST' });
    const response = await POST(request, createContext('wf_1'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Agent crashed');
  });
});
