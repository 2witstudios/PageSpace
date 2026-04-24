/**
 * Security audit tests for /api/user/integrations/[connectionId]
 * Verifies audit is called for DELETE.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetConnectionById = vi.hoisted(() => vi.fn());
const mockDeleteConnection = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  },
  integrationConnections: { id: 'id' },
  eq: vi.fn(),
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

vi.mock('@pagespace/lib/integrations/repositories/connection-repository', () => ({
  getConnectionById: mockGetConnectionById,
  deleteConnection: mockDeleteConnection,
}));

import { DELETE } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const mockUserId = 'user_123';
const mockConnectionId = 'conn-1';

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

describe('DELETE /api/user/integrations/[connectionId] audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    mockGetConnectionById.mockResolvedValue({ id: mockConnectionId, userId: mockUserId });
    mockDeleteConnection.mockResolvedValue(undefined);
  });

  it('logs token revoked audit event on successful integration deletion', async () => {
    const request = new Request('http://localhost/api/user/integrations/conn-1', { method: 'DELETE' });
    await DELETE(
      request,
      { params: Promise.resolve({ connectionId: mockConnectionId }) }
    );

    expect(auditRequest).toHaveBeenCalledWith(
      request,
      { eventType: 'auth.token.revoked', userId: mockUserId, details: { tokenType: 'integration', reason: 'user_disconnect' } }
    );
  });
});
