/**
 * Security audit tests for /api/user/favorites/[id]
 * Verifies auditRequest is called for DELETE.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db/db', () => ({
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
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  favorites: { id: 'id', userId: 'userId' },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

import { DELETE } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

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
    const request = new Request('http://localhost/api/user/favorites/fav-1', { method: 'DELETE' });
    await DELETE(
      request,
      { params: Promise.resolve({ id: mockFavoriteId }) }
    );

    expect(auditRequest).toHaveBeenCalledWith(
      request,
      { eventType: 'data.delete', userId: mockUserId, resourceType: 'favorite', resourceId: mockFavoriteId }
    );
  });
});
