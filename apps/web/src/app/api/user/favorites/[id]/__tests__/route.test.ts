/**
 * Security audit tests for /api/user/favorites/[id]
 * Verifies securityAudit.logDataAccess is called for DELETE.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      favorites: {
        findFirst: vi.fn().mockResolvedValue({ id: 'fav-1', userId: 'user_123' }),
      },
    },
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  },
  favorites: { id: 'id', userId: 'userId' },
  eq: vi.fn(),
  and: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  securityAudit: {
    logDataAccess: vi.fn().mockResolvedValue(undefined),
  },
}));

import { DELETE } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { securityAudit } from '@pagespace/lib/server';

const mockUserId = 'user_123';
const mockFavoriteId = 'fav-1';

const mockAuth = () => {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
    userId: mockUserId,
    tokenVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'test-session',
    role: 'user' as const,
    adminRoleVersion: 0,
  });
};

describe('DELETE /api/user/favorites/[id] audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('logs delete audit event on successful favorite deletion', async () => {
    await DELETE(
      new Request('http://localhost/api/user/favorites/fav-1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: mockFavoriteId }) }
    );

    expect(securityAudit.logDataAccess).toHaveBeenCalledWith(
      mockUserId, 'delete', 'favorite', mockFavoriteId
    );
  });
});
