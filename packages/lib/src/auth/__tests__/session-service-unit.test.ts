import { describe, it, expect, vi, beforeEach } from 'vitest';

// @scaffold — ORM chain mocks for database operations
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
      sessions: { findFirst: vi.fn() },
    },
    insert: vi.fn(() => ({ values: vi.fn() })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(),
          catch: vi.fn(),
        })),
        catch: vi.fn(),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ rowCount: 5 })),
    })),
  },
  sessions: {
    tokenHash: 'tokenHash',
    userId: 'userId',
    revokedAt: 'revokedAt',
    expiresAt: 'expiresAt',
    lastUsedAt: 'lastUsedAt',
    id: 'id',
  },
  users: { id: 'id' },
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  gt: vi.fn(),
  lt: vi.fn(),
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
import { db } from '@pagespace/db';
import { isValidTokenFormat } from '../opaque-tokens';

describe('SessionService', () => {
  let service: SessionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SessionService();
  });

  describe('createSession', () => {
    it('should create a session for a valid user', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1',
        tokenVersion: 1,
        role: 'user',
        adminRoleVersion: 0,
      } as never);

      const mockValues = vi.fn();
      vi.mocked(db.insert).mockReturnValue({ values: mockValues } as never);

      const token = await service.createSession({
        userId: 'user-1',
        type: 'user',
        scopes: ['read', 'write'],
        expiresInMs: 7 * 24 * 60 * 60 * 1000,
      });

      expect(token).toBe('ps_sess_testtoken123456789012345678901234567890a');
      expect(db.insert).toHaveBeenCalledTimes(1);
    });

    it('should throw when user not found', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined as never);

      await expect(
        service.createSession({
          userId: 'nonexistent',
          type: 'user',
          scopes: [],
          expiresInMs: 60000,
        })
      ).rejects.toThrow('User not found');
    });

    it('should use correct token type for service sessions', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1', tokenVersion: 1, role: 'user', adminRoleVersion: 0,
      } as never);
      const mockValues = vi.fn();
      vi.mocked(db.insert).mockReturnValue({ values: mockValues } as never);

      const { generateOpaqueToken } = await import('../opaque-tokens');

      await service.createSession({
        userId: 'user-1', type: 'service', scopes: ['read'], expiresInMs: 60000,
      });
      expect(generateOpaqueToken).toHaveBeenCalledWith('svc');
    });

    it('should use correct token type for mcp sessions', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1', tokenVersion: 1, role: 'user', adminRoleVersion: 0,
      } as never);
      const mockValues = vi.fn();
      vi.mocked(db.insert).mockReturnValue({ values: mockValues } as never);

      const { generateOpaqueToken } = await import('../opaque-tokens');

      await service.createSession({
        userId: 'user-1', type: 'mcp', scopes: ['read'], expiresInMs: 60000,
      });
      expect(generateOpaqueToken).toHaveBeenCalledWith('mcp');
    });

    it('should use correct token type for device sessions', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue({
        id: 'user-1', tokenVersion: 1, role: 'user', adminRoleVersion: 0,
      } as never);
      const mockValues = vi.fn();
      vi.mocked(db.insert).mockReturnValue({ values: mockValues } as never);

      const { generateOpaqueToken } = await import('../opaque-tokens');

      await service.createSession({
        userId: 'user-1', type: 'device', scopes: ['read'], expiresInMs: 60000,
      });
      expect(generateOpaqueToken).toHaveBeenCalledWith('dev');
    });
  });

  describe('validateSession', () => {
    it('should return null for invalid token format', async () => {
      vi.mocked(isValidTokenFormat).mockReturnValue(false);
      const result = await service.validateSession('bad-token');
      expect(result).toBeNull();
    });

    it('should return null when session not found', async () => {
      vi.mocked(isValidTokenFormat).mockReturnValue(true);
      vi.mocked(db.query.sessions.findFirst).mockResolvedValue(undefined as never);

      const result = await service.validateSession('ps_sess_valid');
      expect(result).toBeNull();
    });

    it('should return null when session has no user', async () => {
      vi.mocked(isValidTokenFormat).mockReturnValue(true);
      vi.mocked(db.query.sessions.findFirst).mockResolvedValue({
        id: 'sess-1', user: null,
      } as never);

      const result = await service.validateSession('ps_sess_valid');
      expect(result).toBeNull();
    });

    it('should revoke session and return null when user is suspended', async () => {
      vi.mocked(isValidTokenFormat).mockReturnValue(true);
      vi.mocked(db.query.sessions.findFirst).mockResolvedValue({
        id: 'sess-1',
        userId: 'user-1',
        tokenVersion: 1,
        adminRoleVersion: 0,
        type: 'user',
        scopes: ['read'],
        expiresAt: new Date(Date.now() + 60000),
        user: { id: 'user-1', tokenVersion: 1, role: 'user', adminRoleVersion: 0, suspendedAt: new Date() },
      } as never);

      const mockSet = vi.fn(() => ({ where: vi.fn() }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);

      const result = await service.validateSession('ps_sess_valid');
      expect(result).toBeNull();
      expect(db.update).toHaveBeenCalledTimes(1);
    });

    it('should revoke session when token version mismatches', async () => {
      vi.mocked(isValidTokenFormat).mockReturnValue(true);
      vi.mocked(db.query.sessions.findFirst).mockResolvedValue({
        id: 'sess-1',
        userId: 'user-1',
        tokenVersion: 1,
        adminRoleVersion: 0,
        type: 'user',
        scopes: ['read'],
        expiresAt: new Date(Date.now() + 60000),
        user: { id: 'user-1', tokenVersion: 2, role: 'user', adminRoleVersion: 0, suspendedAt: null },
      } as never);

      const mockSet = vi.fn(() => ({ where: vi.fn() }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);

      const result = await service.validateSession('ps_sess_valid');
      expect(result).toBeNull();
    });

    it('should return claims for valid session', async () => {
      vi.mocked(isValidTokenFormat).mockReturnValue(true);
      const expiresAt = new Date(Date.now() + 60000);
      vi.mocked(db.query.sessions.findFirst).mockResolvedValue({
        id: 'sess-1',
        userId: 'user-1',
        tokenVersion: 1,
        adminRoleVersion: 0,
        type: 'user',
        scopes: ['read', 'write'],
        expiresAt,
        resourceType: null,
        resourceId: null,
        driveId: null,
        lastUsedAt: null,
        user: { id: 'user-1', tokenVersion: 1, role: 'admin', adminRoleVersion: 0, suspendedAt: null },
      } as never);

      const mockCatch = vi.fn();
      const mockWhere = vi.fn(() => ({ catch: mockCatch }));
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);

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
    });
  });

  describe('revokeSession', () => {
    it('should update session with revoked reason', async () => {
      const mockWhere = vi.fn();
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);

      await service.revokeSession('ps_sess_token', 'user_logout');
      expect(db.update).toHaveBeenCalledTimes(1);
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ revokedReason: 'user_logout' })
      );
    });
  });

  describe('revokeAllUserSessions', () => {
    it('should revoke all active sessions for a user', async () => {
      const mockWhere = vi.fn().mockResolvedValue({ rowCount: 3 });
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);

      const count = await service.revokeAllUserSessions('user-1', 'password_change');
      expect(count).toBe(3);
    });

    it('should return 0 when rowCount is null', async () => {
      const mockWhere = vi.fn().mockResolvedValue({ rowCount: null });
      const mockSet = vi.fn(() => ({ where: mockWhere }));
      vi.mocked(db.update).mockReturnValue({ set: mockSet } as never);

      const count = await service.revokeAllUserSessions('user-1', 'test');
      expect(count).toBe(0);
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('should delete expired sessions and return count', async () => {
      const mockWhere = vi.fn().mockResolvedValue({ rowCount: 5 });
      vi.mocked(db.delete).mockReturnValue({ where: mockWhere } as never);

      const count = await service.cleanupExpiredSessions();
      expect(count).toBe(5);
    });

    it('should return 0 when rowCount is null', async () => {
      const mockWhere = vi.fn().mockResolvedValue({ rowCount: null });
      vi.mocked(db.delete).mockReturnValue({ where: mockWhere } as never);

      const count = await service.cleanupExpiredSessions();
      expect(count).toBe(0);
    });
  });
});
