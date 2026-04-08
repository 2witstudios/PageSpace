/**
 * Contract tests for GET /api/auth/google/callback
 *
 * These tests verify session-based authentication in OAuth callback flow.
 * Uses session-based auth with opaque tokens for web platform.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { GET } from '../callback/route';

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    getToken: vi.fn().mockResolvedValue({
      tokens: {
        id_token: 'valid-id-token',
        access_token: 'access-token',
      },
    }),
    verifyIdToken: vi.fn().mockResolvedValue({
      getPayload: () => ({
        sub: 'google-id-123',
        email: 'test@example.com',
        name: 'Test User',
        picture: 'https://example.com/avatar.png',
        email_verified: true,
      }),
    }),
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

// Mock session service from @pagespace/lib/auth
vi.mock('@pagespace/lib/auth', () => ({
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock_session_token'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'mock-session-id',
      userId: 'existing-user-456',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
    }),
    revokeAllUserSessions: vi.fn().mockResolvedValue(0),
    revokeSession: vi.fn().mockResolvedValue(undefined),
  },
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
  createExchangeCode: vi.fn().mockResolvedValue('mock-exchange-code'),
  consumePKCEVerifier: vi.fn().mockResolvedValue(null),
  SESSION_DURATION_MS: 7 * 24 * 60 * 60 * 1000,
}));

// Mock cookie utilities
vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
  appendClearCookies: vi.fn(),
  getSessionFromCookies: vi.fn().mockReturnValue('ps_sess_mock_session_token'),
  createDeviceTokenHandoffCookie: vi.fn().mockReturnValue('ps_device_token=mock; Path=/; Max-Age=60'),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  logAuthEvent: vi.fn(),
  validateOrCreateDeviceToken: vi.fn().mockResolvedValue({
    deviceToken: 'mock-device-token',
    deviceTokenRecordId: 'device-record-id',
  }),
}));

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn(),
  resetDistributedRateLimit: vi.fn(),
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
  createId: vi.fn(() => 'mock-id'),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn(),
}));

vi.mock('@/lib/auth/google-avatar', () => ({
  resolveGoogleAvatarImage: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
  return {
    getClientIP: vi.fn(() => '127.0.0.1'),
    revokeSessionsForLogin: vi.fn().mockResolvedValue(0),
    createWebDeviceToken: vi.fn().mockResolvedValue('ps_dev_mock_token'),
    isSafeReturnUrl: actual.isSafeReturnUrl,
  };
});

vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return {
    ...actual,
    default: {
      ...(actual as object),
      createHmac: vi.fn().mockReturnValue({
        update: vi.fn().mockReturnValue({
          digest: vi.fn().mockReturnValue('valid-signature'),
        }),
      }),
    },
  };
});

import { authRepository } from '@/lib/repositories/auth-repository';
import { sessionService } from '@pagespace/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { checkDistributedRateLimit } from '@pagespace/lib/security';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';

// Test fixtures
const mockExistingUser = {
  id: 'existing-user-456',
  name: 'Existing User',
  email: 'test@example.com',
  googleId: 'google-id-123',
  tokenVersion: 1,
  role: 'user',
  provider: 'google',
  password: null,
};

const createCallbackRequest = (params: Record<string, string>) => {
  const url = new URL('http://localhost/api/auth/google/callback');
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return new Request(url.toString(), {
    method: 'GET',
  });
};

const createSignedState = (data: Record<string, unknown>) => {
  const stateData = {
    data,
    sig: 'valid-signature',
  };
  return Buffer.from(JSON.stringify(stateData)).toString('base64');
};

describe('GET /api/auth/google/callback', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up env
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost/api/auth/google/callback';
    process.env.OAUTH_STATE_SECRET = 'test-state-secret';
    process.env.NEXTAUTH_URL = 'http://localhost';

    // Default mocks for successful flow
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true, attemptsRemaining: 5 });
    vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue({ driveId: 'existing-drive', created: false });

    // Default to existing user
    vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValue(mockExistingUser as never);
    vi.mocked(authRepository.findUserById).mockResolvedValue(mockExistingUser as never);
    vi.mocked(authRepository.createUser).mockResolvedValue(mockExistingUser as never);
    vi.mocked(authRepository.updateUser).mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('session-based authentication', () => {
    it('given successful OAuth, should create session and redirect without CSRF token in URL', async () => {
      const state = createSignedState({
        platform: 'web',
        returnUrl: '/dashboard',
      });

      const request = createCallbackRequest({
        code: 'valid-auth-code',
        state,
      });

      const response = await GET(request);

      // Verify session creation
      expect(sessionService.createSession).toHaveBeenCalledWith({
        userId: mockExistingUser.id,
        type: 'user',
        scopes: ['*'],
        expiresInMs: 7 * 24 * 60 * 60 * 1000,
        createdByIp: '127.0.0.1',
      });

      // Verify session cookie is set
      expect(appendSessionCookie).toHaveBeenCalledTimes(1);
      expect(vi.mocked(appendSessionCookie).mock.calls[0][0]).toBeInstanceOf(Headers);
      expect(vi.mocked(appendSessionCookie).mock.calls[0][1]).toBe('ps_sess_mock_session_token');

      // Response should be a redirect
      expect(response.status).toBe(307);

      const location = response.headers.get('location')!;
      expect(location).toContain('auth=success');
      expect(location).not.toContain('csrfToken');
    });

    it('should revoke existing sessions on login (session fixation prevention)', async () => {
      const { revokeSessionsForLogin } = await import('@/lib/auth');

      const state = createSignedState({
        platform: 'web',
        returnUrl: '/dashboard',
      });

      const request = createCallbackRequest({
        code: 'valid-auth-code',
        state,
      });

      await GET(request);

      expect(revokeSessionsForLogin).toHaveBeenCalledWith(
        mockExistingUser.id,
        undefined,
        'new_login',
        'Google OAuth'
      );
    });

    it('given provisioned drive, should redirect to that drive', async () => {
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue({
        driveId: 'new-drive-123',
        created: true,
      });

      const state = createSignedState({
        platform: 'web',
        returnUrl: '/dashboard',
      });

      const request = createCallbackRequest({
        code: 'valid-auth-code',
        state,
      });

      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/dashboard/new-drive-123');
    });

    it('given custom returnUrl, should redirect to that path', async () => {
      const state = createSignedState({
        platform: 'web',
        returnUrl: '/dashboard/my-drive',
      });

      const request = createCallbackRequest({
        code: 'valid-auth-code',
        state,
      });

      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location')!;
      expect(location).toContain('/dashboard/my-drive');
    });
  });

  describe('error handling', () => {
    it('given OAuth error, should redirect to signin with error', async () => {
      const request = createCallbackRequest({
        error: 'access_denied',
      });

      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/auth/signin');
      expect(location).toContain('error=access_denied');
    });

    it('given rate limited IP, should redirect to signin with error', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: 900,
      });

      const state = createSignedState({
        platform: 'web',
        returnUrl: '/dashboard',
      });

      const request = createCallbackRequest({
        code: 'valid-auth-code',
        state,
      });

      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('/auth/signin');
      expect(location).toContain('error=rate_limit');
    });
  });
});
