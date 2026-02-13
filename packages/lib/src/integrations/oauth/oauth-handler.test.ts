import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildOAuthAuthorizationUrl,
  exchangeOAuthCode,
  refreshOAuthToken,
  generatePKCE,
} from './oauth-handler';
import type { OAuth2Config } from '../types';

const mockOAuth2Config: OAuth2Config = {
  authorizationUrl: 'https://auth.example.com/authorize',
  tokenUrl: 'https://auth.example.com/token',
  scopes: ['read', 'write'],
};

describe('buildOAuthAuthorizationUrl', () => {
  it('should build a valid authorization URL', () => {
    const url = buildOAuthAuthorizationUrl(mockOAuth2Config, {
      clientId: 'client-123',
      redirectUri: 'https://app.test.com/callback',
      state: 'abc123',
    });

    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://auth.example.com');
    expect(parsed.pathname).toBe('/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('client-123');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.test.com/callback');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('state')).toBe('abc123');
    expect(parsed.searchParams.get('scope')).toBe('read write');
  });

  it('should include PKCE challenge when codeVerifier is provided', () => {
    const url = buildOAuthAuthorizationUrl(mockOAuth2Config, {
      clientId: 'client-123',
      redirectUri: 'https://app.test.com/callback',
      state: 'abc123',
      codeVerifier: 'test-verifier-value',
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('should include login hint when provided', () => {
    const url = buildOAuthAuthorizationUrl(mockOAuth2Config, {
      clientId: 'client-123',
      redirectUri: 'https://app.test.com/callback',
      state: 'abc123',
      loginHint: 'user@example.com',
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get('login_hint')).toBe('user@example.com');
  });

  it('should merge additional scopes without duplicates', () => {
    const url = buildOAuthAuthorizationUrl(mockOAuth2Config, {
      clientId: 'client-123',
      redirectUri: 'https://app.test.com/callback',
      state: 'abc123',
      additionalScopes: ['write', 'admin'],
    });

    const parsed = new URL(url);
    expect(parsed.searchParams.get('scope')).toBe('read write admin');
  });
});

describe('exchangeOAuthCode', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('given valid code, should exchange for tokens', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        access_token: 'access-123',
        refresh_token: 'refresh-456',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    });

    const result = await exchangeOAuthCode(mockOAuth2Config, {
      code: 'auth-code-abc',
      clientId: 'client-123',
      clientSecret: 'secret-456',
      redirectUri: 'https://app.test.com/callback',
    });

    expect(result.accessToken).toBe('access-123');
    expect(result.refreshToken).toBe('refresh-456');
    expect(result.expiresIn).toBe(3600);
    expect(result.tokenType).toBe('Bearer');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://auth.example.com/token',
      expect.objectContaining({
        method: 'POST',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('given PKCE code verifier, should include it in request body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        access_token: 'access-123',
      }),
    });

    await exchangeOAuthCode(mockOAuth2Config, {
      code: 'auth-code-abc',
      clientId: 'client-123',
      clientSecret: 'secret-456',
      redirectUri: 'https://app.test.com/callback',
      codeVerifier: 'verifier-789',
    });

    const callBody = mockFetch.mock.calls[0][1].body;
    expect(callBody).toContain('code_verifier=verifier-789');
  });

  it('given error response from provider, should throw without leaking response body', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"error":"invalid_grant","error_description":"Code expired"}'),
    });

    await expect(
      exchangeOAuthCode(mockOAuth2Config, {
        code: 'expired-code',
        clientId: 'client-123',
        clientSecret: 'secret-456',
        redirectUri: 'https://app.test.com/callback',
      })
    ).rejects.toThrow('Token exchange failed (400)');

    // Error should NOT contain the provider response body
    try {
      await exchangeOAuthCode(mockOAuth2Config, {
        code: 'expired-code',
        clientId: 'client-123',
        clientSecret: 'secret-456',
        redirectUri: 'https://app.test.com/callback',
      });
    } catch (e) {
      expect((e as Error).message).not.toContain('invalid_grant');
      expect((e as Error).message).not.toContain('Code expired');
    }
  });

  it('given response missing access_token, should throw', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        token_type: 'Bearer',
      }),
    });

    await expect(
      exchangeOAuthCode(mockOAuth2Config, {
        code: 'auth-code-abc',
        clientId: 'client-123',
        clientSecret: 'secret-456',
        redirectUri: 'https://app.test.com/callback',
      })
    ).rejects.toThrow('Token exchange response missing access_token');
  });

  it('given network timeout, should throw abort error', async () => {
    mockFetch.mockImplementation(() => new Promise((_, reject) => {
      setTimeout(() => reject(new DOMException('The operation was aborted.', 'AbortError')), 50);
    }));

    await expect(
      exchangeOAuthCode(mockOAuth2Config, {
        code: 'auth-code-abc',
        clientId: 'client-123',
        clientSecret: 'secret-456',
        redirectUri: 'https://app.test.com/callback',
      })
    ).rejects.toThrow();
  });

  it('given response with only access_token, should return with optional fields undefined', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        access_token: 'access-only',
      }),
    });

    const result = await exchangeOAuthCode(mockOAuth2Config, {
      code: 'auth-code-abc',
      clientId: 'client-123',
      clientSecret: 'secret-456',
      redirectUri: 'https://app.test.com/callback',
    });

    expect(result.accessToken).toBe('access-only');
    expect(result.refreshToken).toBeUndefined();
    expect(result.expiresIn).toBeUndefined();
  });
});

describe('refreshOAuthToken', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('given valid refresh token, should return new tokens', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        access_token: 'new-access-123',
        refresh_token: 'new-refresh-456',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    });

    const result = await refreshOAuthToken(mockOAuth2Config, {
      refreshToken: 'old-refresh-token',
      clientId: 'client-123',
      clientSecret: 'secret-456',
    });

    expect(result.accessToken).toBe('new-access-123');
    expect(result.refreshToken).toBe('new-refresh-456');
    expect(result.expiresIn).toBe(3600);

    const callBody = mockFetch.mock.calls[0][1].body;
    expect(callBody).toContain('grant_type=refresh_token');
    expect(callBody).toContain('refresh_token=old-refresh-token');
  });

  it('given error response, should throw without leaking response body', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('{"error":"invalid_grant"}'),
    });

    await expect(
      refreshOAuthToken(mockOAuth2Config, {
        refreshToken: 'expired-token',
        clientId: 'client-123',
        clientSecret: 'secret-456',
      })
    ).rejects.toThrow('Token refresh failed (401)');

    try {
      await refreshOAuthToken(mockOAuth2Config, {
        refreshToken: 'expired-token',
        clientId: 'client-123',
        clientSecret: 'secret-456',
      });
    } catch (e) {
      expect((e as Error).message).not.toContain('invalid_grant');
    }
  });

  it('given response missing access_token, should throw', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await expect(
      refreshOAuthToken(mockOAuth2Config, {
        refreshToken: 'refresh-token',
        clientId: 'client-123',
        clientSecret: 'secret-456',
      })
    ).rejects.toThrow('Token refresh response missing access_token');
  });

  it('given network timeout, should throw abort error', async () => {
    mockFetch.mockImplementation(() => new Promise((_, reject) => {
      setTimeout(() => reject(new DOMException('The operation was aborted.', 'AbortError')), 50);
    }));

    await expect(
      refreshOAuthToken(mockOAuth2Config, {
        refreshToken: 'refresh-token',
        clientId: 'client-123',
        clientSecret: 'secret-456',
      })
    ).rejects.toThrow();
  });

  it('given refresh response without new refresh_token, should return undefined for it', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        access_token: 'new-access',
        expires_in: 1800,
      }),
    });

    const result = await refreshOAuthToken(mockOAuth2Config, {
      refreshToken: 'old-refresh',
      clientId: 'client-123',
      clientSecret: 'secret-456',
    });

    expect(result.accessToken).toBe('new-access');
    expect(result.refreshToken).toBeUndefined();
    expect(result.expiresIn).toBe(1800);
  });
});

describe('generatePKCE', () => {
  it('should generate a code verifier and challenge', () => {
    const { codeVerifier, codeChallenge } = generatePKCE();

    expect(codeVerifier).toBeTruthy();
    expect(codeChallenge).toBeTruthy();
    expect(codeVerifier).not.toBe(codeChallenge);
  });

  it('should generate unique pairs each time', () => {
    const pair1 = generatePKCE();
    const pair2 = generatePKCE();

    expect(pair1.codeVerifier).not.toBe(pair2.codeVerifier);
    expect(pair1.codeChallenge).not.toBe(pair2.codeChallenge);
  });

  it('should generate URL-safe base64 verifier', () => {
    const { codeVerifier } = generatePKCE();
    // base64url should not contain +, /, or =
    expect(codeVerifier).not.toMatch(/[+/=]/);
  });
});
