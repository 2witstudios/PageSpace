/**
 * Contract tests for POST /api/auth/google/one-tap
 *
 * Tests the Google One Tap sign-in endpoint.
 * Verifies the Request -> Response contract and boundary obligations.
 *
 * Coverage:
 * - Environment validation (missing GOOGLE_OAUTH_CLIENT_ID)
 * - Input validation (credential, platform, deviceId, deviceName)
 * - Rate limiting
 * - Google ID token verification (success, failure, empty payload, missing email)
 * - User creation / update logic
 * - Drive provisioning
 * - Rate limit reset (success and failure)
 * - Desktop platform (deviceId required, device token creation)
 * - Web platform (session creation, CSRF, cookie)
 * - Session validation failure
 * - Auth event logging
 * - Error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
    verifyIdToken: mockVerifyIdToken,
  })),
}));

vi.mock('@pagespace/db', () => ({
  users: { id: 'id', googleId: 'googleId', email: 'email' },
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn(),
    update: vi.fn(),
  },
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
  or: vi.fn((...conditions: unknown[]) => conditions),
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
  createId: vi.fn(() => 'mock-user-id'),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn().mockResolvedValue({ driveId: 'drive-123', created: false }),
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
}));

vi.mock('@/lib/auth/google-avatar', () => ({
  resolveGoogleAvatarImage: vi.fn().mockResolvedValue(null),
}));

import { POST } from '../route';
import { db, users } from '@pagespace/db';
import { sessionService, generateCSRFToken } from '@pagespace/lib/auth';
import { validateOrCreateDeviceToken, logAuthEvent, loggers } from '@pagespace/lib/server';
import { checkDistributedRateLimit, resetDistributedRateLimit } from '@pagespace/lib/security';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { getClientIP } from '@/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { resolveGoogleAvatarImage } from '@/lib/auth/google-avatar';

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

const createOneTapRequest = (
  payload: Record<string, unknown>,
  additionalHeaders: Record<string, string> = {}
) => {
  return new Request('http://localhost/api/auth/google/one-tap', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'TestBrowser/1.0',
      ...additionalHeaders,
    },
    body: JSON.stringify(payload),
  });
};

const validOneTapPayload = {
  credential: 'valid-google-credential',
  platform: 'web',
};

describe('POST /api/auth/google/one-tap', () => {
  const originalEnv = {
    GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
  };

  beforeEach(() => {
    vi.resetAllMocks();

    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';

    // Reset Google token verification mock
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-id-123',
        email: 'test@example.com',
        name: 'Test User',
        picture: 'https://example.com/avatar.png',
        email_verified: true,
      }),
    });

    // Default mocks
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true, attemptsRemaining: 5 });
    vi.mocked(resetDistributedRateLimit).mockResolvedValue(undefined);

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

    vi.mocked(validateOrCreateDeviceToken).mockResolvedValue({
      deviceToken: 'mock-device-token',
      deviceTokenRecordId: 'device-record-id',
    } as never);

    vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue({ driveId: 'drive-123', created: false });
    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
    vi.mocked(resolveGoogleAvatarImage).mockResolvedValue(null);

    // Default to new user flow
    vi.mocked(db.query.users.findFirst).mockResolvedValue(null as never);

    vi.mocked(db.insert).mockImplementation((table: unknown) => {
      if (table === users) {
        return {
          values: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([mockNewUser])),
          })),
        } as never;
      }
      return {
        values: vi.fn(() => Promise.resolve(undefined)),
      } as never;
    });

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as never);
  });

  afterEach(() => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = originalEnv.GOOGLE_OAUTH_CLIENT_ID;
  });

  describe('environment validation', () => {
    it('returns 500 when GOOGLE_OAUTH_CLIENT_ID is missing', async () => {
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;

      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('not configured');
    });
  });

  describe('input validation', () => {
    it('returns 400 for missing credential', async () => {
      const request = createOneTapRequest({ platform: 'web' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request');
      expect(body.details.credential).toBeDefined();
    });

    it('returns 400 for empty credential', async () => {
      const request = createOneTapRequest({ credential: '' });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('returns 400 for invalid platform', async () => {
      const request = createOneTapRequest({ credential: 'valid', platform: 'ios' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.details.platform).toBeDefined();
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when rate limit exceeded', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: 900,
      });

      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many sign-in attempts');
      expect(body.retryAfter).toBe(900);
      expect(response.headers.get('Retry-After')).toBe('900');
    });

    it('includes rate limit headers when exceeded', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: undefined,
      });

      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);

      expect(response.headers.get('Retry-After')).toBe('900');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    });
  });

  describe('token verification', () => {
    it('returns 401 when Google ID token verification fails', async () => {
      mockVerifyIdToken.mockRejectedValueOnce(new Error('Token verification failed'));

      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toContain('Invalid Google credential');
    });

    it('returns 401 when payload is empty', async () => {
      mockVerifyIdToken.mockResolvedValueOnce({
        getPayload: () => null,
      });

      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toContain('Invalid Google credential');
    });

    it('returns 400 when email is missing from payload', async () => {
      mockVerifyIdToken.mockResolvedValueOnce({
        getPayload: () => ({
          sub: 'google-id-123',
          name: 'Test User',
        }),
      });

      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Email is required');
    });
  });

  describe('successful web authentication', () => {
    it('returns success with user data and CSRF token for new user', async () => {
      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.user.id).toBe(mockNewUser.id);
      expect(body.user.name).toBe(mockNewUser.name);
      expect(body.user.email).toBe(mockNewUser.email);
      expect(body.csrfToken).toBe('mock-csrf-token');
      expect(body.isNewUser).toBe(true);
    });

    it('returns success for existing user', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockExistingUser as never);

      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.isNewUser).toBe(false);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('sets session cookie for web platform', async () => {
      const request = createOneTapRequest(validOneTapPayload);
      await POST(request);

      expect(appendSessionCookie).toHaveBeenCalled();
    });

    it('revokes existing sessions before creating new one', async () => {
      vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(2);

      const request = createOneTapRequest(validOneTapPayload);
      await POST(request);

      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(
        mockNewUser.id,
        'new_login'
      );
      expect(loggers.auth.info).toHaveBeenCalledWith(
        'Revoked existing sessions on Google One Tap login',
        expect.objectContaining({ count: 2 })
      );
    });

    it('returns redirectTo with provisioned drive when created', async () => {
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue({
        driveId: 'new-drive-id',
        created: true,
      });

      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(body.redirectTo).toBe('/dashboard/new-drive-id');
    });

    it('returns /dashboard redirectTo when drive not newly created', async () => {
      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(body.redirectTo).toBe('/dashboard');
    });
  });

  describe('session validation failure', () => {
    it('returns 500 when session validation fails', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(null as never);

      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Session creation failed');
    });
  });

  describe('desktop platform', () => {
    it('returns 400 when desktop platform has no deviceId', async () => {
      const request = createOneTapRequest({
        credential: 'valid-credential',
        platform: 'desktop',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Device ID required');
    });

    it('returns device token for desktop platform with deviceId', async () => {
      const request = createOneTapRequest({
        credential: 'valid-credential',
        platform: 'desktop',
        deviceId: 'device-123',
        deviceName: 'My Desktop',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.tokens.deviceToken).toBe('mock-device-token');
      expect(body.isNewUser).toBe(true);
    });

    it('creates device token with correct parameters', async () => {
      const request = createOneTapRequest({
        credential: 'valid-credential',
        platform: 'desktop',
        deviceId: 'device-123',
        deviceName: 'My Desktop',
      });
      await POST(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockNewUser.id,
          deviceId: 'device-123',
          platform: 'desktop',
          deviceName: 'My Desktop',
        })
      );
    });

    it('uses user-agent as fallback device name for desktop', async () => {
      const request = createOneTapRequest({
        credential: 'valid-credential',
        platform: 'desktop',
        deviceId: 'device-123',
      });
      await POST(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceName: 'TestBrowser/1.0',
        })
      );
    });

    it('does not set session cookie for desktop', async () => {
      const request = createOneTapRequest({
        credential: 'valid-credential',
        platform: 'desktop',
        deviceId: 'device-123',
      });
      await POST(request);

      expect(appendSessionCookie).not.toHaveBeenCalled();
    });

    it('does not create session for desktop platform', async () => {
      const request = createOneTapRequest({
        credential: 'valid-credential',
        platform: 'desktop',
        deviceId: 'device-123',
      });
      await POST(request);

      // Session is not created for desktop (device tokens are used instead)
      expect(sessionService.createSession).not.toHaveBeenCalled();
    });
  });

  describe('user update scenarios', () => {
    it('updates existing user without googleId', async () => {
      const userWithoutGoogleId = { ...mockExistingUser, googleId: null };
      vi.mocked(db.query.users.findFirst)
        .mockResolvedValueOnce(userWithoutGoogleId as never)
        .mockResolvedValueOnce(mockExistingUser as never);

      const request = createOneTapRequest(validOneTapPayload);
      await POST(request);

      expect(db.update).toHaveBeenCalled();
    });

    it('updates existing user with different avatar', async () => {
      const userWithOldAvatar = { ...mockExistingUser, image: '/old-avatar.jpg' };
      vi.mocked(resolveGoogleAvatarImage).mockResolvedValue('/new-avatar.jpg');
      vi.mocked(db.query.users.findFirst)
        .mockResolvedValueOnce(userWithOldAvatar as never)
        .mockResolvedValueOnce({ ...userWithOldAvatar, image: '/new-avatar.jpg' } as never);

      const request = createOneTapRequest(validOneTapPayload);
      await POST(request);

      expect(db.update).toHaveBeenCalled();
    });

    it('does not update complete existing user', async () => {
      const fullyUpdatedUser = {
        ...mockExistingUser,
        googleId: 'google-id-123',
        name: 'Existing User',
        image: null,
        emailVerified: new Date(),
      };
      vi.mocked(db.query.users.findFirst).mockResolvedValue(fullyUpdatedUser as never);

      const request = createOneTapRequest(validOneTapPayload);
      await POST(request);

      expect(db.update).not.toHaveBeenCalled();
    });

    it('updates new user avatar when resolvedImage differs from null', async () => {
      vi.mocked(resolveGoogleAvatarImage).mockResolvedValue('/processed-avatar.jpg');

      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(db.update).toHaveBeenCalled();
    });

    it('sets provider to both when existing user has password', async () => {
      const userWithPassword = { ...mockExistingUser, googleId: null, password: 'hashed-pw' };
      vi.mocked(db.query.users.findFirst)
        .mockResolvedValueOnce(userWithPassword as never)
        .mockResolvedValueOnce({ ...userWithPassword, provider: 'both', googleId: 'google-id-123' } as never);

      const request = createOneTapRequest(validOneTapPayload);
      await POST(request);

      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('drive provisioning', () => {
    it('continues on drive provisioning error', async () => {
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockRejectedValue(new Error('DB error'));

      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Failed to provision Getting Started drive',
        expect.any(Error),
        expect.objectContaining({ provider: 'google-one-tap' })
      );
    });
  });

  describe('rate limit reset', () => {
    it('resets rate limit on successful login', async () => {
      const request = createOneTapRequest(validOneTapPayload);
      await POST(request);

      expect(resetDistributedRateLimit).toHaveBeenCalledWith('oauth:onetap:ip:127.0.0.1');
    });

    it('logs warning when rate limit reset fails', async () => {
      vi.mocked(resetDistributedRateLimit).mockRejectedValue(new Error('Redis error'));

      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Rate limit reset failed after successful One Tap',
        expect.objectContaining({ error: 'Redis error' })
      );
    });

    it('handles non-Error rate limit reset failure', async () => {
      vi.mocked(resetDistributedRateLimit).mockRejectedValue('string-error');

      const request = createOneTapRequest(validOneTapPayload);
      await POST(request);

      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Rate limit reset failed after successful One Tap',
        expect.objectContaining({ error: 'string-error' })
      );
    });
  });

  describe('auth event logging', () => {
    it('logs login event on successful web authentication', async () => {
      const request = createOneTapRequest(validOneTapPayload);
      await POST(request);

      expect(logAuthEvent).toHaveBeenCalledWith(
        'login',
        mockNewUser.id,
        'test@example.com',
        '127.0.0.1',
        'Google One Tap'
      );
    });

    it('tracks signup event for new users', async () => {
      const request = createOneTapRequest(validOneTapPayload);
      await POST(request);

      expect(trackAuthEvent).toHaveBeenCalledWith(
        mockNewUser.id,
        'signup',
        expect.objectContaining({
          provider: 'google-one-tap',
        })
      );
    });

    it('tracks login event for existing users', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockExistingUser as never);

      const request = createOneTapRequest(validOneTapPayload);
      await POST(request);

      expect(trackAuthEvent).toHaveBeenCalledWith(
        mockExistingUser.id,
        'login',
        expect.objectContaining({
          provider: 'google-one-tap',
        })
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected exception', async () => {
      vi.mocked(db.query.users.findFirst).mockRejectedValue(new Error('Database error'));

      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('unexpected error');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Google One Tap error',
        expect.any(Error)
      );
    });
  });
});
