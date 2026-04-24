import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/lib/repositories', () => ({
  accountRepository: {
    findById: vi.fn(),
    getOwnedDrives: vi.fn(),
    getDriveMemberCount: vi.fn(),
    deleteDrive: vi.fn(),
    deleteUser: vi.fn(),
  },
  activityLogRepository: {
    anonymizeForUser: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/services/validated-service-token', () => ({
  createUserServiceToken: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/ai-usage-purge', () => ({
  deleteAiUsageLogsForUser: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/monitoring-purge', () => ({
  deleteMonitoringDataForUser: vi.fn(),
}));

vi.mock('@pagespace/lib/compliance/erasure/revoke-integration-tokens', () => ({
  revokeUserIntegrationTokens: vi.fn().mockResolvedValue({ revoked: 0, failed: 0 }),
}));

vi.mock('@pagespace/lib/deployment-mode', () => ({
  isCloud: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/stripe/client', () => ({
  stripe: {
    customers: {
      del: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ email: 'user@example.com', displayName: 'Test User' }),
  logUserActivity: vi.fn(),
}));

import { DELETE } from '../route';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { accountRepository } from '@pagespace/lib/repositories/account-repository';
import { activityLogRepository } from '@pagespace/lib/repositories/activity-log-repository';
import { revokeUserIntegrationTokens } from '@pagespace/lib/compliance/erasure/revoke-integration-tokens';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { createUserServiceToken } from '@pagespace/lib/services/validated-service-token'
import { deleteMonitoringDataForUser } from '@pagespace/lib/logging/monitoring-purge'
import { isCloud } from '@pagespace/lib/deployment-mode';
import { stripe } from '@/lib/stripe/client';

// Type the mocked repositories
const mockAccountRepo = vi.mocked(accountRepository);
const mockActivityLogRepo = vi.mocked(activityLogRepository);

// Helper to create mock SessionAuthResult
const mockWebAuth = (userId: string, tokenVersion = 0): SessionAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

describe('DELETE /api/account', () => {
  const mockUserId = 'user_123';
  const mockUserEmail = 'test@example.com';

  beforeEach(() => {
    vi.clearAllMocks();

    // Arrange: default successful auth
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(
      mockWebAuth(mockUserId)
    );
    vi.mocked(isAuthError).mockReturnValue(false);

    // Arrange: default user exists (includes stripeCustomerId for #910)
    mockAccountRepo.findById.mockResolvedValue({
      id: mockUserId,
      email: mockUserEmail,
      image: null,
      stripeCustomerId: null,
    });

    // Arrange: default no owned drives
    mockAccountRepo.getOwnedDrives.mockResolvedValue([]);

    // Arrange: default successful operations
    mockAccountRepo.deleteDrive.mockResolvedValue(undefined);
    mockAccountRepo.deleteUser.mockResolvedValue(undefined);
    mockActivityLogRepo.anonymizeForUser.mockResolvedValue({ success: true });

    // Arrange: default non-cloud (no Stripe calls)
    vi.mocked(isCloud).mockReturnValue(false);

    // Arrange: default successful OAuth revocation (#911)
    vi.mocked(revokeUserIntegrationTokens).mockResolvedValue({ revoked: 0, failed: 0 });
  });

  describe('email confirmation validation', () => {
    it('should reject when email confirmation does not match', async () => {
      // Arrange
      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: 'wrong@example.com' }),
      });

      // Act
      const response = await DELETE(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.error).toBe('Email confirmation does not match your account email');
    });

    it('should reject when email confirmation is empty', async () => {
      // Arrange
      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: '' }),
      });

      // Act
      const response = await DELETE(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.error).toBe('Email confirmation does not match your account email');
    });

    it('should accept email confirmation with different case', async () => {
      // Arrange
      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: 'TEST@EXAMPLE.COM' }),
      });

      // Act
      const response = await DELETE(request);

      // Assert
      expect(response.status).toBe(200);
    });

    it('should trim and lowercase email confirmation', async () => {
      // Arrange
      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: '  TEST@EXAMPLE.COM  ' }),
      });

      // Act
      const response = await DELETE(request);

      // Assert
      expect(response.status).toBe(200);
    });
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      // Arrange
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(
        mockAuthError(401)
      );

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);

      // Assert
      expect(response.status).toBe(401);
    });

    it('should return 404 when user not found', async () => {
      // Arrange
      mockAccountRepo.findById.mockResolvedValue(null);

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });
  });

  describe('drive ownership handling', () => {
    it('should auto-delete solo drives before account deletion', async () => {
      // Arrange: user owns one solo drive (1 member)
      mockAccountRepo.getOwnedDrives.mockResolvedValue([
        { id: 'drive_solo', name: 'Solo Drive' },
      ]);
      mockAccountRepo.getDriveMemberCount.mockResolvedValue(1);

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);

      // Assert - verify boundary interactions
      expect(response.status).toBe(200);
      expect(mockAccountRepo.deleteDrive).toHaveBeenCalledWith('drive_solo');
      expect(mockAccountRepo.deleteUser).toHaveBeenCalledWith(mockUserId);
      expect(loggers.auth.info).toHaveBeenCalledWith(
        `Auto-deleted 1 solo drives for user ${mockUserId}`
      );
    });

    it('should block deletion when multi-member drives exist', async () => {
      // Arrange: user owns one multi-member drive (3 members)
      mockAccountRepo.getOwnedDrives.mockResolvedValue([
        { id: 'drive_multi', name: 'Team Drive' },
      ]);
      mockAccountRepo.getDriveMemberCount.mockResolvedValue(3);

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.error).toBe('You must transfer ownership or delete all drives with other members before deleting your account');
      expect(body.multiMemberDrives).toContain('Team Drive');
      expect(mockAccountRepo.deleteUser).not.toHaveBeenCalled();
    });

    it('should handle multiple solo drives correctly', async () => {
      // Arrange: user owns 3 solo drives
      mockAccountRepo.getOwnedDrives.mockResolvedValue([
        { id: 'drive_1', name: 'Solo 1' },
        { id: 'drive_2', name: 'Solo 2' },
        { id: 'drive_3', name: 'Solo 3' },
      ]);
      mockAccountRepo.getDriveMemberCount.mockResolvedValue(1);

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);

      // Assert - verify all drives deleted
      expect(response.status).toBe(200);
      expect(mockAccountRepo.deleteDrive).toHaveBeenCalledWith('drive_1');
      expect(mockAccountRepo.deleteDrive).toHaveBeenCalledWith('drive_2');
      expect(mockAccountRepo.deleteDrive).toHaveBeenCalledWith('drive_3');
      expect(loggers.auth.info).toHaveBeenCalledWith(
        `Auto-deleted 3 solo drives for user ${mockUserId}`
      );
    });
  });

  describe('avatar deletion', () => {
    it('should delete user avatar via processor service', async () => {
      // Arrange
      const mockToken = 'mock-service-token';
      vi.mocked(createUserServiceToken).mockResolvedValue({
        token: mockToken,
        grantedScopes: ['avatars:write'],
      });

      mockAccountRepo.findById.mockResolvedValue({
        id: mockUserId,
        email: mockUserEmail,
        image: '/avatars/user_123.jpg',
        stripeCustomerId: null,
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
      });

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      await DELETE(request);

      // Assert - verify fetch called with correct payload
      expect(global.fetch).toHaveBeenCalledWith(
        `http://processor:3003/api/avatar/${mockUserId}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${mockToken}`,
          },
        }
      );
    });

    it('should not delete avatar for external URLs', async () => {
      // Arrange
      mockAccountRepo.findById.mockResolvedValue({
        id: mockUserId,
        email: mockUserEmail,
        image: 'https://example.com/avatar.jpg',
        stripeCustomerId: null,
      });

      global.fetch = vi.fn();

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      await DELETE(request);

      // Assert
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should continue deletion if avatar deletion fails', async () => {
      // Arrange
      mockAccountRepo.findById.mockResolvedValue({
        id: mockUserId,
        email: mockUserEmail,
        image: '/avatars/user_123.jpg',
        stripeCustomerId: null,
      });

      vi.mocked(createUserServiceToken).mockRejectedValueOnce(new Error('Token creation failed'));

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);

      // Assert - should still succeed despite avatar deletion failure
      expect(response.status).toBe(200);
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Could not delete user avatar during account deletion:',
        expect.objectContaining({ message: 'Token creation failed' })
      );
    });
  });

  describe('audit trail compliance (GDPR)', () => {
    it('should anonymize activity logs before user deletion', async () => {
      // Arrange
      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);

      // Assert - verify anonymization boundary payload
      expect(response.status).toBe(200);
      expect(mockActivityLogRepo.anonymizeForUser).toHaveBeenCalledWith(
        mockUserId,
        'deleted_user_80fba0ae1c48'
      );
      expect(loggers.auth.info).toHaveBeenCalledWith(
        `Anonymized activity logs for user ${mockUserId}`
      );
    });

    it('should continue with user deletion if anonymization fails', async () => {
      // Arrange
      mockActivityLogRepo.anonymizeForUser.mockResolvedValue({
        success: false,
        error: 'Database connection lost',
      });

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);

      // Assert - should still succeed
      expect(response.status).toBe(200);
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Could not anonymize activity logs during account deletion:',
        new Error('Database connection lost')
      );
      expect(mockAccountRepo.deleteUser).toHaveBeenCalledWith(mockUserId);
    });
  });

  describe('monitoring data cleanup', () => {
    it('given account deletion, should delete user rows from monitoring tables', async () => {
      // Arrange
      vi.mocked(deleteMonitoringDataForUser).mockResolvedValue({
        systemLogs: 5,
        apiMetrics: 10,
        errorLogs: 2,
        userActivities: 8,
      });

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);

      // Assert
      expect(response.status).toBe(200);
      expect(deleteMonitoringDataForUser).toHaveBeenCalledWith(mockUserId);
    });

    it('given monitoring cleanup failure, should continue with account deletion', async () => {
      // Arrange
      vi.mocked(deleteMonitoringDataForUser).mockRejectedValue(
        new Error('Connection timeout')
      );

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);

      // Assert - should still succeed
      expect(response.status).toBe(200);
      expect(mockAccountRepo.deleteUser).toHaveBeenCalledWith(mockUserId);
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Could not delete monitoring data during account deletion:',
        expect.objectContaining({ message: 'Connection timeout' })
      );
    });
  });

  describe('user deletion', () => {
    it('should delete user from database', async () => {
      // Arrange
      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);

      // Assert
      expect(response.status).toBe(200);
      expect(mockAccountRepo.deleteUser).toHaveBeenCalledWith(mockUserId);
      expect(loggers.auth.info).toHaveBeenCalledWith(
        `User account deleted: ${mockUserId}`
      );
    });

    it('should handle database errors gracefully', async () => {
      // Arrange
      mockAccountRepo.deleteUser.mockRejectedValueOnce(new Error('Database connection lost'));

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to delete account');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Account deletion error:',
        expect.objectContaining({ message: 'Database connection lost' })
      );
    });
  });

  describe('stripe customer deletion (#910)', () => {
    it('given stripeCustomerId and cloud mode, should delete Stripe customer after account deletion', async () => {
      // Arrange
      mockAccountRepo.findById.mockResolvedValue({
        id: mockUserId,
        email: mockUserEmail,
        image: null,
        stripeCustomerId: 'cus_test123',
      });
      vi.mocked(isCloud).mockReturnValue(true);
      vi.mocked(stripe.customers.del).mockResolvedValue({} as never);

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);

      // Assert
      expect(response.status).toBe(200);
      expect(stripe.customers.del).toHaveBeenCalledWith('cus_test123');
    });

    it('given null stripeCustomerId, should not call Stripe delete', async () => {
      // Arrange — default beforeEach already has stripeCustomerId: null
      vi.mocked(isCloud).mockReturnValue(true);

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);

      // Assert
      expect(response.status).toBe(200);
      expect(stripe.customers.del).not.toHaveBeenCalled();
    });

    it('given non-cloud deployment, should not call Stripe delete even with stripeCustomerId', async () => {
      // Arrange
      mockAccountRepo.findById.mockResolvedValue({
        id: mockUserId,
        email: mockUserEmail,
        image: null,
        stripeCustomerId: 'cus_onprem123',
      });
      vi.mocked(isCloud).mockReturnValue(false);

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);

      // Assert
      expect(response.status).toBe(200);
      expect(stripe.customers.del).not.toHaveBeenCalled();
    });

    it('given Stripe API failure, should log error but not block deletion', async () => {
      // Arrange
      mockAccountRepo.findById.mockResolvedValue({
        id: mockUserId,
        email: mockUserEmail,
        image: null,
        stripeCustomerId: 'cus_test123',
      });
      vi.mocked(isCloud).mockReturnValue(true);
      vi.mocked(stripe.customers.del).mockRejectedValue(new Error('Stripe API unavailable'));

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);

      // Assert — user deleted, Stripe failure only logged
      expect(response.status).toBe(200);
      expect(mockAccountRepo.deleteUser).toHaveBeenCalledWith(mockUserId);
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Could not delete Stripe customer during account deletion:',
        expect.objectContaining({ message: 'Stripe API unavailable' })
      );
    });

    it('given Stripe deletion, should call deleteUser BEFORE stripe.customers.del', async () => {
      // Arrange — right to erasure cannot be gated on Stripe API availability
      mockAccountRepo.findById.mockResolvedValue({
        id: mockUserId,
        email: mockUserEmail,
        image: null,
        stripeCustomerId: 'cus_test123',
      });
      vi.mocked(isCloud).mockReturnValue(true);

      const callOrder: string[] = [];
      mockAccountRepo.deleteUser.mockImplementation(async () => {
        callOrder.push('deleteUser');
      });
      vi.mocked(stripe.customers.del).mockImplementation(async () => {
        callOrder.push('stripeDel');
        return {} as never;
      });

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      await DELETE(request);

      // Assert — DB deletion before Stripe
      expect(callOrder.indexOf('deleteUser')).toBeLessThan(callOrder.indexOf('stripeDel'));
    });
  });

  describe('oauth token revocation (#911)', () => {
    it('given active oauth connections, should revoke tokens before user deletion', async () => {
      // Arrange
      const callOrder: string[] = [];
      vi.mocked(revokeUserIntegrationTokens).mockImplementation(async () => {
        callOrder.push('revokeTokens');
        return { revoked: 2, failed: 0 };
      });
      mockAccountRepo.deleteUser.mockImplementation(async () => {
        callOrder.push('deleteUser');
      });

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);

      // Assert — revoke before delete
      expect(response.status).toBe(200);
      expect(revokeUserIntegrationTokens).toHaveBeenCalledWith(mockUserId);
      expect(callOrder.indexOf('revokeTokens')).toBeLessThan(callOrder.indexOf('deleteUser'));
    });

    it('given oauth revocation failure, should log error but not block deletion', async () => {
      // Arrange
      vi.mocked(revokeUserIntegrationTokens).mockRejectedValue(
        new Error('Revocation service down')
      );

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);

      // Assert
      expect(response.status).toBe(200);
      expect(mockAccountRepo.deleteUser).toHaveBeenCalledWith(mockUserId);
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Could not revoke OAuth tokens during account deletion:',
        expect.objectContaining({ message: 'Revocation service down' })
      );
    });

    it('given partial revocation failures, should log the counts and continue', async () => {
      // Arrange
      vi.mocked(revokeUserIntegrationTokens).mockResolvedValue({ revoked: 1, failed: 2 });

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);

      // Assert
      expect(response.status).toBe(200);
      expect(loggers.auth.info).toHaveBeenCalledWith(
        expect.stringMatching(/revoked=1.*failed=2|OAuth.*1.*2/i)
      );
    });
  });
});
