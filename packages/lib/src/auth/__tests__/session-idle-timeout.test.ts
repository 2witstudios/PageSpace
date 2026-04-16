import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../session-repository', () => ({
  sessionRepository: {
    findUserById: vi.fn(),
    findActiveSession: vi.fn(),
    insertSession: vi.fn(),
    touchSession: vi.fn(),
    revokeByHash: vi.fn(),
    revokeAllForUser: vi.fn(),
    revokeForUserDevice: vi.fn(),
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

// 15-minute idle timeout for these tests
vi.mock('../constants', () => ({
  IDLE_TIMEOUT_MS: 15 * 60 * 1000,
}));

import { SessionService } from '../session-service';
import { sessionRepository } from '../session-repository';
import type { SessionRecord } from '../session-repository';

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess-1',
    userId: 'user-1',
    tokenHash: 'h',
    tokenVersion: 1,
    adminRoleVersion: 0,
    type: 'user',
    scopes: ['read'],
    expiresAt: new Date(Date.now() + 3600000),
    lastUsedAt: null,
    createdAt: new Date(),
    resourceType: null,
    resourceId: null,
    driveId: null,
    user: {
      id: 'user-1',
      tokenVersion: 1,
      role: 'user',
      adminRoleVersion: 0,
      suspendedAt: null,
    },
    ...overrides,
  };
}

describe('SessionService HIPAA idle timeout', () => {
  let service: SessionService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SessionService();
  });

  describe('when lastUsedAt is NULL (createdAt fallback)', () => {
    it('allows session when createdAt is within idle timeout', async () => {
      vi.mocked(sessionRepository.findActiveSession).mockResolvedValue(
        makeSession({
          lastUsedAt: null,
          createdAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago
        }),
      );

      const result = await service.validateSession('ps_sess_valid');

      expect(result).not.toBeNull();
      expect(result?.sessionId).toBe('sess-1');
      expect(sessionRepository.revokeByHash).not.toHaveBeenCalled();
    });

    it('revokes session when createdAt exceeds idle timeout', async () => {
      vi.mocked(sessionRepository.findActiveSession).mockResolvedValue(
        makeSession({
          lastUsedAt: null,
          createdAt: new Date(Date.now() - 20 * 60 * 1000), // 20 min ago
        }),
      );
      vi.mocked(sessionRepository.revokeByHash).mockResolvedValue(undefined);

      const result = await service.validateSession('ps_sess_valid');

      expect(result).toBeNull();
      expect(sessionRepository.revokeByHash).toHaveBeenCalledWith(
        'hashed_ps_sess_valid',
        'idle_timeout',
      );
    });
  });

  describe('when lastUsedAt is present', () => {
    it('allows session when lastUsedAt is within idle timeout', async () => {
      vi.mocked(sessionRepository.findActiveSession).mockResolvedValue(
        makeSession({
          lastUsedAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago
          createdAt: new Date(Date.now() - 60 * 60 * 1000), // created 1hr ago
        }),
      );

      const result = await service.validateSession('ps_sess_valid');

      expect(result).not.toBeNull();
      expect(sessionRepository.revokeByHash).not.toHaveBeenCalled();
    });

    it('revokes session when lastUsedAt exceeds idle timeout', async () => {
      vi.mocked(sessionRepository.findActiveSession).mockResolvedValue(
        makeSession({
          lastUsedAt: new Date(Date.now() - 20 * 60 * 1000), // 20 min ago
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
        }),
      );
      vi.mocked(sessionRepository.revokeByHash).mockResolvedValue(undefined);

      const result = await service.validateSession('ps_sess_valid');

      expect(result).toBeNull();
      expect(sessionRepository.revokeByHash).toHaveBeenCalledWith(
        'hashed_ps_sess_valid',
        'idle_timeout',
      );
    });
  });
});
