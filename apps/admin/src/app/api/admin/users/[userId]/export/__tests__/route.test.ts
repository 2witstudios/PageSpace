import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AdminValidationResult } from '@/lib/auth/admin-role';

vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: {
    validateSession: vi.fn(),
  },
}));

vi.mock('@/lib/auth/admin-role', () => ({
  validateAdminAccess: vi.fn(),
}));

vi.mock('@/lib/auth/csrf-validation', () => ({
  validateCSRF: vi.fn().mockResolvedValue(null),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    auth: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    security: { warn: vi.fn() },
  },
  logSecurityEvent: vi.fn(),
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

const mockCollectAllUserData = vi.fn();
vi.mock('@pagespace/lib/compliance/export/gdpr-export', () => ({
  collectAllUserData: (...args: unknown[]) => mockCollectAllUserData(...args),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {},
}));

import { sessionService } from '@pagespace/lib/auth/session-service';
import { validateAdminAccess } from '@/lib/auth/admin-role';

const mockValidateSession = vi.mocked(sessionService.validateSession);
const mockAdminValidation = vi.mocked(validateAdminAccess);

const FAKE_COOKIE = 'session=ps_sess_faketoken';

function mockAdminAuth() {
  mockValidateSession.mockResolvedValue({
    userId: 'admin-123',
    userRole: 'admin' as const,
    tokenVersion: 1,
    adminRoleVersion: 0,
    sessionId: 'sess-abc',
  } as Awaited<ReturnType<typeof sessionService.validateSession>>);
  const validResult: AdminValidationResult = { isValid: true, actualAdminRoleVersion: 0 };
  mockAdminValidation.mockResolvedValue(validResult);
}

function mockAuthDenied() {
  mockValidateSession.mockResolvedValue(null);
}

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

    const request = new Request('http://localhost/api/admin/users/user-1/export', {
      headers: { cookie: FAKE_COOKIE },
    });
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

    const request = new Request('http://localhost/api/admin/users/nonexistent/export', {
      headers: { cookie: FAKE_COOKIE },
    });
    const context = { params: Promise.resolve({ userId: 'nonexistent' }) };
    const response = await GET(request, context);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe('User not found');
  });

  it('GET_withoutAuth_returns403', async () => {
    mockAuthDenied();

    const request = new Request('http://localhost/api/admin/users/user-1/export', {
      headers: { cookie: FAKE_COOKIE },
    });
    const context = { params: Promise.resolve({ userId: 'user-1' }) };
    const response = await GET(request, context);

    expect(response.status).toBe(403);
  });
});
