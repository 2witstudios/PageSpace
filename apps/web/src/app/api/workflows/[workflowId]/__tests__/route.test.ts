import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import type { DriveAccessResult } from '@pagespace/lib/server';

// ============================================================================
// Contract Tests for /api/workflows/[workflowId]
// ============================================================================

const {
  mockReturning,
  mockUpdateSetWhere,
  mockUpdateSet,
  mockUpdate,
  mockDeleteWhere,
  mockDelete,
  mockSelectWhere,
  mockSelectFrom,
  mockSelect,
} = vi.hoisted(() => ({
  mockReturning: vi.fn().mockResolvedValue([{ id: 'wf_1', name: 'Updated' }]),
  mockUpdateSetWhere: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdate: vi.fn(),
  mockDeleteWhere: vi.fn().mockResolvedValue(undefined),
  mockDelete: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockSelectFrom: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  checkDriveAccess: vi.fn(),
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { warn: vi.fn() },
  },
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@/lib/workflows/cron-utils', () => ({
  validateCronExpression: vi.fn(),
  validateTimezone: vi.fn().mockReturnValue({ valid: true }),
  getNextRunDate: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
    delete: mockDelete,
  },
  workflows: { id: 'id', driveId: 'driveId' },
  pages: { id: 'id', driveId: 'driveId' },
  eq: vi.fn(),
  and: vi.fn(),
}));

import { GET, PATCH, DELETE } from '../route';
import { checkDriveAccess } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { validateCronExpression, validateTimezone, getNextRunDate } from '@/lib/workflows/cron-utils';

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
  prompt: 'Test',
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
// GET /api/workflows/[workflowId]
// ============================================================================

describe('GET /api/workflows/[workflowId]', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
  });

  it('should return 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

    const request = new Request('https://example.com/api/workflows/wf_1');
    const response = await GET(request, createContext('wf_1'));

    expect(response!.status).toBe(401);
  });

  it('should return 404 when workflow not found', async () => {
    mockSelectWhere.mockResolvedValue([]);

    const request = new Request('https://example.com/api/workflows/wf_missing');
    const response = await GET(request, createContext('wf_missing'));

    expect(response!.status).toBe(404);
  });

  it('should return 403 when user is not owner or admin', async () => {
    mockSelectWhere.mockResolvedValue([mockWorkflow]);
    vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
      isMember: true,
      drive: createDriveFixture({ id: 'drive_abc', name: 'Test', ownerId: 'other' }),
    }));

    const request = new Request('https://example.com/api/workflows/wf_1');
    const response = await GET(request, createContext('wf_1'));

    expect(response!.status).toBe(403);
  });

  it('should return workflow on success', async () => {
    mockSelectWhere.mockResolvedValue([mockWorkflow]);
    vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
      isOwner: true,
      isMember: true,
      drive: createDriveFixture({ id: 'drive_abc', name: 'Test' }),
    }));

    const request = new Request('https://example.com/api/workflows/wf_1');
    const response = await GET(request, createContext('wf_1'));

    expect(response!.status).toBe(200);
  });
});

// ============================================================================
// PATCH /api/workflows/[workflowId]
// ============================================================================

describe('PATCH /api/workflows/[workflowId]', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockResolvedValue([mockWorkflow]);
    vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
      isOwner: true,
      isMember: true,
      drive: createDriveFixture({ id: 'drive_abc', name: 'Test' }),
    }));
    vi.mocked(validateCronExpression).mockReturnValue({ valid: true });
    vi.mocked(validateTimezone).mockReturnValue({ valid: true });
    vi.mocked(getNextRunDate).mockReturnValue(new Date('2025-06-01T09:00:00Z'));
    mockUpdateSetWhere.mockReturnValue({ returning: mockReturning });
    mockUpdateSet.mockReturnValue({ where: mockUpdateSetWhere });
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockReturning.mockResolvedValue([{ ...mockWorkflow, name: 'Updated' }]);
  });

  it('should return 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

    const request = new Request('https://example.com/api/workflows/wf_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' }),
    });
    const response = await PATCH(request, createContext('wf_1'));

    expect(response!.status).toBe(401);
  });

  it('should return 404 when workflow not found', async () => {
    mockSelectWhere.mockResolvedValue([]);

    const request = new Request('https://example.com/api/workflows/wf_missing', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' }),
    });
    const response = await PATCH(request, createContext('wf_missing'));

    expect(response!.status).toBe(404);
  });

  it('should return 403 when user is not owner or admin', async () => {
    mockSelectWhere.mockResolvedValue([mockWorkflow]);
    vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
      isMember: true,
      drive: createDriveFixture({ id: 'drive_abc', name: 'Test', ownerId: 'other' }),
    }));

    const request = new Request('https://example.com/api/workflows/wf_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' }),
    });
    const response = await PATCH(request, createContext('wf_1'));

    expect(response!.status).toBe(403);
  });

  it('should return 400 when setting cronExpression to null on a cron workflow', async () => {
    const request = new Request('https://example.com/api/workflows/wf_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cronExpression: null }),
    });
    const response = await PATCH(request, createContext('wf_1'));

    expect(response!.status).toBe(400);
    const body = await response!.json();
    expect(body.error).toContain('cron expression');
  });

  it('should return 400 when setting eventTriggers to null on an event workflow', async () => {
    const eventWorkflow = { ...mockWorkflow, triggerType: 'event' as const, eventTriggers: [{ operation: 'update', resourceType: 'page' }] };
    mockSelectWhere.mockResolvedValue([eventWorkflow]);

    const request = new Request('https://example.com/api/workflows/wf_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventTriggers: null }),
    });
    const response = await PATCH(request, createContext('wf_1'));

    expect(response!.status).toBe(400);
    const body = await response!.json();
    expect(body.error).toContain('event trigger');
  });

  it('should return updated workflow on success', async () => {
    const request = new Request('https://example.com/api/workflows/wf_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Name' }),
    });
    const response = await PATCH(request, createContext('wf_1'));

    expect(response!.status).toBe(200);
  });
});

// ============================================================================
// DELETE /api/workflows/[workflowId]
// ============================================================================

describe('DELETE /api/workflows/[workflowId]', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere.mockResolvedValue([mockWorkflow]);
    vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
      isOwner: true,
      isMember: true,
      drive: createDriveFixture({ id: 'drive_abc', name: 'Test' }),
    }));
    mockDelete.mockReturnValue({ where: mockDeleteWhere });
    mockDeleteWhere.mockResolvedValue(undefined);
  });

  it('should return 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

    const request = new Request('https://example.com/api/workflows/wf_1', { method: 'DELETE' });
    const response = await DELETE(request, createContext('wf_1'));

    expect(response!.status).toBe(401);
  });

  it('should return 404 when workflow not found', async () => {
    mockSelectWhere.mockResolvedValue([]);

    const request = new Request('https://example.com/api/workflows/wf_1', { method: 'DELETE' });
    const response = await DELETE(request, createContext('wf_1'));

    expect(response!.status).toBe(404);
  });

  it('should return 403 when user is not owner or admin', async () => {
    vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
      isMember: true,
      drive: createDriveFixture({ id: 'drive_abc', name: 'Test', ownerId: 'other' }),
    }));

    const request = new Request('https://example.com/api/workflows/wf_1', { method: 'DELETE' });
    const response = await DELETE(request, createContext('wf_1'));

    expect(response!.status).toBe(403);
  });

  it('should return success on delete', async () => {
    const request = new Request('https://example.com/api/workflows/wf_1', { method: 'DELETE' });
    const response = await DELETE(request, createContext('wf_1'));

    expect(response!.status).toBe(200);
    const body = await response!.json();
    expect(body.success).toBe(true);
  });
});
