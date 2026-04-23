/**
 * Security audit tests for /api/user/integrations
 * Verifies auditRequest is called for GET.
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
  audit: vi.fn(),
  auditRequest: vi.fn(),
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

describe('GET /api/user/integrations audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    mockListUserConnections.mockResolvedValue([]);
  });

  it('logs read audit event on successful integrations retrieval', async () => {
    const req = new Request('http://localhost/api/user/integrations');
    await GET(req);

    expect(auditRequest).toHaveBeenCalledWith(
      req,
      { eventType: 'data.read', userId: mockUserId, resourceType: 'user_integrations', resourceId: 'self' }
    );
  });
});
