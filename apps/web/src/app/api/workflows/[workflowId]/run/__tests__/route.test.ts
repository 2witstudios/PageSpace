import { describe, test, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import type { DriveAccessResult } from '@pagespace/lib/services/drive-member-service';

// ============================================================================
// Contract Tests for POST /api/workflows/[workflowId]/run
// ============================================================================

const {
  mockReturning,
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
  mockSelectWhere,
  mockSelectFrom,
  mockSelect,
  mockCreditAdmission,
} = vi.hoisted(() => ({
  mockCreditAdmission: vi.fn(),
  mockReturning: vi.fn().mockResolvedValue([{ id: 'wf_1' }]),
  mockUpdateWhere: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdate: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
}));
vi.mock('@pagespace/db/schema/workflows', () => ({
  workflows: { id: 'id', driveId: 'driveId' },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  checkDriveAccess: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { warn: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@/lib/workflows/workflow-executor', () => ({
  executeWorkflow: vi.fn(),
}));

vi.mock('@/lib/workflows/cron-utils', () => ({
  getNextRunDate: vi.fn(),
}));

vi.mock('@/lib/workflows/workflow-credit-gate', () => ({
  creditAdmission: mockCreditAdmission,
}));

import { POST } from '../../run/route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDriveAccess } from '@pagespace/lib/services/drive-member-service';
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
  kind: 'STANDARD' as const,
  publishSubdomain: null,
  homePageId: null,
  publishDefaultOgImageUrl: null,
  notFoundPageId: null,
  publishFaviconUrl: null,
  orgId: null,
  orgVisibility: 'OPEN' as const,
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
  eventTriggers: null,
  watchedFolderIds: null,
  eventDebounceSecs: null,
  instructionPageId: null,
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
    mockReturning.mockResolvedValue([]);
    // Default executor result: success. Conflict tests override with claimConflict.
    vi.mocked(executeWorkflow).mockResolvedValue({
      success: true,
      responseText: 'OK',
      toolCallCount: 0,
      durationMs: 1,
    });
    vi.mocked(getNextRunDate).mockReturnValue(new Date('2025-06-01T09:00:00Z'));
    mockCreditAdmission.mockReturnValue(async () => ({ admitted: true, release: () => {} }));
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

  test('returns 409 when executor reports a claim conflict', async () => {
    // The atomic claim is now the workflow_runs partial unique index inside
    // the executor. A peer fire holding the lock surfaces as claimConflict.
    vi.mocked(executeWorkflow).mockResolvedValue({
      success: false,
      durationMs: 0,
      error: 'Workflow already running',
      claimConflict: true,
    });

    const request = new Request('https://example.com/api/workflows/wf_1/run', { method: 'POST' });
    const response = await POST(request, createContext('wf_1'));

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('Workflow is already running');
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
    expect(executeWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: mockWorkflow.id,
      workflowName: mockWorkflow.name,
      driveId: mockWorkflow.driveId,
      createdBy: mockWorkflow.createdBy,
      agentPageId: mockWorkflow.agentPageId,
      prompt: mockWorkflow.prompt,
      timezone: mockWorkflow.timezone,
    }), expect.objectContaining({ admit: expect.any(Function) }));
  });

  test('non-scheduled workflow is treated as not found', async () => {
    const eventWorkflow = {
      ...mockWorkflow,
      triggerType: 'event' as const,
      cronExpression: '0 9 * * 1-5', // stale leftover
    };
    mockSelectWhere.mockResolvedValue([eventWorkflow]);

    const request = new Request('https://example.com/api/workflows/wf_1/run', { method: 'POST' });
    const response = await POST(request, createContext('wf_1'));

    expect(response.status).toBe(404);
    expect(executeWorkflow).not.toHaveBeenCalled();
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

  describe('credit gate', () => {
    const run = () => POST(
      new Request('https://example.com/api/workflows/wf_1/run', { method: 'POST' }),
      createContext('wf_1'),
    );

    // An executor stand-in that consults `admit` the way the real one does
    // (inside its claim): a refusal comes back as a skipped run.
    const executorThatAdmits = () => vi.mocked(executeWorkflow).mockImplementation(async (_input, options) => {
      const admission = await options?.admit?.();
      if (admission && !admission.admitted) {
        return { success: false, skipped: true, durationMs: 0, runId: 'run_1', error: admission.error };
      }
      return { success: true, durationMs: 1 };
    });

    const denyWith = (reason: string) => mockCreditAdmission.mockImplementation(
      (_input: unknown, _mode: unknown, onDenied?: (r: string) => void) => async () => {
        onDenied?.(reason);
        return { admitted: false, error: `AI credit gate denied: ${reason}` };
      },
    );

    test('SPEND-6 (partial) hands the executor the credit gate as its admit hook, gating the drive the workflow runs in (not the clicker) as interactive', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('admin_clicker'));
      const admit = async () => ({ admitted: true as const, release: () => {} });
      mockCreditAdmission.mockReturnValue(admit);

      await run();

      const [input, options] = vi.mocked(executeWorkflow).mock.calls[0];
      expect(options?.admit).toBe(admit);
      expect(mockCreditAdmission).toHaveBeenCalledWith(input, 'interactive', expect.any(Function));
      expect(input.createdBy).toBe('user_123');
      // SPEND-6: the gate is told the drive the run spends; the creator is only who it is recorded against.
      expect(input.driveId).toBe(mockWorkflow.driveId);
    });

    test('out of credits: 402 with a readable error, and the schedule is not advanced', async () => {
      executorThatAdmits();
      denyWith('out_of_credits');

      const response = await run();

      expect(response.status).toBe(402);
      // The Run button toasts `error` verbatim, so it must read as a sentence, not a code.
      const body = await response.json();
      expect(body.code).toBe('out_of_credits');
      expect(body.error).toMatch(/credit balance is too low/);
      expect(getNextRunDate).not.toHaveBeenCalled();
    });

    test('in-flight cap: 429', async () => {
      executorThatAdmits();
      denyWith('too_many_in_flight');

      const response = await run();

      expect(response.status).toBe(429);
    });

    test('an admitted run returns the normal result', async () => {
      executorThatAdmits();

      const response = await run();

      expect(response.status).toBe(200);
      expect((await response.json()).success).toBe(true);
    });
  });
});
