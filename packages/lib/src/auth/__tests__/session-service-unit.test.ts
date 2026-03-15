import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../session-repository', () => ({
  sessionRepository: {
    findUserById: vi.fn(),
    findActiveSession: vi.fn(),
    insertSession: vi.fn(),
    touchSession: vi.fn(),
    revokeByHash: vi.fn(),
    revokeAllForUser: vi.fn(),
    deleteExpired: vi.fn(),
  },
}));

vi.mock('../opaque-tokens', () => ({
  generateOpaqueToken: vi.fn(() => ({
    token: 'ps_sess_testtoken123456789012345678901234567890a',
    tokenHash: 'hashed_token',
    tokenPrefix: 'ps_sess_test',
  })),
  isValidTokenFormat: vi.fn((t: string) => typeof t === 'string' && t.startsWith('ps_')),
}));

vi.mock('../token-utils', () => ({
  hashToken: vi.fn((t: string) => `hashed_${t}`),
}));

vi.mock('../constants', () => ({
  IDLE_TIMEOUT_MS: 0,
}));

import { SessionService } from '../session-service';
import { sessionRepository } from '../session-repository';
import { isValidTokenFormat } from '../opaque-tokens';
import { generateOpaqueToken } from '../opaque-tokens';

describe('SessionService', () => {
  let service: SessionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SessionService();
  });

  describe('createSession', () => {
    it('createSession_withValidUser_returnsTokenAndInsertsSession', async () => {
      vi.mocked(sessionRepository.findUserById).mockResolvedValue({
        id: 'user-1', tokenVersion: 1, role: 'user', adminRoleVersion: 0,
      });
      vi.mocked(sessionRepository.insertSession).mockResolvedValue(undefined);

      const token = await service.createSession({
        userId: 'user-1',
        type: 'user',
        scopes: ['read', 'write'],
        expiresInMs: 7 * 24 * 60 * 60 * 1000,
      });

      expect(token).toBe('ps_sess_testtoken123456789012345678901234567890a');
      expect(sessionRepository.insertSession).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenHash: 'hashed_token',
          tokenPrefix: 'ps_sess_test',
          userId: 'user-1',
          type: 'user',
          scopes: ['read', 'write'],
          tokenVersion: 1,
          adminRoleVersion: 0,
        }),
      );
    });

    it('createSession_withNonexistentUser_throwsUserNotFound', async () => {
      vi.mocked(sessionRepository.findUserById).mockResolvedValue(undefined);

      await expect(
        service.createSession({
          userId: 'nonexistent',
          type: 'user',
          scopes: [],
          expiresInMs: 60000,
        }),
      ).rejects.toThrow('User not found');
      expect(sessionRepository.insertSession).not.toHaveBeenCalled();
    });

    it('createSession_withServiceType_generatesTokenWithSvcPrefix', async () => {
      vi.mocked(sessionRepository.findUserById).mockResolvedValue({
        id: 'user-1', tokenVersion: 1, role: 'user', adminRoleVersion: 0,
      });
      vi.mocked(sessionRepository.insertSession).mockResolvedValue(undefined);

      await service.createSession({
        userId: 'user-1', type: 'service', scopes: ['read'], expiresInMs: 60000,
      });

      expect(generateOpaqueToken).toHaveBeenCalledWith('svc');
    });

    it('createSession_withMcpType_generatesTokenWithMcpPrefix', async () => {
      vi.mocked(sessionRepository.findUserById).mockResolvedValue({
        id: 'user-1', tokenVersion: 1, role: 'user', adminRoleVersion: 0,
      });
      vi.mocked(sessionRepository.insertSession).mockResolvedValue(undefined);

      await service.createSession({
        userId: 'user-1', type: 'mcp', scopes: ['read'], expiresInMs: 60000,
      });

      expect(generateOpaqueToken).toHaveBeenCalledWith('mcp');
    });

    it('createSession_withDeviceType_generatesTokenWithDevPrefix', async () => {
      vi.mocked(sessionRepository.findUserById).mockResolvedValue({
        id: 'user-1', tokenVersion: 1, role: 'user', adminRoleVersion: 0,
      });
      vi.mocked(sessionRepository.insertSession).mockResolvedValue(undefined);

      await service.createSession({
        userId: 'user-1', type: 'device', scopes: ['read'], expiresInMs: 60000,
      });

      expect(generateOpaqueToken).toHaveBeenCalledWith('dev');
    });
  });

  describe('validateSession', () => {
    it('validateSession_withInvalidTokenFormat_returnsNull', async () => {
      vi.mocked(isValidTokenFormat).mockReturnValue(false);

      const result = await service.validateSession('bad-token');

      expect(result).toBeNull();
      expect(sessionRepository.findActiveSession).not.toHaveBeenCalled();
    });

    it('validateSession_withSessionNotFound_returnsNull', async () => {
      vi.mocked(isValidTokenFormat).mockReturnValue(true);
      vi.mocked(sessionRepository.findActiveSession).mockResolvedValue(undefined);

      const result = await service.validateSession('ps_sess_valid');

      expect(result).toBeNull();
    });

    it('validateSession_withNoUserOnSession_returnsNull', async () => {
      vi.mocked(isValidTokenFormat).mockReturnValue(true);
      vi.mocked(sessionRepository.findActiveSession).mockResolvedValue({
        id: 'sess-1', userId: 'user-1', tokenHash: 'h', tokenVersion: 1,
        adminRoleVersion: 0, type: 'user', scopes: ['read'],
        expiresAt: new Date(Date.now() + 60000), lastUsedAt: null,
        resourceType: null, resourceId: null, driveId: null,
        user: null,
      });

      const result = await service.validateSession('ps_sess_valid');

      expect(result).toBeNull();
    });

    it('validateSession_withSuspendedUser_revokesAndReturnsNull', async () => {
      vi.mocked(isValidTokenFormat).mockReturnValue(true);
      vi.mocked(sessionRepository.findActiveSession).mockResolvedValue({
        id: 'sess-1', userId: 'user-1', tokenHash: 'h', tokenVersion: 1,
        adminRoleVersion: 0, type: 'user', scopes: ['read'],
        expiresAt: new Date(Date.now() + 60000), lastUsedAt: null,
        resourceType: null, resourceId: null, driveId: null,
        user: { id: 'user-1', tokenVersion: 1, role: 'user', adminRoleVersion: 0, suspendedAt: new Date() },
      });
      vi.mocked(sessionRepository.revokeByHash).mockResolvedValue(undefined);

      const result = await service.validateSession('ps_sess_valid');

      expect(result).toBeNull();
      expect(sessionRepository.revokeByHash).toHaveBeenCalledWith(
        'hashed_ps_sess_valid',
        'user_suspended',
      );
    });

    it('validateSession_withTokenVersionMismatch_revokesAndReturnsNull', async () => {
      vi.mocked(isValidTokenFormat).mockReturnValue(true);
      vi.mocked(sessionRepository.findActiveSession).mockResolvedValue({
        id: 'sess-1', userId: 'user-1', tokenHash: 'h', tokenVersion: 1,
        adminRoleVersion: 0, type: 'user', scopes: ['read'],
        expiresAt: new Date(Date.now() + 60000), lastUsedAt: null,
        resourceType: null, resourceId: null, driveId: null,
        user: { id: 'user-1', tokenVersion: 2, role: 'user', adminRoleVersion: 0, suspendedAt: null },
      });
      vi.mocked(sessionRepository.revokeByHash).mockResolvedValue(undefined);

      const result = await service.validateSession('ps_sess_valid');

      expect(result).toBeNull();
      expect(sessionRepository.revokeByHash).toHaveBeenCalledWith(
        'hashed_ps_sess_valid',
        'token_version_mismatch',
      );
    });

    it('validateSession_withValidSession_returnsClaimsAndTouchesSession', async () => {
      vi.mocked(isValidTokenFormat).mockReturnValue(true);
      const expiresAt = new Date(Date.now() + 60000);
      vi.mocked(sessionRepository.findActiveSession).mockResolvedValue({
        id: 'sess-1', userId: 'user-1', tokenHash: 'h', tokenVersion: 1,
        adminRoleVersion: 0, type: 'user', scopes: ['read', 'write'],
        expiresAt, lastUsedAt: null,
        resourceType: null, resourceId: null, driveId: null,
        user: { id: 'user-1', tokenVersion: 1, role: 'admin', adminRoleVersion: 0, suspendedAt: null },
      });

      const result = await service.validateSession('ps_sess_valid');

      expect(result).toEqual({
        sessionId: 'sess-1',
        userId: 'user-1',
        userRole: 'admin',
        tokenVersion: 1,
        adminRoleVersion: 0,
        type: 'user',
        scopes: ['read', 'write'],
        expiresAt,
        resourceType: undefined,
        resourceId: undefined,
        driveId: undefined,
      });
      expect(sessionRepository.touchSession).toHaveBeenCalledWith('hashed_ps_sess_valid');
    });
  });

  describe('revokeSession', () => {
    it('revokeSession_withTokenAndReason_delegatesToRepositoryWithHashedToken', async () => {
      vi.mocked(sessionRepository.revokeByHash).mockResolvedValue(undefined);

      await service.revokeSession('ps_sess_token', 'user_logout');

      expect(sessionRepository.revokeByHash).toHaveBeenCalledWith(
        'hashed_ps_sess_token',
        'user_logout',
      );
    });
  });

  describe('revokeAllUserSessions', () => {
    it('revokeAllUserSessions_withActiveSessionsExist_returnsRevokedCount', async () => {
      vi.mocked(sessionRepository.revokeAllForUser).mockResolvedValue(3);

      const count = await service.revokeAllUserSessions('user-1', 'password_change');

      expect(count).toBe(3);
      expect(sessionRepository.revokeAllForUser).toHaveBeenCalledWith('user-1', 'password_change');
    });

    it('revokeAllUserSessions_withNoActiveSessions_returnsZero', async () => {
      vi.mocked(sessionRepository.revokeAllForUser).mockResolvedValue(0);

      const count = await service.revokeAllUserSessions('user-1', 'test');

      expect(count).toBe(0);
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('cleanupExpiredSessions_withExpiredSessions_returnsDeletedCount', async () => {
      vi.mocked(sessionRepository.deleteExpired).mockResolvedValue(5);

      const count = await service.cleanupExpiredSessions();

      expect(count).toBe(5);
      expect(sessionRepository.deleteExpired).toHaveBeenCalledWith(7 * 24 * 60 * 60 * 1000);
    });

    it('cleanupExpiredSessions_withNoExpiredSessions_returnsZero', async () => {
      vi.mocked(sessionRepository.deleteExpired).mockResolvedValue(0);

      const count = await service.cleanupExpiredSessions();

      expect(count).toBe(0);
    });
  });
});
