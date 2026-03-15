/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// Contract Tests for /api/user/integrations/callback
//
// Tests the OAuth callback GET handler that exchanges codes for tokens,
// creates/updates connections, and redirects users.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {},
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/integrations', () => ({
  verifySignedState: vi.fn(),
  exchangeOAuthCode: vi.fn(),
  encryptCredentials: vi.fn(),
  getProviderById: vi.fn(),
  createConnection: vi.fn(),
  findUserConnection: vi.fn(),
  findDriveConnection: vi.fn(),
  updateConnectionCredentials: vi.fn(),
  updateConnectionStatus: vi.fn(),
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: vi.fn(),
}));

import {
  verifySignedState,
  exchangeOAuthCode,
  encryptCredentials,
  getProviderById,
  createConnection,
  findUserConnection,
  findDriveConnection,
  updateConnectionCredentials,
  updateConnectionStatus,
} from '@pagespace/lib/integrations';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import { GET } from '../route';

// ============================================================================
// Test Helpers
// ============================================================================

const env = process.env;

const createCallbackRequest = (params: Record<string, string> = {}) => {
  const url = new URL('https://example.com/api/user/integrations/callback');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString());
};

const mockProvider = (overrides: Record<string, unknown> = {}) => ({
  id: 'provider_1',
  slug: 'github',
  enabled: true,
  config: {
    authMethod: {
      type: 'oauth2',
      config: {
        authorizationUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        scopes: ['repo'],
      },
    },
  },
  ...overrides,
});

const mockStateData = (overrides: Record<string, unknown> = {}) => ({
  userId: 'user_1',
  providerId: 'provider_1',
  name: 'GitHub Integration',
  visibility: 'owned_drives',
  returnUrl: '/settings/integrations',
  ...overrides,
});

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/user/integrations/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...env };
    process.env.OAUTH_STATE_SECRET = 'test-secret';
    process.env.WEB_APP_URL = 'https://example.com';
    process.env.INTEGRATION_GITHUB_CLIENT_ID = 'client-id';
    process.env.INTEGRATION_GITHUB_CLIENT_SECRET = 'client-secret';

    vi.mocked(verifySignedState).mockReturnValue(mockStateData());
    vi.mocked(getProviderById).mockResolvedValue(mockProvider() as any);
    vi.mocked(exchangeOAuthCode).mockResolvedValue({
      accessToken: 'access-token-123',
      refreshToken: 'refresh-token-456',
      expiresIn: 3600,
    });
    vi.mocked(encryptCredentials).mockResolvedValue('encrypted_creds');
    vi.mocked(findUserConnection).mockResolvedValue(null);
    vi.mocked(createConnection).mockResolvedValue({ id: 'conn_new' } as any);
  });

  afterAll(() => {
    process.env = env;
  });

  describe('configuration errors', () => {
    it('should redirect with error when OAUTH_STATE_SECRET is missing', async () => {
      delete process.env.OAUTH_STATE_SECRET;

      const response = await GET(createCallbackRequest({ code: 'abc', state: 'xyz' }));

      expect(response.status).toBe(307);
      const location = response.headers.get('Location');
      expect(location).toContain('error=oauth_config');
    });
  });

  describe('OAuth error handling', () => {
    it('should redirect with access_denied when provider returns error', async () => {
      const response = await GET(
        createCallbackRequest({ error: 'access_denied' })
      );

      expect(response.status).toBe(307);
      const location = response.headers.get('Location');
      expect(location).toContain('error=access_denied');
    });

    it('should redirect with oauth_error for other provider errors', async () => {
      const response = await GET(
        createCallbackRequest({ error: 'server_error' })
      );

      expect(response.status).toBe(307);
      const location = response.headers.get('Location');
      expect(location).toContain('error=oauth_error');
    });

    it('should redirect with invalid_request when code or state missing', async () => {
      const response = await GET(createCallbackRequest({ code: 'abc' }));

      expect(response.status).toBe(307);
      const location = response.headers.get('Location');
      expect(location).toContain('error=invalid_request');
    });

    it('should redirect with invalid_request when only state is provided', async () => {
      const response = await GET(createCallbackRequest({ state: 'xyz' }));

      expect(response.status).toBe(307);
      const location = response.headers.get('Location');
      expect(location).toContain('error=invalid_request');
    });
  });

  describe('state verification', () => {
    it('should redirect with invalid_state when state verification fails', async () => {
      vi.mocked(verifySignedState).mockReturnValue(null);

      const response = await GET(
        createCallbackRequest({ code: 'abc', state: 'invalid' })
      );

      expect(response.status).toBe(307);
      const location = response.headers.get('Location');
      expect(location).toContain('error=invalid_state');
    });
  });

  describe('provider validation', () => {
    it('should redirect with error when provider not found', async () => {
      vi.mocked(getProviderById).mockResolvedValue(null);

      const response = await GET(
        createCallbackRequest({ code: 'abc', state: 'valid' })
      );

      expect(response.status).toBe(307);
      const location = response.headers.get('Location');
      expect(location).toContain('error=provider_not_found');
    });

    it('should redirect with error when provider is not OAuth', async () => {
      vi.mocked(getProviderById).mockResolvedValue(
        mockProvider({ config: { authMethod: { type: 'api_key' } } }) as any
      );

      const response = await GET(
        createCallbackRequest({ code: 'abc', state: 'valid' })
      );

      expect(response.status).toBe(307);
      const location = response.headers.get('Location');
      expect(location).toContain('error=not_oauth');
    });
  });

  describe('client credentials', () => {
    it('should redirect with error when client credentials are missing', async () => {
      delete process.env.INTEGRATION_GITHUB_CLIENT_ID;
      delete process.env.INTEGRATION_GITHUB_CLIENT_SECRET;

      const response = await GET(
        createCallbackRequest({ code: 'abc', state: 'valid' })
      );

      expect(response.status).toBe(307);
      const location = response.headers.get('Location');
      expect(location).toContain('error=oauth_config');
    });
  });

  describe('token exchange', () => {
    it('should redirect with missing_tokens when accessToken is empty', async () => {
      vi.mocked(exchangeOAuthCode).mockResolvedValue({
        accessToken: '',
        refreshToken: null,
        expiresIn: null,
      });

      const response = await GET(
        createCallbackRequest({ code: 'abc', state: 'valid' })
      );

      expect(response.status).toBe(307);
      const location = response.headers.get('Location');
      expect(location).toContain('error=missing_tokens');
    });
  });

  describe('user-scoped connection (no driveId)', () => {
    it('should create a new user connection', async () => {
      const response = await GET(
        createCallbackRequest({ code: 'abc', state: 'valid' })
      );

      expect(response.status).toBe(307);
      const location = response.headers.get('Location');
      expect(location).toContain('connected=true');
      expect(createConnection).toHaveBeenCalled();
    });

    it('should update existing user connection', async () => {
      vi.mocked(findUserConnection).mockResolvedValue({ id: 'existing_conn' } as any);

      const response = await GET(
        createCallbackRequest({ code: 'abc', state: 'valid' })
      );

      expect(response.status).toBe(307);
      expect(updateConnectionCredentials).toHaveBeenCalledWith(
        expect.anything(),
        'existing_conn',
        'encrypted_creds'
      );
      expect(updateConnectionStatus).toHaveBeenCalledWith(
        expect.anything(),
        'existing_conn',
        'active'
      );
    });
  });

  describe('drive-scoped connection', () => {
    beforeEach(() => {
      vi.mocked(verifySignedState).mockReturnValue(
        mockStateData({ driveId: 'drive_1' })
      );
    });

    it('should redirect with access_denied when user lacks admin access', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: false,
        isAdmin: false,
        isMember: true,
      } as any);

      const response = await GET(
        createCallbackRequest({ code: 'abc', state: 'valid' })
      );

      expect(response.status).toBe(307);
      const location = response.headers.get('Location');
      expect(location).toContain('error=access_denied');
    });

    it('should create new drive connection when admin', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true,
        isAdmin: true,
        isMember: true,
      } as any);
      vi.mocked(findDriveConnection).mockResolvedValue(null);

      const response = await GET(
        createCallbackRequest({ code: 'abc', state: 'valid' })
      );

      expect(response.status).toBe(307);
      expect(createConnection).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ driveId: 'drive_1' })
      );
    });

    it('should update existing drive connection', async () => {
      vi.mocked(getDriveAccess).mockResolvedValue({
        isOwner: true,
        isAdmin: true,
        isMember: true,
      } as any);
      vi.mocked(findDriveConnection).mockResolvedValue({ id: 'drive_conn' } as any);

      const response = await GET(
        createCallbackRequest({ code: 'abc', state: 'valid' })
      );

      expect(response.status).toBe(307);
      expect(updateConnectionCredentials).toHaveBeenCalledWith(
        expect.anything(),
        'drive_conn',
        'encrypted_creds'
      );
    });
  });

  describe('return URL safety', () => {
    it('should redirect to returnUrl when safe', async () => {
      vi.mocked(verifySignedState).mockReturnValue(
        mockStateData({ returnUrl: '/drives/my-drive/settings' })
      );

      const response = await GET(
        createCallbackRequest({ code: 'abc', state: 'valid' })
      );

      expect(response.status).toBe(307);
      const location = response.headers.get('Location');
      expect(location).toContain('/drives/my-drive/settings');
    });

    it('should fallback to default return for unsafe URL (starts with //)', async () => {
      vi.mocked(verifySignedState).mockReturnValue(
        mockStateData({ returnUrl: '//evil.com' })
      );

      const response = await GET(
        createCallbackRequest({ code: 'abc', state: 'valid' })
      );

      expect(response.status).toBe(307);
      const location = response.headers.get('Location');
      expect(location).toContain('/settings/integrations');
    });

    it('should fallback for URL with backslashes', async () => {
      vi.mocked(verifySignedState).mockReturnValue(
        mockStateData({ returnUrl: '/test\\evil' })
      );

      const response = await GET(
        createCallbackRequest({ code: 'abc', state: 'valid' })
      );

      expect(response.status).toBe(307);
      const location = response.headers.get('Location');
      expect(location).toContain('/settings/integrations');
    });
  });

  describe('error handling', () => {
    it('should redirect with unexpected error on exception', async () => {
      vi.mocked(verifySignedState).mockImplementation(() => {
        throw new Error('Crash');
      });

      const response = await GET(
        createCallbackRequest({ code: 'abc', state: 'valid' })
      );

      expect(response.status).toBe(307);
      const location = response.headers.get('Location');
      expect(location).toContain('error=unexpected');
    });
  });
});
