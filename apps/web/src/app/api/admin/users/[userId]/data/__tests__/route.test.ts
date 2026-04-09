import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AdminValidationResult } from '@/lib/auth/admin-role';

vi.mock('@/lib/auth/index', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    authenticateSessionRequest: vi.fn(),
    isAuthError: vi.fn((result) => 'error' in result),
  };
});

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
  accountRepository: {
    findById: vi.fn(),
    getOwnedDrives: vi.fn().mockResolvedValue([]),
    getDriveMemberCount: vi.fn().mockResolvedValue(0),
    deleteDrive: vi.fn(),
    deleteUser: vi.fn(),
    checkAndDeleteSoloDrives: vi.fn().mockResolvedValue({ multiMemberDriveNames: [] }),
  },
  activityLogRepository: {
    anonymizeForUser: vi.fn().mockResolvedValue({ success: true, count: 0 }),
  },
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ email: 'admin@example.com', displayName: 'Admin' }),
  logUserActivity: vi.fn(),
}));

vi.mock('@pagespace/lib', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    deleteAiUsageLogsForUser: vi.fn().mockResolvedValue(undefined),
    deleteMonitoringDataForUser: vi.fn().mockResolvedValue({ systemLogs: 0, apiMetrics: 0, errorLogs: 0, userActivities: 0 }),
  };
});

import { DELETE } from '../route';
import { authenticateSessionRequest } from '@/lib/auth/index';
import { validateAdminAccess } from '@/lib/auth/admin-role';
import { validateCSRF } from '@/lib/auth/csrf-validation';
import { accountRepository, activityLogRepository } from '@pagespace/lib/server';
import { logUserActivity } from '@pagespace/lib/monitoring/activity-logger';
import { deleteAiUsageLogsForUser, deleteMonitoringDataForUser } from '@pagespace/lib';

const mockAuth = vi.mocked(authenticateSessionRequest);
const mockAdminValidation = vi.mocked(validateAdminAccess);
const mockFindById = vi.mocked(accountRepository.findById);

function mockAdminAuth(adminId = 'admin-123') {
  mockAuth.mockResolvedValue({
    userId: adminId,
    role: 'admin' as const,
    tokenVersion: 1,
    adminRoleVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'sess-abc',
  });
  const validResult: AdminValidationResult = { isValid: true, actualAdminRoleVersion: 0 };
  mockAdminValidation.mockResolvedValue(validResult);
  vi.mocked(validateCSRF).mockResolvedValue(null);
}

function mockAuthDenied() {
  mockAuth.mockResolvedValue({
    error: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
  } as never);
}

describe('/api/admin/users/[userId]/data', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('DELETE_withValidAdmin_anonymizesAndDeletesUserData', async () => {
    mockAdminAuth();
    mockFindById.mockResolvedValue({
      id: 'user-1',
      email: 'target@example.com',
      image: null,
    });

    const request = new Request('http://localhost/api/admin/users/user-1/data', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'DSAR deletion request' }),
    });

    const context = { params: Promise.resolve({ userId: 'user-1' }) };
    const response = await DELETE(request, context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toBe('User data deleted and anonymized');
    expect(logUserActivity).toHaveBeenCalledWith(
      'admin-123',
      'account_delete',
      { targetUserId: 'user-1', targetUserEmail: 'tar***@example.com' },
      { email: 'admin@example.com', displayName: 'Admin' }
    );
    expect(activityLogRepository.anonymizeForUser).toHaveBeenCalledWith('user-1', 'deleted_user_c6c289e49e9c');
    expect(deleteAiUsageLogsForUser).toHaveBeenCalledWith('user-1');
    expect(deleteMonitoringDataForUser).toHaveBeenCalledWith('user-1');
    expect(accountRepository.deleteUser).toHaveBeenCalledWith('user-1');
  });

  it('DELETE_adminCannotDeleteSelf_returns400', async () => {
    mockAdminAuth('admin-123');
    mockFindById.mockResolvedValue({
      id: 'admin-123',
      email: 'admin@example.com',
      image: null,
    });

    const request = new Request('http://localhost/api/admin/users/admin-123/data', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Self-deletion' }),
    });

    const context = { params: Promise.resolve({ userId: 'admin-123' }) };
    const response = await DELETE(request, context);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('Cannot delete your own account');
  });

  it('DELETE_nonexistentUser_returns404', async () => {
    mockAdminAuth();
    mockFindById.mockResolvedValue(null);

    const request = new Request('http://localhost/api/admin/users/nonexistent/data', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Test' }),
    });

    const context = { params: Promise.resolve({ userId: 'nonexistent' }) };
    const response = await DELETE(request, context);

    expect(response.status).toBe(404);
  });

  it('DELETE_withoutAuth_returns403', async () => {
    mockAuthDenied();

    const request = new Request('http://localhost/api/admin/users/user-1/data', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Test' }),
    });

    const context = { params: Promise.resolve({ userId: 'user-1' }) };
    const response = await DELETE(request, context);

    expect(response.status).toBe(403);
  });

  it('DELETE_withMultiMemberDrives_returns400', async () => {
    mockAdminAuth();
    mockFindById.mockResolvedValue({
      id: 'user-1',
      email: 'target@example.com',
      image: null,
    });
    vi.mocked(accountRepository.checkAndDeleteSoloDrives).mockResolvedValue({
      multiMemberDriveNames: ['Shared Drive'],
    });

    const request = new Request('http://localhost/api/admin/users/user-1/data', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Test' }),
    });

    const context = { params: Promise.resolve({ userId: 'user-1' }) };
    const response = await DELETE(request, context);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('Transfer ownership first');
    expect(body.multiMemberDrives).toContain('Shared Drive');
  });
});
