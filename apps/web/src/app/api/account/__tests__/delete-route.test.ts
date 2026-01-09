import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { WebAuthResult, AuthError } from '@/lib/auth';
import type { ServiceTokenClaims } from '@pagespace/lib/auth-utils';

// Mock repository seams - the proper architectural boundary
vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
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

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/auth-utils', () => ({
  createServiceToken: vi.fn(),
  verifyServiceToken: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  createUserServiceToken: vi.fn(),
}));

import { DELETE } from '../route';
import {
  loggers,
  accountRepository,
  activityLogRepository,
} from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { createServiceToken, verifyServiceToken } from '@pagespace/lib/auth-utils';
import { createUserServiceToken } from '@pagespace/lib';

// Type the mocked repositories
const mockAccountRepo = vi.mocked(accountRepository);
const mockActivityLogRepo = vi.mocked(activityLogRepository);

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string, tokenVersion = 0): WebAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock ServiceTokenClaims
const mockServiceClaims = (userId: string): ServiceTokenClaims => ({
  sub: userId,
  service: 'web',
  scopes: ['avatars:write'],
  userId,
  tenantId: userId,
  tokenType: 'service',
  jti: 'mock-jti',
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + 120,
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

    // Arrange: default user exists
    mockAccountRepo.findById.mockResolvedValue({
      id: mockUserId,
      email: mockUserEmail,
      image: null,
    });

    // Arrange: default no owned drives
    mockAccountRepo.getOwnedDrives.mockResolvedValue([]);

    // Arrange: default successful operations
    mockAccountRepo.deleteDrive.mockResolvedValue(undefined);
    mockAccountRepo.deleteUser.mockResolvedValue(undefined);
    mockActivityLogRepo.anonymizeForUser.mockResolvedValue({ success: true });
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
        expect.stringContaining('Auto-deleted 1 solo drives')
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
      expect(body.error).toContain('must transfer ownership or delete');
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
        expect.stringContaining('Auto-deleted 3 solo drives')
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
        expect.stringContaining('/api/avatar/'),
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockToken}`,
          }),
        })
      );
    });

    it('should not delete avatar for external URLs', async () => {
      // Arrange
      mockAccountRepo.findById.mockResolvedValue({
        id: mockUserId,
        email: mockUserEmail,
        image: 'https://example.com/avatar.jpg',
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
      });

      vi.mocked(createUserServiceToken).mockRejectedValue(new Error('Token creation failed'));

      const request = new Request('https://example.com/api/account', {
        method: 'DELETE',
        body: JSON.stringify({ emailConfirmation: mockUserEmail }),
      });

      // Act
      const response = await DELETE(request);

      // Assert - should still succeed despite avatar deletion failure
      expect(response.status).toBe(200);
      expect(loggers.auth.error).toHaveBeenCalledWith(
        expect.stringContaining('avatar'),
        expect.any(Error)
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
        expect.stringMatching(/^deleted_user_[a-f0-9]+$/)
      );
      expect(loggers.auth.info).toHaveBeenCalledWith(
        expect.stringContaining('Anonymized activity logs')
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
        expect.stringContaining('anonymize'),
        expect.any(Error)
      );
      expect(mockAccountRepo.deleteUser).toHaveBeenCalledWith(mockUserId);
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
        expect.stringContaining('User account deleted')
      );
    });

    it('should handle database errors gracefully', async () => {
      // Arrange
      mockAccountRepo.deleteUser.mockRejectedValue(new Error('Database connection lost'));

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
      expect(loggers.auth.error).toHaveBeenCalled();
    });
  });
});
