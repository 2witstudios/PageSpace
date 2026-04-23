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

vi.mock('@/lib/stripe/client', () => ({
  stripe: {
    customers: {
      del: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    auth: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  },
  logSecurityEvent: vi.fn(),
  auditRequest: vi.fn(),
  revokeUserIntegrationTokens: vi.fn().mockResolvedValue({ revoked: 0, failed: 0 }),
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
    isCloud: vi.fn().mockReturnValue(false),
  };
});

import { DELETE } from '../route';
import { authenticateSessionRequest } from '@/lib/auth/index';
import { validateAdminAccess } from '@/lib/auth/admin-role';
import { validateCSRF } from '@/lib/auth/csrf-validation';
import { accountRepository, activityLogRepository, auditRequest, revokeUserIntegrationTokens } from '@pagespace/lib/server';
import { logUserActivity } from '@pagespace/lib/monitoring/activity-logger';
import { deleteAiUsageLogsForUser, deleteMonitoringDataForUser, isCloud } from '@pagespace/lib';
import { stripe } from '@/lib/stripe/client';

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
    vi.mocked(isCloud).mockReturnValue(false);
    vi.mocked(revokeUserIntegrationTokens).mockResolvedValue({ revoked: 0, failed: 0 });
    vi.mocked(stripe.customers.del).mockResolvedValue({} as never);
    // Reset mocks that individual tests override (clearAllMocks preserves implementations)
    vi.mocked(accountRepository.checkAndDeleteSoloDrives).mockResolvedValue({ multiMemberDriveNames: [] });
  });

  it('DELETE_withValidAdmin_anonymizesAndDeletesUserData', async () => {
    mockAdminAuth();
    mockFindById.mockResolvedValue({
      id: 'user-1',
      email: 'target@example.com',
      image: null,
      stripeCustomerId: null,
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
      stripeCustomerId: null,
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

  it('DELETE_successfulDeletion_logsSecurityAudit', async () => {
    mockAdminAuth();
    mockFindById.mockResolvedValue({
      id: 'user-1',
      email: 'target@example.com',
      image: null,
      stripeCustomerId: null,
    });

    const request = new Request('http://localhost/api/admin/users/user-1/data', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'DSAR deletion request' }),
    });

    const context = { params: Promise.resolve({ userId: 'user-1' }) };
    await DELETE(request, context);

    expect(auditRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        eventType: 'data.delete',
        userId: 'admin-123',
        resourceType: 'user',
        resourceId: 'user-1',
        details: expect.objectContaining({
          source: 'admin',
          operation: 'dsar-deletion',
        }),
      })
    );
  });

  it('DELETE_withMultiMemberDrives_returns400', async () => {
    mockAdminAuth();
    mockFindById.mockResolvedValue({
      id: 'user-1',
      email: 'target@example.com',
      image: null,
      stripeCustomerId: null,
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

  describe('oauth token revocation (#911)', () => {
    it('given_activeOAuthConnections_shouldRevokeTokensBeforeUserDeletion', async () => {
      mockAdminAuth();
      mockFindById.mockResolvedValue({
        id: 'user-1',
        email: 'target@example.com',
        image: null,
        stripeCustomerId: null,
      });

      const callOrder: string[] = [];
      vi.mocked(revokeUserIntegrationTokens).mockImplementation(async () => {
        callOrder.push('revoke');
        return { revoked: 2, failed: 0 };
      });
      vi.mocked(accountRepository.deleteUser).mockImplementation(async () => {
        callOrder.push('deleteUser');
      });

      const request = new Request('http://localhost/api/admin/users/user-1/data', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'DSAR' }),
      });

      await DELETE(request, { params: Promise.resolve({ userId: 'user-1' }) });

      expect(callOrder.indexOf('revoke')).toBeLessThan(callOrder.indexOf('deleteUser'));
    });

    it('given_oauthRevocationFailure_shouldLogErrorButNotBlockDeletion', async () => {
      mockAdminAuth();
      mockFindById.mockResolvedValue({
        id: 'user-1',
        email: 'target@example.com',
        image: null,
        stripeCustomerId: null,
      });
      vi.mocked(revokeUserIntegrationTokens).mockRejectedValue(new Error('DB connection lost'));

      const request = new Request('http://localhost/api/admin/users/user-1/data', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'DSAR' }),
      });

      const response = await DELETE(request, { params: Promise.resolve({ userId: 'user-1' }) });

      expect(response.status).toBe(200);
      expect(accountRepository.deleteUser).toHaveBeenCalledWith('user-1');
    });
  });

  describe('stripe customer deletion (#910)', () => {
    it('given_cloudDeploymentWithStripeCustomer_shouldDeleteStripeCustomerAfterUserDeletion', async () => {
      mockAdminAuth();
      mockFindById.mockResolvedValue({
        id: 'user-1',
        email: 'target@example.com',
        image: null,
        stripeCustomerId: 'cus_abc123',
      });
      vi.mocked(isCloud).mockReturnValue(true);

      const callOrder: string[] = [];
      vi.mocked(accountRepository.deleteUser).mockImplementation(async () => {
        callOrder.push('deleteUser');
      });
      vi.mocked(stripe.customers.del).mockImplementation(async () => {
        callOrder.push('stripeDelete');
        return {} as never;
      });

      const request = new Request('http://localhost/api/admin/users/user-1/data', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'DSAR' }),
      });

      await DELETE(request, { params: Promise.resolve({ userId: 'user-1' }) });

      expect(stripe.customers.del).toHaveBeenCalledWith('cus_abc123');
      expect(callOrder.indexOf('deleteUser')).toBeLessThan(callOrder.indexOf('stripeDelete'));
    });

    it('given_nonCloudDeployment_shouldNotCallStripeEvenWithStripeCustomerId', async () => {
      mockAdminAuth();
      mockFindById.mockResolvedValue({
        id: 'user-1',
        email: 'target@example.com',
        image: null,
        stripeCustomerId: 'cus_abc123',
      });
      vi.mocked(isCloud).mockReturnValue(false);

      const request = new Request('http://localhost/api/admin/users/user-1/data', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'DSAR' }),
      });

      await DELETE(request, { params: Promise.resolve({ userId: 'user-1' }) });

      expect(stripe.customers.del).not.toHaveBeenCalled();
    });

    it('given_stripeApiFailure_shouldLogErrorButNotBlockDeletion', async () => {
      mockAdminAuth();
      mockFindById.mockResolvedValue({
        id: 'user-1',
        email: 'target@example.com',
        image: null,
        stripeCustomerId: 'cus_abc123',
      });
      vi.mocked(isCloud).mockReturnValue(true);
      vi.mocked(stripe.customers.del).mockRejectedValue(new Error('Stripe API unavailable'));

      const request = new Request('http://localhost/api/admin/users/user-1/data', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'DSAR' }),
      });

      const response = await DELETE(request, { params: Promise.resolve({ userId: 'user-1' }) });

      expect(response.status).toBe(200);
      expect(accountRepository.deleteUser).toHaveBeenCalledWith('user-1');
    });
  });
});
