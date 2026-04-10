/**
 * Security audit tests for /api/user/integrations
 * Verifies securityAudit.logDataAccess is called for GET.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockListUserConnections = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db', () => ({ db: {} }));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  securityAudit: {
    logDataAccess: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@pagespace/lib/integrations', () => ({
  listUserConnections: mockListUserConnections,
  createConnection: vi.fn(),
  getProviderById: vi.fn(),
  findUserConnection: vi.fn(),
  encryptCredentials: vi.fn(),
  buildOAuthAuthorizationUrl: vi.fn(),
  createSignedState: vi.fn(),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { securityAudit } from '@pagespace/lib/server';

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

describe('GET /api/user/integrations audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    mockListUserConnections.mockResolvedValue([]);
  });

  it('logs read audit event on successful integrations retrieval', async () => {
    await GET(new Request('http://localhost/api/user/integrations'));

    expect(securityAudit.logDataAccess).toHaveBeenCalledWith(
      mockUserId, 'read', 'user_integrations', mockUserId
    );
  });
});
