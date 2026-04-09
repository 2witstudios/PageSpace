import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AdminValidationResult } from '@/lib/auth/admin-role';

// Mock auth internals that withAdminAuth depends on (same paths auth.ts imports from)
vi.mock('@/lib/auth/index', () => ({
  authenticateSessionRequest: vi.fn(),
  isAuthError: vi.fn((result: Record<string, unknown>) => 'error' in result),
}));

vi.mock('@/lib/auth/admin-role', () => ({
  validateAdminAccess: vi.fn(),
}));

vi.mock('@/lib/auth/csrf-validation', () => ({
  validateCSRF: vi.fn().mockResolvedValue(null),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    auth: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  },
  logSecurityEvent: vi.fn(),
  securityAudit: {
    logDataAccess: vi.fn().mockResolvedValue(undefined),
    logEvent: vi.fn().mockResolvedValue(undefined),
    logAccessDenied: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockCollectAllUserData = vi.fn();
vi.mock('@pagespace/lib/compliance/export/gdpr-export', () => ({
  collectAllUserData: (...args: unknown[]) => mockCollectAllUserData(...args),
}));

vi.mock('@pagespace/db', () => ({
  db: {},
}));

import { authenticateSessionRequest } from '@/lib/auth/index';
import { validateAdminAccess } from '@/lib/auth/admin-role';

const mockAuth = vi.mocked(authenticateSessionRequest);
const mockAdminValidation = vi.mocked(validateAdminAccess);

function mockAdminAuth() {
  mockAuth.mockResolvedValue({
    userId: 'admin-123',
    role: 'admin' as const,
    tokenVersion: 1,
    adminRoleVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'sess-abc',
  });
  const validResult: AdminValidationResult = { isValid: true, actualAdminRoleVersion: 0 };
  mockAdminValidation.mockResolvedValue(validResult);
}

function mockAuthDenied() {
  mockAuth.mockResolvedValue({
    error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
  } as never);
}

// Manually import GET after mocks are set up
// The route imports from @/lib/auth which re-exports from ./auth.ts
// withAdminAuth in ./auth.ts imports from ./index which we've mocked
import { GET } from '../route';

describe('/api/admin/users/[userId]/export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET_withValidAdmin_returnsUserDataExport', async () => {
    mockAdminAuth();
    const mockData = {
      profile: { id: 'user-1', name: 'Target User', email: 'target@test.com' },
      drives: [],
      pages: [],
      messages: [],
      files: [],
      activity: [],
      aiUsage: [],
      tasks: [],
    };
    mockCollectAllUserData.mockResolvedValue(mockData);

    const request = new Request('http://localhost/api/admin/users/user-1/export');
    const context = { params: Promise.resolve({ userId: 'user-1' }) };
    const response = await GET(request, context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.profile.id).toBe('user-1');
    expect(body.profile.name).toBe('Target User');
    expect(body.drives).toEqual([]);
    expect(body.messages).toEqual([]);
    expect(body.files).toEqual([]);
    expect(body.activity).toEqual([]);
    expect(body.aiUsage).toEqual([]);
    expect(body.tasks).toEqual([]);
    expect(body.exportedAt).toBeDefined();
    expect(body.exportedBy).toBe('admin-123');
  });

  it('GET_withNonexistentUser_returns404', async () => {
    mockAdminAuth();
    mockCollectAllUserData.mockResolvedValue(null);

    const request = new Request('http://localhost/api/admin/users/nonexistent/export');
    const context = { params: Promise.resolve({ userId: 'nonexistent' }) };
    const response = await GET(request, context);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('User not found');
  });

  it('GET_withoutAuth_returns403', async () => {
    mockAuthDenied();

    const request = new Request('http://localhost/api/admin/users/user-1/export');
    const context = { params: Promise.resolve({ userId: 'user-1' }) };
    const response = await GET(request, context);

    expect(response.status).toBe(403);
  });
});
