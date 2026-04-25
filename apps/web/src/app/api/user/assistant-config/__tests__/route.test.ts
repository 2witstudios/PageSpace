/**
 * Security audit tests for /api/user/assistant-config
 * Verifies auditRequest is called for GET and PUT.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetOrCreateConfig = vi.hoisted(() => vi.fn());
const mockUpdateConfig = vi.hoisted(() => vi.fn());

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {},
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

vi.mock('@pagespace/lib/integrations/repositories/config-repository', () => ({
  getOrCreateConfig: mockGetOrCreateConfig,
  updateConfig: mockUpdateConfig,
}));

import { GET, PUT } from '../route';
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
    const request = new Request('http://localhost/api/user/assistant-config');
    await GET(request);

    expect(auditRequest).toHaveBeenCalledWith(
      request,
      { eventType: 'data.read', userId: mockUserId, resourceType: 'assistant_config', resourceId: 'self' }
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

    expect(auditRequest).toHaveBeenCalledWith(
      request,
      { eventType: 'data.write', userId: mockUserId, resourceType: 'assistant_config', resourceId: 'self' }
    );
  });
});
