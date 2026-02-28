import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import type { DriveAccessResult } from '@pagespace/lib/server';

// ============================================================================
// Contract Tests for /api/workflows
// ============================================================================

// Hoist mock functions so they're available inside vi.mock factories
const {
  mockReturning,
  mockValues,
  mockInsert,
  mockOrderBy,
  mockWhere,
  mockFrom,
  mockSelect,
} = vi.hoisted(() => ({
  mockReturning: vi.fn().mockResolvedValue([{ id: 'wf_1', name: 'Test' }]),
  mockValues: vi.fn(),
  mockInsert: vi.fn(),
  mockOrderBy: vi.fn().mockResolvedValue([]),
  mockWhere: vi.fn(),
  mockFrom: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  checkDriveAccess: vi.fn(),
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
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
    insert: mockInsert,
  },
  workflows: { driveId: 'driveId', createdAt: 'createdAt' },
  pages: { id: 'id', driveId: 'driveId' },
  eq: vi.fn(),
  and: vi.fn(),
}));

import { GET, POST } from '../route';
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
  orgId: null,
});

// ============================================================================
// GET /api/workflows
// ============================================================================

describe('GET /api/workflows', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    mockValues.mockReturnValue({ returning: mockReturning });
    mockInsert.mockReturnValue({ values: mockValues });
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ orderBy: mockOrderBy });
  });

  it('should return 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

    const request = new Request(`https://example.com/api/workflows?driveId=${mockDriveId}`);
    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  it('should return 400 when driveId is missing', async () => {
    const request = new Request('https://example.com/api/workflows');
    const response = await GET(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('driveId is required');
  });

  it('should return 404 when drive not found', async () => {
    vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({ drive: null }));

    const request = new Request(`https://example.com/api/workflows?driveId=${mockDriveId}`);
    const response = await GET(request);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('Drive not found');
  });

  it('should return 403 when user is not owner or admin', async () => {
    vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
      isMember: true,
      drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: 'other' }),
    }));

    const request = new Request(`https://example.com/api/workflows?driveId=${mockDriveId}`);
    const response = await GET(request);

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('Only drive owners and admins can manage workflows');
  });

  it('should return workflow list on success', async () => {
    const mockWorkflows = [{ id: 'wf_1', name: 'Daily Report' }];
    mockOrderBy.mockResolvedValue(mockWorkflows);
    vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
      isOwner: true,
      isMember: true,
      drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
    }));

    const request = new Request(`https://example.com/api/workflows?driveId=${mockDriveId}`);
    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(mockWorkflows);
  });
});

// ============================================================================
// POST /api/workflows
// ============================================================================

describe('POST /api/workflows', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  const validBody = {
    driveId: mockDriveId,
    name: 'Daily Report',
    agentPageId: 'page_1',
    prompt: 'Generate report',
    cronExpression: '0 9 * * 1-5',
    timezone: 'UTC',
    isEnabled: true,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockResolvedValue([{ id: 'page_1', type: 'AI_CHAT', driveId: mockDriveId }]);
    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockReturnValue({ returning: mockReturning });
    mockReturning.mockResolvedValue([{ id: 'wf_new', name: 'Daily Report' }]);
    vi.mocked(validateTimezone).mockReturnValue({ valid: true });
  });

  it('should return 401 when not authenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

    const request = new Request('https://example.com/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it('should return 400 for invalid input', async () => {
    const request = new Request('https://example.com/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid input');
  });

  it('should return 404 when drive not found', async () => {
    vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({ drive: null }));

    const request = new Request('https://example.com/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    const response = await POST(request);

    expect(response.status).toBe(404);
  });

  it('should return 403 when not owner or admin', async () => {
    vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
      isMember: true,
      drive: createDriveFixture({ id: mockDriveId, name: 'Test', ownerId: 'other' }),
    }));

    const request = new Request('https://example.com/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    const response = await POST(request);

    expect(response.status).toBe(403);
  });

  it('should return 400 when agent page not found', async () => {
    vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
      isOwner: true,
      isMember: true,
      drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
    }));
    mockWhere.mockResolvedValue([]);

    const request = new Request('https://example.com/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Agent page not found in this drive');
  });

  it('should return 400 when agent page is not AI_CHAT', async () => {
    vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
      isOwner: true,
      isMember: true,
      drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
    }));
    mockWhere.mockResolvedValue([{ id: 'page_1', type: 'DOCUMENT', driveId: mockDriveId }]);

    const request = new Request('https://example.com/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Selected page is not an AI agent');
  });

  it('should return 400 for invalid cron expression', async () => {
    vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
      isOwner: true,
      isMember: true,
      drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
    }));
    mockWhere.mockResolvedValue([{ id: 'page_1', type: 'AI_CHAT', driveId: mockDriveId }]);
    vi.mocked(validateCronExpression).mockReturnValue({ valid: false, error: 'Bad syntax' });

    const request = new Request('https://example.com/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    const response = await POST(request);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Invalid cron expression');
  });

  it('should return 201 with created workflow on success', async () => {
    vi.mocked(checkDriveAccess).mockResolvedValue(createAccessFixture({
      isOwner: true,
      isMember: true,
      drive: createDriveFixture({ id: mockDriveId, name: 'Test' }),
    }));
    mockWhere.mockResolvedValue([{ id: 'page_1', type: 'AI_CHAT', driveId: mockDriveId }]);
    vi.mocked(validateCronExpression).mockReturnValue({ valid: true });
    vi.mocked(getNextRunDate).mockReturnValue(new Date('2025-06-01T09:00:00Z'));

    const request = new Request('https://example.com/api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    const response = await POST(request);

    expect(response.status).toBe(201);
  });
});
