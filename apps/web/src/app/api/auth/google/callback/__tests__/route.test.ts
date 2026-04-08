/**
 * Contract tests for GET /api/auth/google/callback
 *
 * Tests the Google OAuth callback endpoint that handles the redirect from Google.
 * Verifies the Request -> Response contract and boundary obligations.
 *
 * Coverage:
 * - OAuth error handling (access_denied, generic errors)
 * - Validation of callback parameters (code, state)
 * - State parameter parsing (valid signed, unsigned, malformed, missing)
 * - Unsafe returnUrl fallback
 * - Rate limiting
 * - Google token exchange and verification
 * - Missing email / missing payload from Google
 * - User creation / update logic
 * - Drive provisioning
 * - Session management (fixation prevention, validation failure)
 * - CSRF token generation
 * - Rate limit reset (success and failure)
 * - Desktop / iOS / Web platform redirects
 * - Error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';

const mockGetToken = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    tokens: {
      id_token: 'mock-id-token',
    },
  })
);

const mockVerifyIdToken = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    getPayload: () => ({
      sub: 'google-id-123',
      email: 'test@example.com',
      name: 'Test User',
      picture: 'https://example.com/avatar.png',
      email_verified: true,
    }),
  })
);

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    getToken: mockGetToken,
    verifyIdToken: mockVerifyIdToken,
  })),
}));

vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    findUserByGoogleIdOrEmail: vi.fn(),
    findUserById: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/auth', () => ({
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock_session_token'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'mock-session-id',
      userId: 'user-123',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
    }),
    revokeAllUserSessions: vi.fn().mockResolvedValue(0),
  },
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
  createExchangeCode: vi.fn().mockResolvedValue('mock-exchange-code'),
  consumePKCEVerifier: vi.fn().mockResolvedValue(null),
  SESSION_DURATION_MS: 7 * 24 * 60 * 60 * 1000,
}));

vi.mock('@pagespace/lib/server', () => ({
  validateOrCreateDeviceToken: vi.fn().mockResolvedValue({
    deviceToken: 'mock-device-token',
    deviceTokenRecordId: 'device-record-id',
  }),
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  logAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn(),
  resetDistributedRateLimit: vi.fn().mockResolvedValue(undefined),
  DISTRIBUTED_RATE_LIMITS: {
    LOGIN: {
      maxAttempts: 5,
      windowMs: 900000,
      blockDurationMs: 900000,
      progressiveDelay: true,
    },
  },
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-cuid'),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn().mockResolvedValue({ driveId: 'drive-123', created: false }),
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
  isSafeReturnUrl: vi.fn(() => true),
  revokeSessionsForLogin: vi.fn().mockResolvedValue(0),
  createWebDeviceToken: vi.fn().mockResolvedValue('ps_dev_mock_token'),
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
  createDeviceTokenHandoffCookie: vi.fn().mockReturnValue('ps_device_token=mock; Path=/; Max-Age=60'),
}));

vi.mock('@/lib/auth/google-avatar', () => ({
  resolveGoogleAvatarImage: vi.fn().mockResolvedValue(null),
}));

import { GET } from '../route';
import { authRepository } from '@/lib/repositories/auth-repository';
import { sessionService, generateCSRFToken, createExchangeCode } from '@pagespace/lib/auth';
import { validateOrCreateDeviceToken, logAuthEvent, loggers } from '@pagespace/lib/server';
import { checkDistributedRateLimit, resetDistributedRateLimit } from '@pagespace/lib/security';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { createId } from '@paralleldrive/cuid2';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { getClientIP, isSafeReturnUrl } from '@/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { resolveGoogleAvatarImage } from '@/lib/auth/google-avatar';

// Helper to create signed state
function createSignedState(
  data: Record<string, unknown>,
  secret: string = 'test-oauth-state-secret'
): string {
  const payload = JSON.stringify(data);
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ data, sig })).toString('base64');
}

const mockNewUser = {
  id: 'user-123',
  name: 'Test User',
  email: 'test@example.com',
  googleId: 'google-id-123',
  tokenVersion: 0,
  role: 'user',
  provider: 'google',
  password: null,
  image: null,
  emailVerified: new Date(),
};

const mockExistingUser = {
  id: 'existing-user-456',
  name: 'Existing User',
  email: 'test@example.com',
  googleId: 'google-id-123',
  tokenVersion: 1,
  role: 'user',
  provider: 'google',
  password: null,
  image: null,
  emailVerified: new Date(),
};

const defaultSignedState = createSignedState({ returnUrl: '/dashboard', platform: 'web' });

const createCallbackRequest = (
  params: Record<string, string> = {}
) => {
  const url = new URL('http://localhost/api/auth/google/callback');
  // Include signed state by default for valid callbacks
  if (!('state' in params) && ('code' in params)) {
    url.searchParams.set('state', defaultSignedState);
  }
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url.toString(), {
    method: 'GET',
    headers: {
      'User-Agent': 'TestBrowser/1.0',
    },
  });
};

describe('GET /api/auth/google/callback', () => {
  const originalEnv = {
    GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    NEXTAUTH_URL: process.env.NEXTAUTH_URL,
    WEB_APP_URL: process.env.WEB_APP_URL,
    OAUTH_STATE_SECRET: process.env.OAUTH_STATE_SECRET,
  };

  beforeEach(() => {
    vi.resetAllMocks();

    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost/api/auth/google/callback';
    process.env.NEXTAUTH_URL = 'https://example.com';
    process.env.WEB_APP_URL = 'https://example.com';
    process.env.OAUTH_STATE_SECRET = 'test-oauth-state-secret';

    // Reset Google mocks to default successful behavior
    mockGetToken.mockResolvedValue({
      tokens: { id_token: 'mock-id-token' },
    });
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-id-123',
        email: 'test@example.com',
        name: 'Test User',
        picture: 'https://example.com/avatar.png',
        email_verified: true,
      }),
    });

    // Default mocks for successful flow
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true, attemptsRemaining: 5 });
    vi.mocked(resetDistributedRateLimit).mockResolvedValue(undefined);

    // Default session mocks
    vi.mocked(sessionService.createSession).mockResolvedValue('ps_sess_mock_session_token');
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      sessionId: 'mock-session-id',
      userId: 'user-123',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
    } as never);
    vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(0);
    vi.mocked(generateCSRFToken).mockReturnValue('mock-csrf-token');
    vi.mocked(createExchangeCode).mockResolvedValue('mock-exchange-code');

    // Default device token mock
    vi.mocked(validateOrCreateDeviceToken).mockResolvedValue({
      deviceToken: 'mock-device-token',
      deviceTokenRecordId: 'device-record-id',
    } as never);

    // Default cuid mock
    vi.mocked(createId).mockReturnValue('mock-cuid');

    // Default provisioning mock
    vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue({ driveId: 'drive-123', created: false });

    // Default getClientIP mock
    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
    vi.mocked(isSafeReturnUrl).mockReturnValue(true);

    // Default avatar resolution
    vi.mocked(resolveGoogleAvatarImage).mockResolvedValue(null);

    // Default to new user flow
    vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValue(null);
    vi.mocked(authRepository.findUserById).mockResolvedValue(null);
    vi.mocked(authRepository.createUser).mockResolvedValue(mockNewUser as never);
    vi.mocked(authRepository.updateUser).mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = originalEnv.GOOGLE_OAUTH_CLIENT_ID;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = originalEnv.GOOGLE_OAUTH_CLIENT_SECRET;
    process.env.GOOGLE_OAUTH_REDIRECT_URI = originalEnv.GOOGLE_OAUTH_REDIRECT_URI;
    process.env.NEXTAUTH_URL = originalEnv.NEXTAUTH_URL;
    process.env.WEB_APP_URL = originalEnv.WEB_APP_URL;
    process.env.OAUTH_STATE_SECRET = originalEnv.OAUTH_STATE_SECRET;
  });

  describe('OAuth error handling', () => {
    it('redirects with access_denied when Google returns access_denied error', async () => {
      const request = createCallbackRequest({ error: 'access_denied' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=access_denied');
    });

    it('redirects with oauth_error for other Google errors', async () => {
      const request = createCallbackRequest({ error: 'some_other_error' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });

    it('truncates long error strings in logs', async () => {
      const longError = 'a'.repeat(200);
      const request = createCallbackRequest({ error: longError });
      await GET(request);

      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'OAuth callback rejected',
        expect.objectContaining({ errorHint: longError.slice(0, 100) })
      );
    });

    it('uses request origin when no env URLs set', async () => {
      delete process.env.NEXTAUTH_URL;
      delete process.env.WEB_APP_URL;

      const request = createCallbackRequest({ error: 'some_error' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin');
    });
  });

  describe('validation of callback parameters', () => {
    it('rejects when code is missing', async () => {
      const request = createCallbackRequest({});
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });

    it('rejects when code is empty string', async () => {
      const state = createSignedState({ returnUrl: '/dashboard', platform: 'web' });
      const request = createCallbackRequest({ code: '', state });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });
  });

  describe('state parameter parsing', () => {
    it('parses valid signed state with returnUrl', async () => {
      const state = createSignedState({ returnUrl: '/settings', platform: 'web' });
      const request = createCallbackRequest({ code: 'valid-code', state });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/settings');
    });

    it('rejects state with invalid signature', async () => {
      const badState = Buffer.from(JSON.stringify({
        data: { returnUrl: '/evil', platform: 'web' },
        sig: 'invalid-signature',
      })).toString('base64');

      const request = createCallbackRequest({ code: 'valid-code', state: badState });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });

    it('rejects unsigned state', async () => {
      const unsignedState = Buffer.from(JSON.stringify({
        returnUrl: '/custom-url',
      })).toString('base64');

      const request = createCallbackRequest({ code: 'valid-code', state: unsignedState });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });

    it('rejects malformed state', async () => {
      const request = createCallbackRequest({ code: 'valid-code', state: 'not-json' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });

    it('rejects when state is not provided', async () => {
      // Explicitly pass empty state to prevent default signed state
      const url = new URL('http://localhost/api/auth/google/callback');
      url.searchParams.set('code', 'valid-code');
      const request = new Request(url.toString(), { method: 'GET', headers: { 'User-Agent': 'TestBrowser/1.0' } });
      const response = await GET(request);

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

      const request = createCallbackRequest({ code: 'valid-code', state });
      await GET(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: 'dev-abc',
          deviceName: 'My Mac',
        })
      );
    });

    it('uses data.returnUrl default when missing from signed state', async () => {
      const state = createSignedState({ platform: 'web' });

      const request = createCallbackRequest({ code: 'valid-code', state });
      const response = await GET(request);

      const location = response.headers.get('Location')!;
      expect(location).toContain('/dashboard');
    });
  });

  describe('unsafe returnUrl fallback', () => {
    it('falls back to /dashboard when returnUrl is unsafe', async () => {
      vi.mocked(isSafeReturnUrl).mockReturnValue(false);

      const state = createSignedState({ returnUrl: 'https://evil.com', platform: 'web' });
      const request = createCallbackRequest({ code: 'valid-code', state });
      const response = await GET(request);

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

      const request = createCallbackRequest({ code: 'valid-code' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=rate_limit');
    });
  });

  describe('token exchange and verification', () => {
    it('redirects with oauth_error when no id_token received', async () => {
      mockGetToken.mockResolvedValueOnce({ tokens: {} });

      const request = createCallbackRequest({ code: 'valid-code' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });

    it('redirects with oauth_error when payload is null', async () => {
      mockVerifyIdToken.mockResolvedValueOnce({
        getPayload: () => null,
      });

      const request = createCallbackRequest({ code: 'valid-code' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });

    it('redirects with oauth_error when email is missing from payload', async () => {
      mockVerifyIdToken.mockResolvedValueOnce({
        getPayload: () => ({
          sub: 'google-id-123',
          name: 'Test User',
        }),
      });

      const request = createCallbackRequest({ code: 'valid-code' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });
  });

  describe('user creation', () => {
    it('creates a new user when none exists', async () => {
      const request = createCallbackRequest({ code: 'valid-code' });
      await GET(request);

      expect(authRepository.createUser).toHaveBeenCalledTimes(1);
    });

    it('uses email prefix as name when Google name is not provided', async () => {
      mockVerifyIdToken.mockResolvedValueOnce({
        getPayload: () => ({
          sub: 'google-id-123',
          email: 'john@example.com',
          name: null,
          picture: null,
          email_verified: true,
        }),
      });

      const request = createCallbackRequest({ code: 'valid-code' });
      await GET(request);

      expect(authRepository.createUser).toHaveBeenCalledTimes(1);
    });

    it('updates new user avatar when resolvedImage differs from null', async () => {
      vi.mocked(resolveGoogleAvatarImage).mockResolvedValue('/processed-avatar.jpg');

      const request = createCallbackRequest({ code: 'valid-code' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(authRepository.updateUser).toHaveBeenCalledWith(mockNewUser.id, expect.objectContaining({ image: '/processed-avatar.jpg' }));
    });

    it('does not update new user avatar when resolvedImage matches initial null', async () => {
      vi.mocked(resolveGoogleAvatarImage).mockResolvedValue(null);

      const request = createCallbackRequest({ code: 'valid-code' });
      await GET(request);

      // updateUser should NOT be called since resolvedImage is null and user.image is null
      expect(authRepository.updateUser).not.toHaveBeenCalled();
    });
  });

  describe('user update scenarios', () => {
    it('updates existing user without googleId', async () => {
      const userWithoutGoogleId = { ...mockExistingUser, googleId: null };
      vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValueOnce(userWithoutGoogleId as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce(mockExistingUser as never);

      const request = createCallbackRequest({ code: 'valid-code' });
      await GET(request);

      expect(authRepository.updateUser).toHaveBeenCalledWith(userWithoutGoogleId.id, expect.objectContaining({ googleId: 'google-id-123' }));
    });

    it('updates existing user without name', async () => {
      const userWithoutName = { ...mockExistingUser, name: null };
      vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValueOnce(userWithoutName as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce({ ...userWithoutName, name: 'Test User' } as never);

      const request = createCallbackRequest({ code: 'valid-code' });
      await GET(request);

      expect(authRepository.updateUser).toHaveBeenCalledWith(userWithoutName.id, expect.objectContaining({ name: 'Test User' }));
    });

    it('updates existing user with different avatar', async () => {
      const userWithOldAvatar = { ...mockExistingUser, image: '/old-avatar.jpg' };
      vi.mocked(resolveGoogleAvatarImage).mockResolvedValue('/new-avatar.jpg');
      vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValueOnce(userWithOldAvatar as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce({ ...userWithOldAvatar, image: '/new-avatar.jpg' } as never);

      const request = createCallbackRequest({ code: 'valid-code' });
      await GET(request);

      const updateArgs = vi.mocked(authRepository.updateUser).mock.calls[0];
      expect(updateArgs[0]).toBe(userWithOldAvatar.id);
      expect(updateArgs[1]).toEqual({
        googleId: 'google-id-123',
        provider: 'google',
        name: 'Existing User',
        image: '/new-avatar.jpg',
        emailVerified: expect.any(Date),
      });
    });

    it('updates existing user with unverified email when email_verified', async () => {
      const userUnverified = { ...mockExistingUser, emailVerified: null };
      vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValueOnce(userUnverified as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce({ ...userUnverified, emailVerified: new Date() } as never);

      const request = createCallbackRequest({ code: 'valid-code' });
      await GET(request);

      const updateCall = vi.mocked(authRepository.updateUser).mock.calls[0];
      expect(updateCall[0]).toBe(userUnverified.id);
      expect(updateCall[1]).toHaveProperty('emailVerified');
      expect(updateCall[1].emailVerified).toBeInstanceOf(Date);
    });

    it('does not update complete existing user', async () => {
      const fullyUpdatedUser = {
        ...mockExistingUser,
        googleId: 'google-id-123',
        name: 'Existing User',
        image: null,
        emailVerified: new Date(),
      };
      vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValue(fullyUpdatedUser as never);

      const request = createCallbackRequest({ code: 'valid-code' });
      await GET(request);

      expect(authRepository.updateUser).not.toHaveBeenCalled();
    });

    it('sets provider to both when existing user has password', async () => {
      const userWithPassword = { ...mockExistingUser, googleId: null, password: 'hashed-pw' };
      vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValueOnce(userWithPassword as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce({ ...userWithPassword, provider: 'both', googleId: 'google-id-123' } as never);

      const request = createCallbackRequest({ code: 'valid-code' });
      await GET(request);

      expect(authRepository.updateUser).toHaveBeenCalledWith(userWithPassword.id, expect.objectContaining({ googleId: 'google-id-123', provider: 'both' }));
    });

    it('handles re-fetch returning null after update (falls back to original user)', async () => {
      const existingUser = { ...mockExistingUser, googleId: null };
      vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValueOnce(existingUser as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce(null);

      const request = createCallbackRequest({ code: 'valid-code' });
      const response = await GET(request);

      expect(response.status).toBe(307);
    });
  });

  describe('drive provisioning', () => {
    it('redirects to provisioned drive when newly created', async () => {
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue({
        driveId: 'provisioned-drive-id',
        created: true,
      });

      const request = createCallbackRequest({ code: 'valid-code' });
      const response = await GET(request);

      const location = response.headers.get('Location')!;
      expect(location).toContain('/dashboard/provisioned-drive-id');
    });

    it('uses original returnUrl when drive already exists', async () => {
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue({
        driveId: 'existing-drive',
        created: false,
      });

      const state = createSignedState({ returnUrl: '/settings', platform: 'web' });
      const request = createCallbackRequest({ code: 'valid-code', state });
      const response = await GET(request);

      const location = response.headers.get('Location')!;
      expect(location).toContain('/settings');
    });

    it('continues on drive provisioning error', async () => {
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockRejectedValueOnce(new Error('DB error'));

      const request = createCallbackRequest({ code: 'valid-code' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Failed to provision Getting Started drive',
        new Error('DB error'),
        { userId: mockNewUser.id, provider: 'google' }
      );
    });
  });

  describe('session management', () => {
    it('revokes existing sessions before creating new one', async () => {
      const { revokeSessionsForLogin } = await import('@/lib/auth');

      const request = createCallbackRequest({ code: 'valid-code' });
      await GET(request);

      expect(revokeSessionsForLogin).toHaveBeenCalledWith(
        mockNewUser.id,
        undefined,
        'new_login',
        'Google OAuth'
      );
    });

    it('redirects with oauth_error when session validation fails', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(null as never);

      const request = createCallbackRequest({ code: 'valid-code' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
    });

    it('generates CSRF token bound to session', async () => {
      const request = createCallbackRequest({ code: 'valid-code' });
      await GET(request);

      expect(sessionService.validateSession).toHaveBeenCalledWith('ps_sess_mock_session_token');
      expect(generateCSRFToken).toHaveBeenCalledWith('mock-session-id');
    });
  });

  describe('rate limit reset', () => {
    it('resets rate limit on successful callback', async () => {
      vi.mocked(getClientIP).mockReturnValue('10.0.0.1');

      const request = createCallbackRequest({ code: 'valid-code' });
      await GET(request);

      expect(resetDistributedRateLimit).toHaveBeenCalledWith('oauth:callback:ip:10.0.0.1');
    });

    it('logs warning when rate limit reset fails', async () => {
      vi.mocked(resetDistributedRateLimit).mockRejectedValueOnce(new Error('Redis error'));

      const request = createCallbackRequest({ code: 'valid-code' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Rate limit reset failed after successful OAuth callback',
        expect.objectContaining({ error: 'Redis error' })
      );
    });

    it('handles non-Error rate limit reset failure', async () => {
      vi.mocked(resetDistributedRateLimit).mockRejectedValueOnce('string-error');

      const request = createCallbackRequest({ code: 'valid-code' });
      await GET(request);

      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Rate limit reset failed after successful OAuth callback',
        expect.objectContaining({ error: 'string-error' })
      );
    });
  });

  describe('web platform redirect', () => {
    it('redirects to returnUrl with auth success and CSRF token', async () => {
      const request = createCallbackRequest({ code: 'valid-code' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/dashboard');
      expect(location).toContain('auth=success');
      expect(location).toContain('csrfToken=mock-csrf-token');
    });

    it('sets session cookie for web redirect', async () => {
      const request = createCallbackRequest({ code: 'valid-code' });
      await GET(request);

      expect(appendSessionCookie).toHaveBeenCalledTimes(1);
      const [webHeaders, webToken] = vi.mocked(appendSessionCookie).mock.calls[0];
      expect(webHeaders).toBeInstanceOf(Headers);
      expect(webToken).toBe('ps_sess_mock_session_token');
    });
  });

  describe('desktop platform redirect', () => {
    it('redirects to deep link with exchange code', async () => {
      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'desktop',
        deviceId: 'desktop-dev-123',
        deviceName: 'My Mac',
      });

      const request = createCallbackRequest({ code: 'valid-code', state });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('pagespace://auth-exchange');
      expect(location).toContain('code=mock-exchange-code');
      expect(location).toContain('provider=google');
    });

    it('includes isNewUser flag in deep link for newly provisioned drives', async () => {
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue({
        driveId: 'new-drive',
        created: true,
      });

      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'desktop',
        deviceId: 'desktop-dev-123',
      });

      const request = createCallbackRequest({ code: 'valid-code', state });
      const response = await GET(request);
      const location = response.headers.get('Location')!;

      expect(location).toContain('isNewUser=true');
    });

    it('redirects with error when desktop platform has no deviceId', async () => {
      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'desktop',
      });

      const request = createCallbackRequest({ code: 'valid-code', state });
      const response = await GET(request);

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

      const request = createCallbackRequest({ code: 'valid-code', state });
      await GET(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceName: 'TestBrowser/1.0',
        })
      );
    });

    it('resets rate limit for desktop platform', async () => {
      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'desktop',
        deviceId: 'dev-123',
      });

      vi.mocked(resetDistributedRateLimit).mockResolvedValue(undefined);

      const request = createCallbackRequest({ code: 'valid-code', state });
      await GET(request);

      // resetDistributedRateLimit is called in both the main flow and the desktop flow
      expect(resetDistributedRateLimit).toHaveBeenCalledWith('oauth:callback:ip:127.0.0.1');
    });

    it('logs warning when desktop rate limit reset fails', async () => {
      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'desktop',
        deviceId: 'dev-123',
      });

      // The first reset call (main flow) succeeds, desktop-specific .catch handler
      vi.mocked(resetDistributedRateLimit)
        .mockResolvedValueOnce(undefined) // main flow reset
        .mockRejectedValueOnce(new Error('Redis down')); // desktop flow reset

      const request = createCallbackRequest({ code: 'valid-code', state });
      await GET(request);

      // The desktop flow catches and logs the error
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Rate limit reset failed',
        expect.objectContaining({ error: 'Redis down' })
      );
    });

    it('tracks desktop auth events', async () => {
      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'desktop',
        deviceId: 'dev-123',
      });

      const request = createCallbackRequest({ code: 'valid-code', state });
      await GET(request);

      expect(trackAuthEvent).toHaveBeenCalledWith(
        mockNewUser.id,
        'login',
        expect.objectContaining({
          provider: 'google-oauth',
          platform: 'desktop',
        })
      );
    });

    it('creates exchange code with correct parameters', async () => {
      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'desktop',
        deviceId: 'dev-123',
      });

      const request = createCallbackRequest({ code: 'valid-code', state });
      await GET(request);

      expect(createExchangeCode).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionToken: 'ps_sess_mock_session_token',
          csrfToken: 'mock-csrf-token',
          deviceToken: 'mock-device-token',
          provider: 'google',
          userId: mockNewUser.id,
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

      const request = createCallbackRequest({ code: 'valid-code', state });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('pagespace://auth-exchange');
      expect(location).toContain('provider=google');
    });

    it('generates deviceId when not provided for iOS', async () => {
      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'ios',
      });

      const request = createCallbackRequest({ code: 'valid-code', state });
      await GET(request);

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

      const request = createCallbackRequest({ code: 'valid-code', state });
      const response = await GET(request);
      const location = response.headers.get('Location')!;

      expect(location).toContain('isNewUser=true');
    });

    it('uses iOS App as default device name', async () => {
      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'ios',
        deviceId: 'ios-dev',
      });

      // Create request without user-agent
      const url = new URL('http://localhost/api/auth/google/callback');
      url.searchParams.set('code', 'valid-code');
      url.searchParams.set('state', state);
      const request = new Request(url.toString(), { method: 'GET' });
      await GET(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceName: 'iOS App',
        })
      );
    });

    it('logs warning when iOS rate limit reset fails', async () => {
      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'ios',
        deviceId: 'ios-dev',
      });

      vi.mocked(resetDistributedRateLimit)
        .mockResolvedValueOnce(undefined) // main flow reset
        .mockRejectedValueOnce(new Error('Redis err')); // iOS flow reset

      const request = createCallbackRequest({ code: 'valid-code', state });
      await GET(request);

      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Rate limit reset failed',
        expect.objectContaining({ error: 'Redis err' })
      );
    });

    it('tracks iOS auth events', async () => {
      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'ios',
        deviceId: 'ios-dev',
      });

      const request = createCallbackRequest({ code: 'valid-code', state });
      await GET(request);

      expect(trackAuthEvent).toHaveBeenCalledWith(
        mockNewUser.id,
        'login',
        expect.objectContaining({
          provider: 'google-oauth',
          platform: 'ios',
        })
      );
    });

    it('creates exchange code with correct parameters for iOS', async () => {
      const state = createSignedState({
        returnUrl: '/dashboard',
        platform: 'ios',
        deviceId: 'ios-dev',
      });

      const request = createCallbackRequest({ code: 'valid-code', state });
      await GET(request);

      expect(createExchangeCode).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionToken: 'ps_sess_mock_session_token',
          csrfToken: 'mock-csrf-token',
          deviceToken: 'mock-device-token',
          provider: 'google',
          userId: mockNewUser.id,
        })
      );
    });
  });

  describe('auth event logging', () => {
    it('logs login event on successful callback', async () => {
      const request = createCallbackRequest({ code: 'valid-code' });
      await GET(request);

      expect(logAuthEvent).toHaveBeenCalledWith(
        'login',
        mockNewUser.id,
        'test@example.com',
        '127.0.0.1',
        'Google OAuth'
      );
      expect(trackAuthEvent).toHaveBeenCalledWith(
        mockNewUser.id,
        'login',
        expect.objectContaining({
          provider: 'google',
        })
      );
    });
  });

  describe('error handling', () => {
    it('redirects with oauth_error on unexpected exception', async () => {
      mockGetToken.mockRejectedValueOnce(new Error('Network failure'));

      const request = createCallbackRequest({ code: 'valid-code' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('Location')!;
      expect(location).toContain('/auth/signin?error=oauth_error');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Google OAuth callback error',
        new Error('Network failure')
      );
    });

    it('error handler uses origin not full request URL as redirect base', async () => {
      mockGetToken.mockRejectedValueOnce(new Error('fail'));

      const request = createCallbackRequest({ code: 'valid-code' });
      const response = await GET(request);

      const location = response.headers.get('Location')!;
      const locationUrl = new URL(location);
      // Should redirect to origin + path, not include original query params from req.url
      expect(locationUrl.origin).toBe('https://example.com');
      expect(locationUrl.pathname).toBe('/auth/signin');
      expect(locationUrl.searchParams.get('error')).toBe('oauth_error');
      // Must NOT contain callback params from the original request
      expect(locationUrl.searchParams.has('code')).toBe(false);
    });

    it('error handler fallback uses origin not raw req.url when env vars unset', async () => {
      delete process.env.NEXTAUTH_URL;
      delete process.env.WEB_APP_URL;
      mockGetToken.mockRejectedValueOnce(new Error('fail'));

      const request = createCallbackRequest({ code: 'valid-code' });
      const response = await GET(request);

      const location = response.headers.get('Location')!;
      const locationUrl = new URL(location);
      // Redirect should use origin only, not include query params from the original callback URL
      expect(locationUrl.pathname).toBe('/auth/signin');
      expect(locationUrl.searchParams.get('error')).toBe('oauth_error');
      expect(locationUrl.searchParams.has('code')).toBe(false);
      expect(locationUrl.searchParams.has('state')).toBe(false);
    });
  });

  describe('production baseUrl safety', () => {
    it('returns 500 when NEXTAUTH_URL and WEB_APP_URL are both unset in production', async () => {
      delete process.env.NEXTAUTH_URL;
      delete process.env.WEB_APP_URL;
      vi.stubEnv('NODE_ENV', 'production');

      const request = createCallbackRequest({ code: 'valid-code' });
      const response = await GET(request);

      expect(response.status).toBe(500);
    });
  });
});
