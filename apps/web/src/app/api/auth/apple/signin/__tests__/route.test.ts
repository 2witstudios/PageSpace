/**
 * Contract tests for POST & GET /api/auth/apple/signin
 *
 * Coverage:
 * - Environment variable validation
 * - Input validation (Zod schema)
 * - Return URL safety checks
 * - Rate limiting by IP
 * - OAuth URL generation with signed state parameter
 * - GET redirect flow
 * - Error handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies BEFORE imports
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    attemptsRemaining: 4,
    retryAfter: undefined,
  }),
  DISTRIBUTED_RATE_LIMITS: {
    LOGIN: { maxAttempts: 5, windowMs: 900000, progressiveDelay: true },
  },
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
  isSafeReturnUrl: vi.fn().mockReturnValue(true),
}));

import { POST, GET } from '../route';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { getClientIP, isSafeReturnUrl } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';

const createPostRequest = (body: Record<string, unknown> = {}) =>
  new Request('http://localhost/api/auth/apple/signin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const createGetRequest = () =>
  new Request('http://localhost/api/auth/apple/signin', { method: 'GET' });

describe('POST /api/auth/apple/signin', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      APPLE_SERVICE_ID: 'com.example.app',
      APPLE_REDIRECT_URI: 'https://example.com/api/auth/apple/callback',
      OAUTH_STATE_SECRET: 'test-secret-key-for-hmac',
    };
    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
    vi.mocked(isSafeReturnUrl).mockReturnValue(true);
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({
      allowed: true,
      attemptsRemaining: 4,
      retryAfter: undefined,
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('environment validation', () => {
    it('returns 500 when APPLE_SERVICE_ID is missing', async () => {
      delete process.env.APPLE_SERVICE_ID;

      const request = createPostRequest({});
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Apple OAuth not configured');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Missing required Apple OAuth environment variables',
        expect.objectContaining({ hasServiceId: false })
      );
    });

    it('returns 500 when APPLE_REDIRECT_URI is missing', async () => {
      delete process.env.APPLE_REDIRECT_URI;

      const request = createPostRequest({});
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Apple OAuth not configured');
    });

    it('returns 500 when OAUTH_STATE_SECRET is missing', async () => {
      delete process.env.OAUTH_STATE_SECRET;

      const request = createPostRequest({});
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Apple OAuth not configured');
    });
  });

  describe('input validation', () => {
    it('returns 400 for invalid platform value', async () => {
      const request = createPostRequest({ platform: 'invalid-platform' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.platform).toEqual([
        'Invalid option: expected one of "web"|"desktop"|"ios"',
      ]);
    });

    it('accepts valid optional fields', async () => {
      const request = createPostRequest({
        returnUrl: '/dashboard',
        platform: 'web',
        deviceId: 'device-123',
        deviceName: 'My Device',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.url).toContain('appleid.apple.com');
    });

    it('accepts request with no body fields (all optional)', async () => {
      const request = createPostRequest({});
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.url).toContain('https://appleid.apple.com/auth/authorize');
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

  describe('return URL safety', () => {
    it('returns 400 when returnUrl is unsafe', async () => {
      vi.mocked(isSafeReturnUrl).mockReturnValue(false);

      const request = createPostRequest({ returnUrl: 'https://evil.com' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid return URL');
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Rejected unsafe returnUrl in Apple OAuth signin',
        expect.objectContaining({ returnUrl: 'https://evil.com' })
      );
    });

    it('allows safe return URLs', async () => {
      vi.mocked(isSafeReturnUrl).mockReturnValue(true);

      const request = createPostRequest({ returnUrl: '/settings' });
      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when IP rate limit exceeded', async () => {
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
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    });

    it('uses correct rate limit key format', async () => {
      vi.mocked(getClientIP).mockReturnValue('10.0.0.1');

      const request = createPostRequest({});
      await POST(request);

      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'oauth:signin:ip:10.0.0.1',
        { maxAttempts: 5, windowMs: 900000, progressiveDelay: true }
      );
    });

    it('returns default Retry-After when retryAfter is undefined', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: undefined,
      });

      const request = createPostRequest({});
      const response = await POST(request);

      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('900');
    });
  });

  describe('OAuth URL generation', () => {
    it('returns URL with correct Apple OAuth endpoint', async () => {
      const request = createPostRequest({});
      const response = await POST(request);
      const body = await response.json();

      expect(body.url).toContain('https://appleid.apple.com/auth/authorize');
    });

    it('includes required OAuth parameters', async () => {
      const request = createPostRequest({});
      const response = await POST(request);
      const body = await response.json();
      const url = new URL(body.url);

      expect(url.searchParams.get('client_id')).toBe('com.example.app');
      expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/api/auth/apple/callback');
      expect(url.searchParams.get('response_type')).toBe('code id_token');
      expect(url.searchParams.get('scope')).toBe('name email');
      expect(url.searchParams.get('response_mode')).toBe('form_post');
      expect(typeof url.searchParams.get('state')).toBe('string');
      expect(url.searchParams.get('state')!.length).toBeGreaterThan(0);
    });

    it('encodes state with signed HMAC', async () => {
      const request = createPostRequest({ returnUrl: '/settings', platform: 'desktop' });
      const response = await POST(request);
      const body = await response.json();
      const url = new URL(body.url);

      const stateParam = url.searchParams.get('state')!;
      const decoded = JSON.parse(Buffer.from(stateParam, 'base64').toString('utf-8'));

      expect(typeof decoded.data).toBe('object');
      expect(typeof decoded.sig).toBe('string');
      expect(decoded.sig.length).toBeGreaterThan(0);
      expect(decoded.data.returnUrl).toBe('/settings');
      expect(decoded.data.platform).toBe('desktop');
    });

    it('includes deviceId and deviceName in state when provided', async () => {
      const request = createPostRequest({
        returnUrl: '/dashboard',
        platform: 'ios',
        deviceId: 'dev-123',
        deviceName: 'iPhone',
      });
      const response = await POST(request);
      const body = await response.json();
      const url = new URL(body.url);

      const stateParam = url.searchParams.get('state')!;
      const decoded = JSON.parse(Buffer.from(stateParam, 'base64').toString('utf-8'));

      expect(decoded.data.deviceId).toBe('dev-123');
      expect(decoded.data.deviceName).toBe('iPhone');
    });

    it('uses defaults when optional fields are not provided', async () => {
      const request = createPostRequest({});
      const response = await POST(request);
      const body = await response.json();
      const url = new URL(body.url);

      const stateParam = url.searchParams.get('state')!;
      const decoded = JSON.parse(Buffer.from(stateParam, 'base64').toString('utf-8'));

      expect(decoded.data.returnUrl).toBe('/dashboard');
      expect(decoded.data.platform).toBe('web');
      expect(decoded.data.deviceId).toBeUndefined();
      expect(decoded.data.deviceName).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected errors', async () => {
      // Force an error by making req.json() throw
      const badRequest = new Request('http://localhost/api/auth/apple/signin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });
      const response = await POST(badRequest);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred.');
      expect(loggers.auth.error).toHaveBeenCalledTimes(1);
      expect(vi.mocked(loggers.auth.error).mock.calls[0][0]).toBe('Apple OAuth signin error');
      expect(vi.mocked(loggers.auth.error).mock.calls[0][1]).toBeInstanceOf(Error);
    });
  });
});

describe('GET /api/auth/apple/signin', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      APPLE_SERVICE_ID: 'com.example.app',
      APPLE_REDIRECT_URI: 'https://example.com/api/auth/apple/callback',
      OAUTH_STATE_SECRET: 'test-secret-key-for-hmac',
      WEB_APP_URL: 'https://example.com',
    };
    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({
      allowed: true,
      attemptsRemaining: 4,
      retryAfter: undefined,
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('environment validation', () => {
    it('redirects to signin with error when APPLE_SERVICE_ID is missing', async () => {
      delete process.env.APPLE_SERVICE_ID;

      const response = await GET(createGetRequest());

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_config');
    });

    it('redirects to signin with error when APPLE_REDIRECT_URI is missing', async () => {
      delete process.env.APPLE_REDIRECT_URI;

      const response = await GET(createGetRequest());

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_config');
    });

    it('redirects to signin with error when OAUTH_STATE_SECRET is missing', async () => {
      delete process.env.OAUTH_STATE_SECRET;

      const response = await GET(createGetRequest());

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_config');
    });

    it('uses NEXTAUTH_URL as fallback base URL when WEB_APP_URL is not set', async () => {
      delete process.env.APPLE_SERVICE_ID;
      delete process.env.WEB_APP_URL;
      process.env.NEXTAUTH_URL = 'https://next.example.com';

      const response = await GET(createGetRequest());

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('https://next.example.com');
    });

    it('uses localhost fallback when no base URL env vars are set', async () => {
      delete process.env.APPLE_SERVICE_ID;
      delete process.env.WEB_APP_URL;
      delete process.env.NEXTAUTH_URL;

      const response = await GET(createGetRequest());

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('http://localhost:3000');
    });
  });

  describe('rate limiting', () => {
    it('redirects to signin with rate_limit error when rate limited', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: 900,
      });

      const response = await GET(createGetRequest());

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=rate_limit');
    });
  });

  describe('OAuth redirect', () => {
    it('redirects to Apple OAuth URL', async () => {
      const response = await GET(createGetRequest());

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('https://appleid.apple.com/auth/authorize');
    });

    it('includes signed state parameter with defaults', async () => {
      const response = await GET(createGetRequest());
      const location = response.headers.get('Location')!;
      const url = new URL(location);

      const stateParam = url.searchParams.get('state')!;
      const decoded = JSON.parse(Buffer.from(stateParam, 'base64').toString('utf-8'));

      expect(decoded.data.returnUrl).toBe('/dashboard');
      expect(decoded.data.platform).toBe('web');
      expect(typeof decoded.sig).toBe('string');
      expect(decoded.sig.length).toBeGreaterThan(0);
    });

    it('includes all required OAuth parameters', async () => {
      const response = await GET(createGetRequest());
      const location = response.headers.get('Location')!;
      const url = new URL(location);

      expect(url.searchParams.get('client_id')).toBe('com.example.app');
      expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/api/auth/apple/callback');
      expect(url.searchParams.get('response_type')).toBe('code id_token');
      expect(url.searchParams.get('scope')).toBe('name email');
      expect(url.searchParams.get('response_mode')).toBe('form_post');
    });
  });

  describe('error handling', () => {
    it('redirects to signin with oauth_error on unexpected error', async () => {
      vi.mocked(checkDistributedRateLimit).mockRejectedValueOnce(new Error('Unexpected'));

      const response = await GET(createGetRequest());

      expect(response.status).toBe(302);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Apple OAuth signin GET error',
        new Error('Unexpected')
      );
    });

    it('uses NEXTAUTH_URL fallback in error handler', async () => {
      delete process.env.WEB_APP_URL;
      process.env.NEXTAUTH_URL = 'https://next.example.com';
      vi.mocked(checkDistributedRateLimit).mockRejectedValueOnce(new Error('Fail'));

      const response = await GET(createGetRequest());
      const location = response.headers.get('Location')!;
      expect(location).toContain('https://next.example.com');
    });

    it('uses localhost fallback in error handler when no env vars set', async () => {
      delete process.env.WEB_APP_URL;
      delete process.env.NEXTAUTH_URL;
      vi.mocked(checkDistributedRateLimit).mockRejectedValueOnce(new Error('Fail'));

      const response = await GET(createGetRequest());
      const location = response.headers.get('Location')!;
      expect(location).toContain('http://localhost:3000');
    });
  });
});
