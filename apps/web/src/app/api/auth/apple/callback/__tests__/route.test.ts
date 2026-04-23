/**
 * Contract tests for POST /api/auth/apple/callback
 *
 * Coverage:
 * - Apple OAuth error handling (user_cancelled_authorize, generic errors)
 * - Missing id_token
 * - State parameter parsing (valid signed, unsigned, malformed, missing)
 * - Unsafe returnUrl fallback
 * - Rate limiting
 * - Apple ID token verification
 * - Missing email from Apple
 * - User JSON parsing (first authorization name)
 * - User find or create
 * - Drive provisioning
 * - Session management (fixation prevention)
 * - CSRF token generation
 * - Rate limit reset
 * - Desktop / iOS / Web platform redirects
 * - Error handling
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import crypto from 'crypto';

// Mock dependencies BEFORE imports
vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    findUserByAppleIdOrEmail: vi.fn(),
    findUserById: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/auth', () => ({
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock_token'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'mock-session-id',
      userId: 'new-user-id',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }),
    revokeAllUserSessions: vi.fn().mockResolvedValue(0),
  },
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
  createExchangeCode: vi.fn().mockResolvedValue('mock-exchange-code'),
  SESSION_DURATION_MS: 7 * 24 * 60 * 60 * 1000,
  verifyAppleIdToken: vi.fn().mockResolvedValue({
    success: true,
    userInfo: {
      providerId: 'apple-sub-123',
      email: 'test@example.com',
      emailVerified: true,
    },
  }),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('mock-cuid'),
}));

vi.mock('@pagespace/lib/server', async () => {
  const { maskEmail } = await vi.importActual<typeof import('@pagespace/lib/audit/mask-email')>(
    '@pagespace/lib/audit/mask-email'
  );
  return {
    loggers: {
      auth: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
      security: {
        warn: vi.fn(),
      },
    },
    auditRequest: vi.fn(),
    validateOrCreateDeviceToken: vi.fn().mockResolvedValue({
      deviceToken: 'mock-device-token',
    }),
    maskEmail,
  };
});

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn().mockResolvedValue({ driveId: 'new-drive-id', created: false }),
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
  isSafeReturnUrl: vi.fn().mockReturnValue(true),
  revokeSessionsForLogin: vi.fn().mockResolvedValue(0),
  createWebDeviceToken: vi.fn().mockResolvedValue('ps_dev_mock_token'),
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
  createDeviceTokenHandoffCookie: vi.fn().mockReturnValue('ps_device_token=mock; Path=/; Max-Age=60'),
}));

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    attemptsRemaining: 4,
    retryAfter: undefined,
  }),
  resetDistributedRateLimit: vi.fn().mockResolvedValue(undefined),
  DISTRIBUTED_RATE_LIMITS: {
    LOGIN: { maxAttempts: 5, windowMs: 900000, progressiveDelay: true },
  },
}));

import { POST } from '../route';
import { authRepository } from '@/lib/repositories/auth-repository';
import { sessionService, verifyAppleIdToken } from '@pagespace/lib/auth';
import { checkDistributedRateLimit, resetDistributedRateLimit } from '@pagespace/lib/security';
import { getClientIP, isSafeReturnUrl } from '@/lib/auth';
import { loggers, auditRequest, validateOrCreateDeviceToken } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/monitoring/activity-tracker';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { appendSessionCookie } from '@/lib/auth/cookie-config';

// Helper to create signed state
function createSignedState(
  data: Record<string, unknown>,
  secret: string = 'test-oauth-state-secret'
): string {
  const withTimestamp = { timestamp: Date.now(), ...data };
  const payload = JSON.stringify(withTimestamp);
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ data: withTimestamp, sig })).toString('base64');
}

// Helper to create form data POST request
function createCallbackRequest(fields: Record<string, string> = {}): Request {
  const formBody = new URLSearchParams(fields).toString();
  return new Request('http://localhost/api/auth/apple/callback', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'TestBrowser/1.0',
    },
    body: formBody,
  });
}

const mockNewUser = {
  id: 'new-user-id',
  name: 'Test User',
  email: 'test@example.com',
  image: null,
  emailVerified: new Date(),
  tokenVersion: 0,
  appleId: 'apple-sub-123',
};

describe('POST /api/auth/apple/callback', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEXTAUTH_URL: 'https://example.com',
      WEB_APP_URL: 'https://example.com',
      OAUTH_STATE_SECRET: 'test-oauth-state-secret',
    };
    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
    vi.mocked(isSafeReturnUrl).mockReturnValue(true);
    vi.mocked(authRepository.findUserByAppleIdOrEmail).mockResolvedValue(null);
    vi.mocked(authRepository.findUserById).mockResolvedValue(null);
    vi.mocked(authRepository.createUser).mockResolvedValue(mockNewUser as never);
    vi.mocked(authRepository.updateUser).mockResolvedValue(undefined);
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({
      allowed: true,
      attemptsRemaining: 4,
      retryAfter: undefined,
    });
    vi.mocked(verifyAppleIdToken).mockResolvedValue({
      success: true,
      // @ts-expect-error - partial mock data
      userInfo: {
        providerId: 'apple-sub-123',
        email: 'test@example.com',
        emailVerified: true,
      },
    });
    vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(0);
    // @ts-expect-error - partial mock data
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      sessionId: 'mock-session-id',
      userId: 'new-user-id',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue({ driveId: 'new-drive-id', created: false });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('Apple error handling', () => {
    it('redirects with access_denied when user cancels', async () => {
      const request = createCallbackRequest({ error: 'user_cancelled_authorize' });
      const response = await POST(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=access_denied');
    });

    it('redirects with oauth_error for other Apple errors', async () => {
      const request = createCallbackRequest({ error: 'some_other_error' });
      const response = await POST(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });

    it('truncates long error strings in logs', async () => {
      const longError = 'a'.repeat(200);
      const request = createCallbackRequest({ error: longError });
      await POST(request);

      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Apple OAuth callback rejected',
        expect.objectContaining({ errorHint: longError.slice(0, 100) })
      );
    });

    it('uses request origin when no env URLs set', async () => {
      delete process.env.NEXTAUTH_URL;
      delete process.env.WEB_APP_URL;

      const request = createCallbackRequest({ error: 'some_error' });
      const response = await POST(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin');
    });
  });

  describe('missing id_token', () => {
    it('rejects when id_token is missing', async () => {
      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({ state });
      const response = await POST(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });
  });

  describe('state parameter parsing', () => {
    it('parses valid signed state', async () => {
      const state = createSignedState({ returnUrl: '/settings', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      const response = await POST(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/settings');
    });

    it('rejects state with invalid signature', async () => {
      const badState = Buffer.from(JSON.stringify({
        data: { returnUrl: '/evil', platform: 'web' },
        sig: 'invalid-signature',
      })).toString('base64');

      const request = createCallbackRequest({
        id_token: 'valid-token',
        state: badState,
      });

      const response = await POST(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });

    it('rejects unsigned state', async () => {
      const unsignedState = Buffer.from(JSON.stringify({
        data: { returnUrl: '/evil', platform: 'desktop' },
      })).toString('base64');

      const request = createCallbackRequest({
        id_token: 'valid-token',
        state: unsignedState,
      });

      const response = await POST(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });

    it('rejects malformed state', async () => {
      const badState = Buffer.from('not-json').toString('base64');

      const request = createCallbackRequest({
        id_token: 'valid-token',
        state: badState,
      });

      const response = await POST(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });

    it('rejects when state is not provided', async () => {
      const request = createCallbackRequest({
        id_token: 'valid-token',
      });

      const response = await POST(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });

    it('extracts deviceId and deviceName from valid state', async () => {
      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'desktop',
        deviceId: 'dev-abc',
        deviceName: 'My Mac',
      });

      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      await POST(request);

      // Desktop platform should use device info from state
      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: 'dev-abc',
          deviceName: 'My Mac',
        })
      );
    });

    it('uses safe default returnUrl when data.returnUrl is missing', async () => {
      const state = createSignedState({ platform: 'web' });

      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      const response = await POST(request);
      const location = response.headers.get('Location')!;

      expect(location).toContain('/dashboard');
    });
  });

  describe('unsafe returnUrl fallback', () => {
    it('falls back to /dashboard when returnUrl is unsafe', async () => {
      vi.mocked(isSafeReturnUrl).mockReturnValue(false);

      const state = createSignedState({ returnUrl: 'https://evil.com', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      const response = await POST(request);
      const location = response.headers.get('Location')!;

      expect(location).toContain('/dashboard');
      expect(location).not.toContain('evil.com');
    });
  });

  describe('rate limiting', () => {
    it('redirects to signin with rate_limit error when rate limited', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: 900,
      });

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      const response = await POST(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=rate_limit');
    });
  });

  describe('token verification', () => {
    it('redirects with oauth_error when token verification fails', async () => {
      vi.mocked(verifyAppleIdToken).mockResolvedValue({
        success: false,
        error: 'Invalid token',
      });

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'invalid-token',
        state,
      });

      const response = await POST(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });

    it('redirects with oauth_error when email is missing from token', async () => {
      vi.mocked(verifyAppleIdToken).mockResolvedValue({
        success: true,
        // @ts-expect-error - partial mock data
        userInfo: {
          providerId: 'apple-sub-123',
          email: '',
          emailVerified: true,
        },
      });

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      const response = await POST(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });
  });

  describe('Apple user JSON parsing', () => {
    it('parses user name from Apple user JSON', async () => {
      const userJson = JSON.stringify({
        name: { firstName: 'Jane', lastName: 'Smith' },
        email: 'jane@example.com',
      });

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
        user: userJson,
      });

      await POST(request);

      // User should be created with the parsed name
      expect(authRepository.createUser).toHaveBeenCalledTimes(1);
    });

    it('handles malformed user JSON gracefully', async () => {
      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
        user: 'not-valid-json',
      });

      const response = await POST(request);

      expect(response.status).toBe(307);
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Failed to parse Apple user JSON',
        expect.objectContaining({ parseError: true })
      );
    });

    it('handles user JSON without name field', async () => {
      const userJson = JSON.stringify({ email: 'test@example.com' });

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
        user: userJson,
      });

      const response = await POST(request);

      expect(response.status).toBe(307);
    });
  });

  describe('user find or create', () => {
    it('creates a new user when none exists', async () => {
      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      await POST(request);

      expect(authRepository.createUser).toHaveBeenCalledTimes(1);
    });

    it('updates existing user missing appleId', async () => {
      const existingUser = {
        id: 'existing-id',
        name: 'Existing',
        email: 'test@example.com',
        image: null,
        emailVerified: new Date(),
        tokenVersion: 0,
              appleId: null,
      };

      vi.mocked(authRepository.findUserByAppleIdOrEmail).mockResolvedValueOnce(existingUser as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce({ ...existingUser, appleId: 'apple-sub-123' } as never);

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      await POST(request);

      expect(authRepository.updateUser).toHaveBeenCalledWith('existing-id', expect.objectContaining({
        appleId: 'apple-sub-123',
      }));
      expect(authRepository.createUser).not.toHaveBeenCalled();
    });

    it('updates existing user missing name', async () => {
      const existingUser = {
        id: 'existing-id',
        name: null,
        email: 'test@example.com',
        image: null,
        emailVerified: new Date(),
        tokenVersion: 0,
              appleId: 'apple-sub-123',
      };

      vi.mocked(authRepository.findUserByAppleIdOrEmail).mockResolvedValueOnce(existingUser as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce({ ...existingUser, name: 'test' } as never);

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      await POST(request);

      expect(authRepository.updateUser).toHaveBeenCalledWith('existing-id', expect.objectContaining({
        name: 'test',
      }));
    });

    it('does not update complete existing user', async () => {
      const existingUser = {
        id: 'existing-id',
        name: 'Complete User',
        email: 'test@example.com',
        image: null,
        emailVerified: new Date(),
        tokenVersion: 0,
              appleId: 'apple-sub-123',
      };

      vi.mocked(authRepository.findUserByAppleIdOrEmail).mockResolvedValue(existingUser as never);

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      await POST(request);

      expect(authRepository.updateUser).not.toHaveBeenCalled();
      expect(authRepository.createUser).not.toHaveBeenCalled();
    });

    it('handles re-fetch returning null after update', async () => {
      const existingUser = {
        id: 'existing-id',
        name: 'Existing',
        email: 'test@example.com',
        image: null,
        emailVerified: new Date(),
        tokenVersion: 0,
              appleId: null,
      };

      vi.mocked(authRepository.findUserByAppleIdOrEmail).mockResolvedValueOnce(existingUser as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce(null);

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      const response = await POST(request);

      // Should fall back to original user
      expect(response.status).toBe(307);
    });
  });

  describe('drive provisioning', () => {
    it('redirects to provisioned drive when newly created', async () => {
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue({
        driveId: 'provisioned-drive-id',
        created: true,
      });

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      const response = await POST(request);
      const location = response.headers.get('Location')!;

      expect(location).toContain('/dashboard/provisioned-drive-id');
    });

    it('uses original returnUrl when drive already exists', async () => {
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue({
        driveId: 'existing-drive-id',
        created: false,
      });

      const state = createSignedState({ returnUrl: '/settings', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      const response = await POST(request);
      const location = response.headers.get('Location')!;

      expect(location).toContain('/settings');
    });

    it('continues on drive provisioning error', async () => {
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockRejectedValueOnce(new Error('DB error'));

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      const response = await POST(request);

      expect(response.status).toBe(307);
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Failed to provision Getting Started drive',
        new Error('DB error'),
        { userId: mockNewUser.id, provider: 'apple' }
      );
    });
  });

  describe('session management', () => {
    it('revokes existing sessions before creating new one', async () => {
      const { revokeSessionsForLogin } = await import('@/lib/auth');

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      await POST(request);

      expect(revokeSessionsForLogin).toHaveBeenCalledWith('new-user-id', undefined, 'new_login', 'Apple OAuth');
    });

    it('redirects with oauth_error when session validation fails', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(null as never);

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      const response = await POST(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });
  });

  describe('rate limit reset', () => {
    it('resets rate limit on successful callback', async () => {
      vi.mocked(getClientIP).mockReturnValue('10.0.0.1');

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      await POST(request);

      expect(resetDistributedRateLimit).toHaveBeenCalledWith('oauth:callback:ip:10.0.0.1');
    });

    it('logs warning when rate limit reset fails', async () => {
      vi.mocked(resetDistributedRateLimit).mockRejectedValueOnce(new Error('Redis error'));

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      const response = await POST(request);

      expect(response.status).toBe(307);
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Rate limit reset failed after successful Apple OAuth callback',
        expect.objectContaining({ error: 'Redis error' })
      );
    });

    it('handles non-Error rate limit reset failure', async () => {
      vi.mocked(resetDistributedRateLimit).mockRejectedValueOnce('string-error');

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      await POST(request);

      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Rate limit reset failed after successful Apple OAuth callback',
        expect.objectContaining({ error: 'string-error' })
      );
    });
  });

  describe('desktop platform redirect', () => {
    it('returns handoff bridge HTML containing deep link with exchange code', async () => {
      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'desktop',
        deviceId: 'desktop-dev-123',
        deviceName: 'My Mac',
      });

      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/html');
      const body = await response.text();
      expect(body).toContain('pagespace://auth-exchange');
      expect(body).toContain('code=mock-exchange-code');
      expect(body).toContain('provider=apple');
      expect(body).toContain('http-equiv="refresh"');
    });

    it('emits hardened security headers on the handoff bridge response', async () => {
      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'desktop',
        deviceId: 'desktop-dev-123',
        deviceName: 'My Mac',
      });

      const request = createCallbackRequest({ id_token: 'valid-token', state });
      const response = await POST(request);

      const csp = response.headers.get('Content-Security-Policy') ?? '';
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("style-src 'unsafe-inline'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain('img-src');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    });

    it('includes isNewUser flag in deep link for new users', async () => {
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue({
        driveId: 'new-drive',
        created: true,
      });

      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'desktop',
        deviceId: 'desktop-dev-123',
      });

      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      const response = await POST(request);
      const body = await response.text();

      expect(body).toContain('isNewUser=true');
    });

    it('redirects with error when desktop platform has no deviceId', async () => {
      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'desktop',
      });

      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      const response = await POST(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });

    it('uses user-agent as fallback device name for desktop', async () => {
      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'desktop',
        deviceId: 'dev-123',
      });

      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      await POST(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceName: 'TestBrowser/1.0',
        })
      );
    });
  });

  describe('iOS platform redirect', () => {
    it('redirects to deep link with exchange code', async () => {
      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'ios',
        deviceId: 'ios-dev-123',
      });

      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      const response = await POST(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('pagespace://auth-exchange');
      expect(location).toContain('provider=apple');
    });

    it('generates deviceId when not provided for iOS', async () => {
      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'ios',
      });

      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      await POST(request);

      // Should use createId() as fallback for deviceId
      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: 'mock-cuid',
          platform: 'ios',
        })
      );
    });

    it('includes isNewUser flag for newly provisioned iOS users', async () => {
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue({
        driveId: 'new-drive',
        created: true,
      });

      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'ios',
        deviceId: 'ios-dev',
      });

      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      const response = await POST(request);
      const location = response.headers.get('Location')!;

      expect(location).toContain('isNewUser=true');
    });
  });

  describe('web platform redirect', () => {
    it('redirects to returnUrl with auth success without CSRF token in URL', async () => {
      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      const response = await POST(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/dashboard');
      expect(location).toContain('auth=success');
      expect(location).not.toContain('csrfToken');
    });

    it('sets session cookie for web redirect', async () => {
      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      await POST(request);

      expect(appendSessionCookie).toHaveBeenCalledTimes(1);
      const [webHeaders, webToken] = vi.mocked(appendSessionCookie).mock.calls[0];
      expect(webHeaders).toBeInstanceOf(Headers);
      expect(webToken).toBe('ps_sess_mock_token');
    });
  });

  describe('auth event logging', () => {
    it('logs login event on successful callback', async () => {
      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      await POST(request);

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'auth.login.success',
          userId: 'new-user-id',
          sessionId: 'mock-session-id',
          details: { method: 'Apple OAuth' },
        })
      );
      expect(trackAuthEvent).toHaveBeenCalledWith(
        'new-user-id',
        'login',
        expect.objectContaining({
          provider: 'apple',
        })
      );
    });
  });

  describe('error handling', () => {
    it('redirects with oauth_error on unexpected exception', async () => {
      vi.mocked(verifyAppleIdToken).mockRejectedValueOnce(new Error('Network failure'));

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({
        id_token: 'valid-token',
        state,
      });

      const response = await POST(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Apple OAuth callback error',
        new Error('Network failure')
      );
    });
  });

  describe('PII scrub in log metadata', () => {
    const findInfoCall = (msg: string) =>
      vi.mocked(loggers.auth.info).mock.calls.find(call => call[0] === msg);

    it('masks email in "Creating new user via Apple OAuth" log', async () => {
      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({ id_token: 'valid-token', state });
      await POST(request);

      const call = findInfoCall('Creating new user via Apple OAuth');
      expect(call).toBeDefined();
      const meta = call?.[1] as { email?: string };
      expect(meta.email).toBe('te***@example.com');
    });

    it('does not include name in "New user created via Apple OAuth" log', async () => {
      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({ id_token: 'valid-token', state });
      await POST(request);

      const call = findInfoCall('New user created via Apple OAuth');
      expect(call).toBeDefined();
      const meta = call?.[1] as Record<string, unknown>;
      expect(meta).not.toHaveProperty('name');
      expect(meta).toHaveProperty('userId');
    });

    it('masks email in "Updating existing user via Apple OAuth" log', async () => {
      const existingUser = {
        id: 'existing-id',
        name: null,
        email: 'test@example.com',
        image: null,
        emailVerified: new Date(),
        tokenVersion: 0,
        appleId: null,
      };
      vi.mocked(authRepository.findUserByAppleIdOrEmail).mockResolvedValueOnce(existingUser as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce({ ...existingUser, name: 'test', appleId: 'apple-sub-123' } as never);

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({ id_token: 'valid-token', state });
      await POST(request);

      const call = findInfoCall('Updating existing user via Apple OAuth');
      expect(call).toBeDefined();
      const meta = call?.[1] as { email?: string };
      expect(meta.email).toBe('te***@example.com');
    });

    it('does not include name in "User updated via Apple OAuth" log', async () => {
      const existingUser = {
        id: 'existing-id',
        name: null,
        email: 'test@example.com',
        image: null,
        emailVerified: new Date(),
        tokenVersion: 0,
        appleId: null,
      };
      vi.mocked(authRepository.findUserByAppleIdOrEmail).mockResolvedValueOnce(existingUser as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce({ ...existingUser, name: 'test', appleId: 'apple-sub-123' } as never);

      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({ id_token: 'valid-token', state });
      await POST(request);

      const call = findInfoCall('User updated via Apple OAuth');
      expect(call).toBeDefined();
      const meta = call?.[1] as Record<string, unknown>;
      expect(meta).not.toHaveProperty('name');
      expect(meta).toHaveProperty('userId');
    });

    it('masks email in desktop missing-deviceId error log', async () => {
      const state = createSignedState({ returnUrl: '/dashboard', platform: 'desktop' });
      const request = createCallbackRequest({ id_token: 'valid-token', state });
      await POST(request);

      const errCall = vi.mocked(loggers.auth.error).mock.calls.find(
        call => call[0] === 'Desktop OAuth callback missing deviceId'
      );
      expect(errCall).toBeDefined();
      const meta = errCall?.[1] as { email?: string };
      expect(meta.email).toBe('te***@example.com');
    });
  });
});
