/**
 * Security audit tests for /api/user/assistant-config
 * Verifies securityAudit.logDataAccess is called for GET and PUT.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetOrCreateConfig = vi.hoisted(() => vi.fn());
const mockUpdateConfig = vi.hoisted(() => vi.fn());

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
  getOrCreateConfig: mockGetOrCreateConfig,
  updateConfig: mockUpdateConfig,
}));

import { GET, PUT } from '../route';
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

const mockConfig = {
  enabledUserIntegrations: null,
  driveOverrides: {},
  inheritDriveIntegrations: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('GET /api/user/assistant-config audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    mockGetOrCreateConfig.mockResolvedValue(mockConfig);
  });

  it('logs read audit event on successful config retrieval', async () => {
    await GET(new Request('http://localhost/api/user/assistant-config'));

    expect(securityAudit.logDataAccess).toHaveBeenCalledWith(
      mockUserId, 'read', 'assistant_config', 'self'
    );
  });
});

describe('PUT /api/user/assistant-config audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    mockUpdateConfig.mockResolvedValue(mockConfig);
  });

  it('logs write audit event on successful config update', async () => {
    const request = new Request('http://localhost/api/user/assistant-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inheritDriveIntegrations: false }),
    });

    await PUT(request);

    expect(securityAudit.logDataAccess).toHaveBeenCalledWith(
      mockUserId, 'write', 'assistant_config', 'self'
    );
  });
});
