/**
 * Security audit tests for /api/user/integrations
 * Verifies auditRequest is called for GET.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockListUserConnections = vi.hoisted(() => vi.fn());

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

vi.mock('@pagespace/lib/integrations/repositories/connection-repository', () => ({
  listUserConnections: mockListUserConnections,
  createConnection: vi.fn(),
  findUserConnection: vi.fn(),
}));
vi.mock('@pagespace/lib/integrations/repositories/provider-repository', () => ({
  getProviderById: vi.fn(),
}));
vi.mock('@pagespace/lib/integrations/credentials/encrypt-credentials', () => ({
  encryptCredentials: vi.fn(),
}));
vi.mock('@pagespace/lib/integrations/oauth/oauth-handler', () => ({
  buildOAuthAuthorizationUrl: vi.fn(),
}));
vi.mock('@pagespace/lib/integrations/oauth/oauth-state', () => ({
  createSignedState: vi.fn(),
}));

import { GET, POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getProviderById } from '@pagespace/lib/integrations/repositories/provider-repository';
import { findUserConnection } from '@pagespace/lib/integrations/repositories/connection-repository';
import { buildOAuthAuthorizationUrl } from '@pagespace/lib/integrations/oauth/oauth-handler';
import { createSignedState } from '@pagespace/lib/integrations/oauth/oauth-state';
import { builtinProviders } from '@pagespace/lib/integrations/providers/builtin-providers';

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

describe('POST /api/user/integrations OAuth flow', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ['OAUTH_STATE_SECRET', 'WEB_APP_URL', 'INTEGRATION_GITHUB_CLIENT_ID'] as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    for (const key of envKeys) savedEnv[key] = process.env[key];
    process.env.OAUTH_STATE_SECRET = 'test-secret';
    process.env.WEB_APP_URL = 'https://app.example.com';
    process.env.INTEGRATION_GITHUB_CLIENT_ID = 'client-id-123';
    vi.mocked(findUserConnection).mockResolvedValue(null);
    vi.mocked(createSignedState).mockReturnValue('signed-state-token');
    vi.mocked(buildOAuthAuthorizationUrl).mockReturnValue('https://github.com/login/oauth/authorize?state=signed-state-token');
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('builds the authorize URL from the canonical builtin config, not a stale persisted copy', async () => {
    vi.mocked(getProviderById).mockResolvedValue({
      id: 'prov-oauth',
      slug: 'github',
      providerType: 'builtin',
      enabled: true,
      config: {
        authMethod: {
          type: 'oauth2',
          // Persisted config has drifted from what's shipped in code.
          config: { authorizationUrl: 'https://stale.example.com/authorize', scopes: [] },
        },
      },
    } as never);

    const request = new Request('http://localhost/api/user/integrations', {
      method: 'POST',
      body: JSON.stringify({ providerId: 'prov-oauth', name: 'GitHub' }),
    });
    const response = await POST(request);

    expect(response.status).toBe(200);
    const canonicalAuthMethod = builtinProviders.github.authMethod;
    expect(buildOAuthAuthorizationUrl).toHaveBeenCalledWith(
      canonicalAuthMethod.type === 'oauth2' ? canonicalAuthMethod.config : undefined,
      expect.anything()
    );
  });
});
