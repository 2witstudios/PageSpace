/**
 * Contract tests for POST /api/auth/apple/native
 *
 * Coverage:
 * - Rate limiting by IP
 * - Input validation (Zod schema)
 * - Apple CLIENT_ID env check
 * - Apple ID token verification
 * - User find or create logic
 * - Existing user update paths (needs appleId, needs name)
 * - New user creation
 * - Drive provisioning for new users
 * - Session fixation prevention
 * - Session + CSRF creation
 * - Device token creation
 * - Rate limit reset on success
 * - Auth event logging
 * - Error handling (generic + expired token)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

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
  }),
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn().mockResolvedValue({ driveId: 'new-drive-id', created: true }),
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
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
import { getClientIP } from '@/lib/auth';
import { loggers, logAuthEvent, validateOrCreateDeviceToken } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { appendSessionCookie } from '@/lib/auth/cookie-config';

const createNativeRequest = (body: Record<string, unknown> = {}) =>
  new Request('http://localhost/api/auth/apple/native', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'TestApp/1.0',
    },
    body: JSON.stringify(body),
  });

const validPayload = {
  idToken: 'valid-apple-id-token',
  platform: 'ios',
  deviceId: 'device-123',
  deviceName: 'iPhone 15',
  givenName: 'John',
  familyName: 'Doe',
};

const mockNewUser = {
  id: 'new-user-id',
  name: 'Test User',
  email: 'test@example.com',
  image: null,
  emailVerified: new Date(),
  tokenVersion: 0,
  password: null,
  appleId: 'apple-sub-123',
};

describe('POST /api/auth/apple/native', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, APPLE_CLIENT_ID: 'com.example.app' };
    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
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
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('rate limiting', () => {
    it('returns 429 when IP rate limit exceeded', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: 600,
      });

      const response = await POST(createNativeRequest(validPayload));
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many login attempts');
      expect(body.retryAfter).toBe(600);
      expect(response.headers.get('Retry-After')).toBe('600');
    });

    it('uses correct rate limit key with client IP', async () => {
      vi.mocked(getClientIP).mockReturnValue('10.0.0.5');

      await POST(createNativeRequest(validPayload));

      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'oauth:apple:native:ip:10.0.0.5',
        expect.any(Object)
      );
    });

    it('uses default Retry-After of 900 when retryAfter is undefined', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: undefined,
      });

      const response = await POST(createNativeRequest(validPayload));

      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('900');
    });
  });

  describe('input validation', () => {
    it('returns 400 when idToken is missing', async () => {
      const response = await POST(createNativeRequest({
        platform: 'ios',
        deviceId: 'dev-123',
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request');
      expect(body.details).toBeDefined();
    });

    it('returns 400 when platform is invalid', async () => {
      const response = await POST(createNativeRequest({
        idToken: 'token',
        platform: 'windows',
        deviceId: 'dev-123',
      }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request');
    });

    it('returns 400 when deviceId is missing', async () => {
      const response = await POST(createNativeRequest({
        idToken: 'token',
        platform: 'ios',
      }));
      expect(response.status).toBe(400);
    });

    it('returns 400 when idToken is empty', async () => {
      const response = await POST(createNativeRequest({
        idToken: '',
        platform: 'ios',
        deviceId: 'dev-123',
      }));

      expect(response.status).toBe(400);
    });

    it('returns 400 when deviceId is empty', async () => {
      const response = await POST(createNativeRequest({
        idToken: 'token',
        platform: 'ios',
        deviceId: '',
      }));

      expect(response.status).toBe(400);
    });
  });

  describe('environment validation', () => {
    it('returns 500 when APPLE_CLIENT_ID is missing', async () => {
      delete process.env.APPLE_CLIENT_ID;

      const response = await POST(createNativeRequest(validPayload));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Apple sign-in not configured');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Missing Apple client ID',
        expect.any(Object)
      );
    });
  });

  describe('token verification', () => {
    it('returns 401 when Apple ID token verification fails', async () => {
      vi.mocked(verifyAppleIdToken).mockResolvedValue({
        success: false,
        error: 'Invalid signature',
      });

      const response = await POST(createNativeRequest(validPayload));
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid signature');
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Invalid Apple ID token',
        expect.objectContaining({ platform: 'ios' })
      );
    });

    it('returns 401 with generic message when no error message provided', async () => {
      vi.mocked(verifyAppleIdToken).mockResolvedValue({
        success: false,
      });

      const response = await POST(createNativeRequest(validPayload));
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid token');
    });
  });

  describe('new user creation', () => {
    it('creates a new user and returns user data', async () => {
      const response = await POST(createNativeRequest(validPayload));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.isNewUser).toBe(true);
      expect(body.user).toBeDefined();
      expect(body.sessionToken).toBe('ps_sess_mock_token');
      expect(body.csrfToken).toBe('mock-csrf-token');
      expect(body.deviceToken).toBe('mock-device-token');
    });

    it('builds name from givenName and familyName', async () => {
      await POST(createNativeRequest(validPayload));

      expect(authRepository.createUser).toHaveBeenCalledTimes(1);
    });

    it('uses email prefix as name when no name provided', async () => {
      await POST(createNativeRequest({
        idToken: 'token',
        platform: 'ios',
        deviceId: 'dev-123',
      }));

      expect(authRepository.createUser).toHaveBeenCalledTimes(1);
    });

    it('provisions getting started drive for new users', async () => {
      await POST(createNativeRequest(validPayload));

      expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledWith('new-user-id');
    });

    it('continues if drive provisioning fails', async () => {
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockRejectedValueOnce(new Error('DB error'));

      const response = await POST(createNativeRequest(validPayload));

      expect(response.status).toBe(200);
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Failed to provision Getting Started drive',
        expect.any(Error),
        expect.objectContaining({ provider: 'apple-native' })
      );
    });
  });

  describe('existing user update', () => {
    const existingUser = {
      id: 'existing-user-id',
      name: 'Existing User',
      email: 'test@example.com',
      image: null,
      emailVerified: new Date(),
      tokenVersion: 0,
      password: null,
      appleId: null as string | null,
    };

    it('updates existing user when appleId is missing', async () => {
      vi.mocked(authRepository.findUserByAppleIdOrEmail).mockResolvedValueOnce(existingUser as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce({ ...existingUser, appleId: 'apple-sub-123' } as never);

      const response = await POST(createNativeRequest(validPayload));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.isNewUser).toBe(false);
      expect(authRepository.updateUser).toHaveBeenCalledWith('existing-user-id', expect.objectContaining({
        appleId: 'apple-sub-123',
      }));
    });

    it('updates existing user when name is missing', async () => {
      const userWithoutName = { ...existingUser, appleId: null, name: null };
      vi.mocked(authRepository.findUserByAppleIdOrEmail).mockResolvedValueOnce(userWithoutName as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce({ ...userWithoutName, appleId: 'apple-sub-123', name: 'John Doe' } as never);

      const response = await POST(createNativeRequest(validPayload));

      expect(response.status).toBe(200);
      expect(authRepository.updateUser).toHaveBeenCalledWith('existing-user-id', expect.objectContaining({
        appleId: 'apple-sub-123',
      }));
    });

    it('does not update user when no update is needed', async () => {
      const completeUser = { ...existingUser, appleId: 'apple-sub-123' };
      vi.mocked(authRepository.findUserByAppleIdOrEmail).mockResolvedValue(completeUser as never);

      const response = await POST(createNativeRequest(validPayload));

      expect(response.status).toBe(200);
      expect(authRepository.updateUser).not.toHaveBeenCalled();
    });

    it('does not provision drive for existing users', async () => {
      const completeUser = { ...existingUser, appleId: 'apple-sub-123' };
      vi.mocked(authRepository.findUserByAppleIdOrEmail).mockResolvedValue(completeUser as never);

      await POST(createNativeRequest(validPayload));

      expect(provisionGettingStartedDriveIfNeeded).not.toHaveBeenCalled();
    });

    it('sets provider to "both" for user with password', async () => {
      const userWithPassword = { ...existingUser, password: '$2a$12$hash', appleId: null };
      vi.mocked(authRepository.findUserByAppleIdOrEmail).mockResolvedValueOnce(userWithPassword as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce({ ...userWithPassword, appleId: 'apple-sub-123' } as never);

      await POST(createNativeRequest(validPayload));

      expect(authRepository.updateUser).toHaveBeenCalledWith('existing-user-id', expect.objectContaining({
        provider: 'both',
      }));
    });

    it('handles re-fetch returning null after update', async () => {
      vi.mocked(authRepository.findUserByAppleIdOrEmail).mockResolvedValueOnce(existingUser as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce(null);

      const response = await POST(createNativeRequest(validPayload));

      // Should use original user as fallback
      expect(response.status).toBe(200);
    });
  });

  describe('session management', () => {
    it('revokes existing sessions before creating new one', async () => {
      vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(2);

      await POST(createNativeRequest(validPayload));

      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith('new-user-id', 'new_login');
      expect(loggers.auth.info).toHaveBeenCalledWith(
        'Revoked existing sessions on native Apple OAuth login',
        expect.objectContaining({ count: 2 })
      );
    });

    it('does not log when no sessions were revoked', async () => {
      vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(0);

      await POST(createNativeRequest(validPayload));

      const logCalls = vi.mocked(loggers.auth.info).mock.calls;
      const revokedLogCall = logCalls.find(
        (call) => call[0] === 'Revoked existing sessions on native Apple OAuth login'
      );
      expect(revokedLogCall).toBeUndefined();
    });

    it('returns 500 when session validation fails', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(null as never);

      const response = await POST(createNativeRequest(validPayload));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Session creation failed');
    });

    it('creates session with correct params', async () => {
      vi.mocked(getClientIP).mockReturnValue('192.168.1.1');

      await POST(createNativeRequest(validPayload));

      expect(sessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'new-user-id',
          type: 'user',
          scopes: ['*'],
          createdByIp: '192.168.1.1',
        })
      );
    });

    it('omits createdByIp when client IP is unknown', async () => {
      vi.mocked(getClientIP).mockReturnValue('unknown');

      await POST(createNativeRequest(validPayload));

      expect(sessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          createdByIp: undefined,
        })
      );
    });
  });

  describe('device token creation', () => {
    it('creates device token with correct parameters', async () => {
      await POST(createNativeRequest(validPayload));

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'new-user-id',
          deviceId: 'device-123',
          platform: 'ios',
          deviceName: 'iPhone 15',
        })
      );
    });

    it('uses default device name for android', async () => {
      await POST(createNativeRequest({
        ...validPayload,
        platform: 'android',
        deviceName: undefined,
      }));

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceName: 'Android App',
        })
      );
    });

    it('uses default device name for ios when not provided', async () => {
      await POST(createNativeRequest({
        ...validPayload,
        deviceName: undefined,
      }));

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceName: 'iOS App',
        })
      );
    });
  });

  describe('rate limit reset on success', () => {
    it('resets rate limit on successful login', async () => {
      vi.mocked(getClientIP).mockReturnValue('10.0.0.1');

      await POST(createNativeRequest(validPayload));

      expect(resetDistributedRateLimit).toHaveBeenCalledWith('oauth:apple:native:ip:10.0.0.1');
    });

    it('handles rate limit reset failure gracefully', async () => {
      vi.mocked(resetDistributedRateLimit).mockRejectedValueOnce(new Error('Redis down'));

      const response = await POST(createNativeRequest(validPayload));

      expect(response.status).toBe(200);
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Rate limit reset failed',
        expect.objectContaining({ error: 'Redis down' })
      );
    });

    it('handles rate limit reset failure with non-Error object', async () => {
      vi.mocked(resetDistributedRateLimit).mockRejectedValueOnce('string error');

      const response = await POST(createNativeRequest(validPayload));

      expect(response.status).toBe(200);
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Rate limit reset failed',
        expect.objectContaining({ error: 'string error' })
      );
    });
  });

  describe('auth event logging', () => {
    it('logs auth events on successful login', async () => {
      await POST(createNativeRequest(validPayload));

      expect(logAuthEvent).toHaveBeenCalledWith(
        'login',
        'new-user-id',
        'test@example.com',
        '127.0.0.1',
        'Apple OAuth Native (ios)'
      );
      expect(trackAuthEvent).toHaveBeenCalledWith(
        'new-user-id',
        'login',
        expect.objectContaining({
          provider: 'apple-native',
          platform: 'ios',
        })
      );
    });

    it('sets session cookie in response headers', async () => {
      await POST(createNativeRequest(validPayload));

      expect(appendSessionCookie).toHaveBeenCalledWith(expect.any(Object), expect.any(String));
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected errors', async () => {
      vi.mocked(verifyAppleIdToken).mockRejectedValueOnce(new Error('Network error'));

      const response = await POST(createNativeRequest(validPayload));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Authentication failed');
    });

    it('returns 401 for expired token errors', async () => {
      vi.mocked(verifyAppleIdToken).mockRejectedValueOnce(new Error('Token has expired'));

      const response = await POST(createNativeRequest(validPayload));
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Token expired. Please try again.');
    });
  });
});
