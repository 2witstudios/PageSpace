/**
 * Contract tests for POST and GET /api/auth/google/signin
 *
 * Tests the Google OAuth initiation endpoint that generates the OAuth URL.
 * Verifies the Request -> Response contract and boundary obligations.
 *
 * Coverage:
 * - POST: Environment validation (missing CLIENT_ID, REDIRECT_URI, STATE_SECRET)
 * - POST: Input validation (returnUrl, platform, deviceId, deviceName)
 * - POST: Unsafe returnUrl rejection
 * - POST: Rate limiting
 * - POST: Signed state generation with HMAC
 * - POST: OAuth URL generation with correct parameters
 * - POST: Error handling
 * - GET: Environment validation
 * - GET: Rate limiting
 * - GET: OAuth URL redirect
 * - GET: Error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
    checkDistributedRateLimit: vi.fn(),
    DISTRIBUTED_RATE_LIMITS: {
    LOGIN: {
      maxAttempts: 5,
      windowMs: 900000,
      blockDurationMs: 900000,
      progressiveDelay: true,
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
  isSafeReturnUrl: vi.fn(() => true),
}));

import { POST, GET } from '../route';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { getClientIP, isSafeReturnUrl } from '@/lib/auth';

const createPostRequest = (
  payload: Record<string, unknown>,
  additionalHeaders: Record<string, string> = {}
) => {
  return new Request('http://localhost/api/auth/google/signin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...additionalHeaders,
    },
    body: JSON.stringify(payload),
  });
};

const createGetRequest = () => {
  return new Request('http://localhost/api/auth/google/signin', {
    method: 'GET',
  });
};

describe('/api/auth/google/signin', () => {
  const originalEnv = {
    GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    OAUTH_STATE_SECRET: process.env.OAUTH_STATE_SECRET,
    WEB_APP_URL: process.env.WEB_APP_URL,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
  };

  beforeEach(() => {
    vi.resetAllMocks();

    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost/api/auth/google/callback';
    process.env.OAUTH_STATE_SECRET = 'test-oauth-state-secret';
    process.env.WEB_APP_URL = 'https://example.com';
    process.env.NEXTAUTH_URL = 'https://example.com';

    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true, attemptsRemaining: 5 });
    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
    vi.mocked(isSafeReturnUrl).mockReturnValue(true);
  });

  afterEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = originalEnv.GOOGLE_OAUTH_CLIENT_ID;
    process.env.GOOGLE_OAUTH_REDIRECT_URI = originalEnv.GOOGLE_OAUTH_REDIRECT_URI;
    process.env.OAUTH_STATE_SECRET = originalEnv.OAUTH_STATE_SECRET;
    process.env.WEB_APP_URL = originalEnv.WEB_APP_URL;
    process.env.NEXTAUTH_URL = originalEnv.NEXTAUTH_URL;
  });

  describe('POST /api/auth/google/signin', () => {
    describe('environment validation', () => {
      it('returns 500 when GOOGLE_OAUTH_CLIENT_ID is missing', async () => {
        delete process.env.GOOGLE_OAUTH_CLIENT_ID;

        const request = createPostRequest({});
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toContain('not configured');
      });

      it('returns 500 when GOOGLE_OAUTH_REDIRECT_URI is missing', async () => {
        delete process.env.GOOGLE_OAUTH_REDIRECT_URI;

        const request = createPostRequest({});
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toContain('not configured');
      });

      it('returns 500 when OAUTH_STATE_SECRET is missing', async () => {
        delete process.env.OAUTH_STATE_SECRET;

        const request = createPostRequest({});
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toContain('not configured');
      });
    });

    describe('input validation', () => {
      it('returns 400 for invalid platform', async () => {
        const request = createPostRequest({ platform: 'android' });
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.errors.platform).toEqual([
          'Invalid option: expected one of "web"|"desktop"|"ios"',
        ]);
      });

      it('accepts valid optional fields', async () => {
        const request = createPostRequest({
          returnUrl: '/settings',
          platform: 'desktop',
          deviceId: 'device-123',
          deviceName: 'My Mac',
        });
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.url).toContain('accounts.google.com');
      });

      it('accepts empty body', async () => {
        const request = createPostRequest({});
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      });

      // Regression guard: signin bounds must match verifyOAuthState so the
      // server never mints a state it will later reject at the callback.
      it('returns 400 for returnUrl longer than 2048 chars', async () => {
        const request = createPostRequest({ returnUrl: '/' + 'a'.repeat(2048) });
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.errors.returnUrl).toBeDefined();
      });

      it('returns 400 for deviceId longer than 128 chars', async () => {
        const request = createPostRequest({ deviceId: 'x'.repeat(129) });
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.errors.deviceId).toBeDefined();
      });

      it('returns 400 for empty deviceId', async () => {
        const request = createPostRequest({ deviceId: '' });
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.errors.deviceId).toBeDefined();
      });

      it('returns 400 for deviceName longer than 255 chars', async () => {
        const request = createPostRequest({ deviceName: 'n'.repeat(256) });
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.errors.deviceName).toBeDefined();
      });
    });

    describe('unsafe returnUrl rejection', () => {
      it('returns 400 when returnUrl is unsafe', async () => {
        vi.mocked(isSafeReturnUrl).mockReturnValue(false);

        const request = createPostRequest({ returnUrl: 'https://evil.com' });
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.error).toContain('Invalid return URL');
      });

      it('logs warning when returnUrl is rejected', async () => {
        vi.mocked(isSafeReturnUrl).mockReturnValue(false);

        const request = createPostRequest({ returnUrl: 'https://evil.com' });
        await POST(request);

        expect(loggers.auth.warn).toHaveBeenCalledWith(
          'Rejected unsafe returnUrl in OAuth signin',
          { returnUrl: 'https://evil.com', clientIP: '127.0.0.1' }
        );
      });
    });

    describe('rate limiting', () => {
      it('returns 429 when rate limit exceeded', async () => {
        vi.mocked(checkDistributedRateLimit).mockResolvedValue({
          allowed: false,
          attemptsRemaining: 0,
          retryAfter: 900,
        });

        const request = createPostRequest({});
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(429);
        expect(body.error).toContain('Too many login attempts');
        expect(body.retryAfter).toBe(900);
        expect(response.headers.get('Retry-After')).toBe('900');
      });

      it('includes rate limit headers when exceeded with no retryAfter', async () => {
        vi.mocked(checkDistributedRateLimit).mockResolvedValue({
          allowed: false,
          attemptsRemaining: 0,
          retryAfter: undefined,
        });

        const request = createPostRequest({});
        const response = await POST(request);

        expect(response.headers.get('Retry-After')).toBe('900');
        expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
      });
    });

    describe('OAuth URL generation', () => {
      it('returns OAuth URL with correct base', async () => {
        const request = createPostRequest({});
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      });

      it('includes correct OAuth parameters', async () => {
        const request = createPostRequest({});
        const response = await POST(request);
        const body = await response.json();

        const url = new URL(body.url);
        expect(url.searchParams.get('client_id')).toBe('test-client-id');
        expect(url.searchParams.get('redirect_uri')).toBe('http://localhost/api/auth/google/callback');
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('scope')).toBe('openid email profile');
        expect(url.searchParams.get('access_type')).toBe('offline');
        expect(url.searchParams.get('prompt')).toBe('consent');
      });

      it('includes signed state parameter', async () => {
        const request = createPostRequest({ returnUrl: '/settings', platform: 'desktop', deviceId: 'dev-1' });
        const response = await POST(request);
        const body = await response.json();

        const url = new URL(body.url);
        const stateParam = url.searchParams.get('state');
        expect(typeof stateParam).toBe('string');
        expect(stateParam!.length).toBeGreaterThan(0);

        // Decode and verify state structure
        const decoded = JSON.parse(Buffer.from(stateParam!, 'base64').toString('utf-8'));
        expect(typeof decoded.data).toBe('object');
        expect(typeof decoded.sig).toBe('string');
        expect(decoded.data.returnUrl).toBe('/settings');
        expect(decoded.data.platform).toBe('desktop');
        expect(decoded.data.deviceId).toBe('dev-1');
      });

      it('includes deviceName in state when provided', async () => {
        const request = createPostRequest({ deviceId: 'dev-1', deviceName: 'My Mac' });
        const response = await POST(request);
        const body = await response.json();

        const url = new URL(body.url);
        const stateParam = url.searchParams.get('state');
        const decoded = JSON.parse(Buffer.from(stateParam!, 'base64').toString('utf-8'));
        expect(decoded.data.deviceName).toBe('My Mac');
      });

      it('omits deviceId from state when not provided', async () => {
        const request = createPostRequest({});
        const response = await POST(request);
        const body = await response.json();

        const url = new URL(body.url);
        const stateParam = url.searchParams.get('state');
        const decoded = JSON.parse(Buffer.from(stateParam!, 'base64').toString('utf-8'));
        expect(decoded.data.deviceId).toBeUndefined();
      });

      it('defaults returnUrl to /dashboard and platform to web', async () => {
        const request = createPostRequest({});
        const response = await POST(request);
        const body = await response.json();

        const url = new URL(body.url);
        const stateParam = url.searchParams.get('state');
        const decoded = JSON.parse(Buffer.from(stateParam!, 'base64').toString('utf-8'));
        expect(decoded.data.returnUrl).toBe('/dashboard');
        expect(decoded.data.platform).toBe('web');
      });
    });

    describe('error handling', () => {
      it('returns 500 on unexpected exception', async () => {
        vi.mocked(checkDistributedRateLimit).mockRejectedValueOnce(new Error('Redis error'));

        const request = createPostRequest({});
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toContain('unexpected error');
        expect(loggers.auth.error).toHaveBeenCalledWith(
          'Google OAuth signin error',
          new Error('Redis error')
        );
      });
    });
  });

  describe('GET /api/auth/google/signin', () => {
    describe('environment validation', () => {
      it('redirects with oauth_config error when GOOGLE_OAUTH_CLIENT_ID is missing', async () => {
        delete process.env.GOOGLE_OAUTH_CLIENT_ID;

        const request = createGetRequest();
        const response = await GET(request);

        expect(response.status).toBe(302);
        const location = response.headers.get('Location')!;
        expect(location).toContain('/auth/signin?error=oauth_config');
      });

      it('redirects with oauth_config error when GOOGLE_OAUTH_REDIRECT_URI is missing', async () => {
        delete process.env.GOOGLE_OAUTH_REDIRECT_URI;

        const request = createGetRequest();
        const response = await GET(request);

        expect(response.status).toBe(302);
        const location = response.headers.get('Location')!;
        expect(location).toContain('/auth/signin?error=oauth_config');
      });

      it('uses fallback URL when WEB_APP_URL and NEXTAUTH_URL are not set', async () => {
        delete process.env.GOOGLE_OAUTH_CLIENT_ID;
        delete process.env.WEB_APP_URL;
        delete process.env.NEXTAUTH_URL;

        const request = createGetRequest();
        const response = await GET(request);

        expect(response.status).toBe(302);
        const location = response.headers.get('Location')!;
        expect(location).toContain('http://localhost:3000');
      });
    });

    describe('rate limiting', () => {
      it('redirects with rate_limit error when rate limited', async () => {
        vi.mocked(checkDistributedRateLimit).mockResolvedValue({
          allowed: false,
          attemptsRemaining: 0,
          retryAfter: 900,
        });

        const request = createGetRequest();
        const response = await GET(request);

        expect(response.status).toBe(302);
        const location = response.headers.get('Location')!;
        expect(location).toContain('/auth/signin?error=rate_limit');
      });
    });

    describe('OAuth URL redirect', () => {
      it('redirects to Google OAuth URL', async () => {
        const request = createGetRequest();
        const response = await GET(request);

        expect(response.status).toBe(302);
        const location = response.headers.get('Location')!;
        expect(location).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      });

      it('includes correct OAuth parameters in redirect URL', async () => {
        const request = createGetRequest();
        const response = await GET(request);

        const location = response.headers.get('Location')!;
        const url = new URL(location);
        expect(url.searchParams.get('client_id')).toBe('test-client-id');
        expect(url.searchParams.get('redirect_uri')).toBe('http://localhost/api/auth/google/callback');
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('scope')).toBe('openid email profile');
      });

      it('does not include state parameter for GET', async () => {
        const request = createGetRequest();
        const response = await GET(request);

        const location = response.headers.get('Location')!;
        const url = new URL(location);
        expect(url.searchParams.get('state')).toBeNull();
      });
    });

    describe('error handling', () => {
      it('redirects with oauth_error on unexpected exception', async () => {
        vi.mocked(checkDistributedRateLimit).mockRejectedValueOnce(new Error('Redis error'));

        const request = createGetRequest();
        const response = await GET(request);

        expect(response.status).toBe(302);
        const location = response.headers.get('Location')!;
        expect(location).toContain('/auth/signin?error=oauth_error');
        expect(loggers.auth.error).toHaveBeenCalledWith(
          'Google OAuth signin GET error',
          new Error('Redis error')
        );
      });

      it('uses fallback URL when env vars not set on error', async () => {
        delete process.env.WEB_APP_URL;
        delete process.env.NEXTAUTH_URL;
        vi.mocked(checkDistributedRateLimit).mockRejectedValueOnce(new Error('Redis error'));

        const request = createGetRequest();
        const response = await GET(request);

        expect(response.status).toBe(302);
        const location = response.headers.get('Location')!;
        expect(location).toContain('http://localhost:3000');
      });
    });
  });
});
