/**
 * Security audit tests for /api/user/favorites/reorder
 * Verifies auditRequest is called for PATCH.
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
        findMany: vi.fn().mockResolvedValue([{ id: 'fav-1' }, { id: 'fav-2' }]),
      },
    },
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      });
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  favorites: { id: 'id', userId: 'userId', position: 'position' },
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

import { PATCH } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const mockUserId = 'user_123';

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

describe('PATCH /api/user/favorites/reorder audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
  });

  it('logs write audit event with reorder action', async () => {
    const request = new Request('http://localhost/api/user/favorites/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds: ['fav-1', 'fav-2'] }),
    });

    await PATCH(request);

    expect(auditRequest).toHaveBeenCalledWith(
      request,
      { eventType: 'data.write', userId: mockUserId, resourceType: 'favorites', resourceId: 'self', details: { action: 'reorder' } }
    );
  });
});
