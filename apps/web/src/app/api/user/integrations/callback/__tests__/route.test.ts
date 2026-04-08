/**
 * Contract tests for GET /api/user/integrations/callback
 *
 * Tests the OAuth callback endpoint for third-party integrations (GitHub, Calendar, etc.).
 * Verifies input validation, state verification, error handling, and connection creation.
 *
 * Coverage:
 * - OAuth error handling (access_denied, generic errors, log sanitization)
 * - Zod validation of callback parameters (code, state)
 * - HMAC state verification via verifySignedState
 * - Token exchange and connection creation/update
 * - Drive-scoped vs user-scoped connections
 * - Return URL safety validation
 * - Missing configuration handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock next/server before importing route
vi.mock('next/server', () => {
  class MockNextResponse {
    static redirect(url: string | URL, init?: number | ResponseInit) {
      const status = typeof init === 'number' ? init : init?.status ?? 307;
      const headers = new Headers(typeof init === 'object' ? init?.headers : undefined);
      const urlStr = url instanceof URL ? url.toString() : url;
      headers.set('location', urlStr);
      return new Response(null, { status, headers });
    }
  }
  return { NextResponse: MockNextResponse };
});

// Hoisted mocks
const mockVerifySignedState = vi.hoisted(() => vi.fn());
const mockExchangeOAuthCode = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ accessToken: 'mock-access-token', refreshToken: 'mock-refresh-token', expiresIn: 3600 })
);
const mockEncryptCredentials = vi.hoisted(() =>
  vi.fn().mockResolvedValue('encrypted-credentials-blob')
);
const mockGetProviderById = vi.hoisted(() => vi.fn());
const mockCreateConnection = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'conn-1' }));
const mockFindUserConnection = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockFindDriveConnection = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockUpdateConnectionCredentials = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockUpdateConnectionStatus = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockGetDriveAccess = vi.hoisted(() => vi.fn());
const mockLoggers = vi.hoisted(() => ({
  auth: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@pagespace/db', () => ({
  db: {},
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: mockLoggers,
}));

vi.mock('@pagespace/lib/integrations', () => ({
  verifySignedState: mockVerifySignedState,
  exchangeOAuthCode: mockExchangeOAuthCode,
  encryptCredentials: mockEncryptCredentials,
  getProviderById: mockGetProviderById,
  createConnection: mockCreateConnection,
  findUserConnection: mockFindUserConnection,
  findDriveConnection: mockFindDriveConnection,
  updateConnectionCredentials: mockUpdateConnectionCredentials,
  updateConnectionStatus: mockUpdateConnectionStatus,
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: mockGetDriveAccess,
}));

import { GET } from '../route';

// Test fixtures
const BASE_URL = 'http://localhost:3000';
const DEFAULT_RETURN = '/settings/integrations';

const mockProvider = {
  id: 'provider-1',
  slug: 'github',
  name: 'GitHub',
  config: {
    authMethod: {
      type: 'oauth2',
      config: {
        authUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        scopes: ['repo'],
      },
    },
  },
};

const mockStateData = {
  userId: 'user-123',
  providerId: 'provider-1',
  name: 'My GitHub',
  returnUrl: '/settings/integrations',
  timestamp: Date.now(),
};

function createCallbackRequest(params: Record<string, string> = {}): Request {
  const url = new URL(`${BASE_URL}/api/user/integrations/callback`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString(), { method: 'GET' });
}

function getRedirectUrl(response: Response): URL {
  const location = response.headers.get('location');
  return new URL(location!);
}

describe('GET /api/user/integrations/callback', () => {
  const envKeys = [
    'OAUTH_STATE_SECRET',
    'WEB_APP_URL',
    'INTEGRATION_GITHUB_CLIENT_ID',
    'INTEGRATION_GITHUB_CLIENT_SECRET',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.resetAllMocks();

    // Save original env
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }

    // Default env
    process.env.OAUTH_STATE_SECRET = 'test-oauth-secret';
    process.env.WEB_APP_URL = BASE_URL;
    process.env.INTEGRATION_GITHUB_CLIENT_ID = 'gh-client-id';
    process.env.INTEGRATION_GITHUB_CLIENT_SECRET = 'gh-client-secret';

    // Default mock behaviors (must re-establish after resetAllMocks)
    mockGetProviderById.mockResolvedValue(mockProvider);
    mockVerifySignedState.mockReturnValue(mockStateData);
    mockExchangeOAuthCode.mockResolvedValue({ accessToken: 'mock-access-token', refreshToken: 'mock-refresh-token', expiresIn: 3600 });
    mockEncryptCredentials.mockResolvedValue('encrypted-credentials-blob');
    mockCreateConnection.mockResolvedValue({ id: 'conn-1' });
    mockFindUserConnection.mockResolvedValue(null);
    mockFindDriveConnection.mockResolvedValue(null);
    mockUpdateConnectionCredentials.mockResolvedValue(undefined);
    mockUpdateConnectionStatus.mockResolvedValue(undefined);
    mockGetDriveAccess.mockResolvedValue({ isOwner: true, isAdmin: true });
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  // ── Alert #98: OAuth error handling ──────────────────────────────

  describe('Alert #98: OAuth error handling', () => {
    it('redirects with access_denied when provider returns access_denied', async () => {
      const request = createCallbackRequest({ error: 'access_denied' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const url = getRedirectUrl(response);
      expect(url.searchParams.get('error')).toBe('access_denied');
    });

    it('redirects with oauth_error for other provider errors', async () => {
      const request = createCallbackRequest({ error: 'server_error' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const url = getRedirectUrl(response);
      expect(url.searchParams.get('error')).toBe('oauth_error');
    });

    it('truncates error string to 100 chars in log output', async () => {
      const longError = 'x'.repeat(200);
      const request = createCallbackRequest({ error: longError });
      await GET(request);

      expect(mockLoggers.auth.warn).toHaveBeenCalledWith(
        'OAuth integration error',
        { error: 'x'.repeat(100) }
      );
    });

    it('does not include raw error value in redirect URL', async () => {
      const request = createCallbackRequest({ error: 'malicious<script>alert(1)</script>' });
      const response = await GET(request);

      const url = getRedirectUrl(response);
      const errorParam = url.searchParams.get('error');
      // Only hardcoded values allowed
      expect(['access_denied', 'oauth_error']).toContain(errorParam);
    });

    it('does not call exchangeOAuthCode when error is present', async () => {
      const request = createCallbackRequest({ error: 'access_denied' });
      await GET(request);

      expect(mockExchangeOAuthCode).not.toHaveBeenCalled();
    });
  });

  // ── Alerts #99/#100: Input validation ────────────────────────────

  describe('Alerts #99/#100: Input validation', () => {
    it('redirects with invalid_request when code is missing', async () => {
      const request = createCallbackRequest({ state: 'some-state' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const url = getRedirectUrl(response);
      expect(url.searchParams.get('error')).toBe('invalid_request');
    });

    it('redirects with invalid_request when state is missing', async () => {
      const request = createCallbackRequest({ code: 'some-code' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const url = getRedirectUrl(response);
      expect(url.searchParams.get('error')).toBe('invalid_request');
    });

    it('redirects with invalid_request when both code and state are missing', async () => {
      const request = createCallbackRequest({});
      const response = await GET(request);

      expect(response.status).toBe(307);
      const url = getRedirectUrl(response);
      expect(url.searchParams.get('error')).toBe('invalid_request');
    });

    it('does not call verifySignedState when validation fails', async () => {
      const request = createCallbackRequest({ code: 'some-code' }); // no state
      await GET(request);

      expect(mockVerifySignedState).not.toHaveBeenCalled();
    });

    it('does not call exchangeOAuthCode when validation fails', async () => {
      const request = createCallbackRequest({ state: 'some-state' }); // no code
      await GET(request);

      expect(mockExchangeOAuthCode).not.toHaveBeenCalled();
    });

    it('accepts valid code and state strings', async () => {
      const request = createCallbackRequest({ code: 'auth-code-123', state: 'valid-state' });
      await GET(request);

      expect(mockVerifySignedState).toHaveBeenCalledWith('valid-state', 'test-oauth-secret');
    });
  });

  // ── Alert #101: State verification ───────────────────────────────

  describe('Alert #101: State verification', () => {
    it('redirects with invalid_state when verifySignedState returns null', async () => {
      mockVerifySignedState.mockReturnValueOnce(null);
      const request = createCallbackRequest({ code: 'auth-code', state: 'invalid-state' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const url = getRedirectUrl(response);
      expect(url.searchParams.get('error')).toBe('invalid_state');
    });

    it('logs warning when state verification fails', async () => {
      mockVerifySignedState.mockReturnValueOnce(null);
      const request = createCallbackRequest({ code: 'auth-code', state: 'invalid-state' });
      await GET(request);

      expect(mockLoggers.auth.warn).toHaveBeenCalledWith(
        'Invalid or expired OAuth state for integration callback'
      );
    });

    it('proceeds with token exchange when state is valid', async () => {
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      await GET(request);

      expect(mockExchangeOAuthCode).toHaveBeenCalled();
    });
  });

  // ── Configuration errors ─────────────────────────────────────────

  describe('Configuration errors', () => {
    it('redirects with oauth_config when OAUTH_STATE_SECRET is missing', async () => {
      delete process.env.OAUTH_STATE_SECRET;
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const url = getRedirectUrl(response);
      expect(url.searchParams.get('error')).toBe('oauth_config');
    });

    it('redirects with oauth_config when client credentials are missing', async () => {
      delete process.env.INTEGRATION_GITHUB_CLIENT_ID;
      delete process.env.INTEGRATION_GITHUB_CLIENT_SECRET;
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const url = getRedirectUrl(response);
      expect(url.searchParams.get('error')).toBe('oauth_config');
    });

    it('redirects with provider_not_found when provider does not exist', async () => {
      mockGetProviderById.mockResolvedValueOnce(null);
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const url = getRedirectUrl(response);
      expect(url.searchParams.get('error')).toBe('provider_not_found');
    });

    it('redirects with not_oauth when provider is not OAuth2', async () => {
      mockGetProviderById.mockResolvedValueOnce({
        ...mockProvider,
        config: { authMethod: { type: 'api_key' } },
      });
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const url = getRedirectUrl(response);
      expect(url.searchParams.get('error')).toBe('not_oauth');
    });
  });

  // ── Happy path: user-scoped connection ───────────────────────────

  describe('User-scoped connection', () => {
    it('creates new connection with default visibility when none exists', async () => {
      mockFindUserConnection.mockResolvedValueOnce(null);
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      await GET(request);

      expect(mockCreateConnection).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          providerId: 'provider-1',
          userId: 'user-123',
          name: 'My GitHub',
          status: 'active',
          visibility: 'owned_drives',
        })
      );
    });

    it('creates connection with explicit visibility from state', async () => {
      mockVerifySignedState.mockReturnValueOnce({
        ...mockStateData,
        visibility: 'private',
      });
      mockFindUserConnection.mockResolvedValueOnce(null);
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      await GET(request);

      expect(mockCreateConnection).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          visibility: 'private',
        })
      );
    });

    it('falls back to default visibility for invalid value', async () => {
      mockVerifySignedState.mockReturnValueOnce({
        ...mockStateData,
        visibility: 'bogus_value',
      });
      mockFindUserConnection.mockResolvedValueOnce(null);
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      await GET(request);

      expect(mockCreateConnection).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          visibility: 'owned_drives',
        })
      );
    });

    it('updates existing connection credentials and visibility', async () => {
      const existing = { id: 'existing-conn-1' };
      mockFindUserConnection.mockResolvedValueOnce(existing);
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      await GET(request);

      expect(mockUpdateConnectionCredentials).toHaveBeenCalledWith(
        expect.anything(),
        'existing-conn-1',
        'encrypted-credentials-blob',
        'owned_drives'
      );
      expect(mockUpdateConnectionStatus).toHaveBeenCalledWith(
        expect.anything(),
        'existing-conn-1',
        'active'
      );
      expect(mockCreateConnection).not.toHaveBeenCalled();
    });

    it('redirects to returnUrl with connected=true on success', async () => {
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const url = getRedirectUrl(response);
      expect(url.pathname).toBe('/settings/integrations');
      expect(url.searchParams.get('connected')).toBe('true');
    });
  });

  // ── Drive-scoped connection ──────────────────────────────────────

  describe('Drive-scoped connection', () => {
    const driveStateData = {
      ...mockStateData,
      driveId: 'drive-456',
    };

    beforeEach(() => {
      mockVerifySignedState.mockReturnValue(driveStateData);
    });

    it('verifies admin access before creating drive connection', async () => {
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      await GET(request);

      expect(mockGetDriveAccess).toHaveBeenCalledWith('drive-456', 'user-123');
    });

    it('rejects when user lacks admin access to drive', async () => {
      mockGetDriveAccess.mockResolvedValueOnce({ isOwner: false, isAdmin: false });
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const url = getRedirectUrl(response);
      expect(url.searchParams.get('error')).toBe('access_denied');
    });

    it('creates drive-scoped connection for admin users', async () => {
      mockGetDriveAccess.mockResolvedValueOnce({ isOwner: false, isAdmin: true });
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      await GET(request);

      expect(mockCreateConnection).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          providerId: 'provider-1',
          driveId: 'drive-456',
          connectedBy: 'user-123',
          status: 'active',
        })
      );
    });
  });

  // ── Return URL validation ────────────────────────────────────────

  describe('Return URL validation', () => {
    it('uses safe relative returnUrl from state', async () => {
      mockVerifySignedState.mockReturnValueOnce({
        ...mockStateData,
        returnUrl: '/settings/integrations/github',
      });
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      const response = await GET(request);

      const url = getRedirectUrl(response);
      expect(url.pathname).toBe('/settings/integrations/github');
    });

    it('falls back to default for unsafe returnUrl', async () => {
      mockVerifySignedState.mockReturnValueOnce({
        ...mockStateData,
        returnUrl: 'https://evil.com/steal',
      });
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      const response = await GET(request);

      const url = getRedirectUrl(response);
      expect(url.pathname).toBe(DEFAULT_RETURN);
    });

    it('rejects protocol-relative returnUrl', async () => {
      mockVerifySignedState.mockReturnValueOnce({
        ...mockStateData,
        returnUrl: '//evil.com/steal',
      });
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      const response = await GET(request);

      const url = getRedirectUrl(response);
      expect(url.pathname).toBe(DEFAULT_RETURN);
    });
  });

  // ── Token exchange errors ────────────────────────────────────────

  describe('Token exchange errors', () => {
    it('redirects with missing_tokens when no access token returned', async () => {
      mockExchangeOAuthCode.mockResolvedValueOnce({ accessToken: null });
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const url = getRedirectUrl(response);
      expect(url.searchParams.get('error')).toBe('missing_tokens');
    });
  });

  // ── Unexpected errors ────────────────────────────────────────────

  describe('Unexpected errors', () => {
    it('redirects with unexpected error on thrown exception', async () => {
      mockGetProviderById.mockRejectedValueOnce(new Error('DB connection failed'));
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const url = getRedirectUrl(response);
      expect(url.searchParams.get('error')).toBe('unexpected');
    });

    it('logs the error on unexpected exception', async () => {
      const dbError = new Error('DB connection failed');
      mockGetProviderById.mockRejectedValueOnce(dbError);
      const request = createCallbackRequest({ code: 'auth-code', state: 'valid-state' });
      await GET(request);

      expect(mockLoggers.auth.error).toHaveBeenCalledWith(
        'Integration OAuth callback error',
        dbError
      );
    });
  });
});
