/**
 * Contract tests for POST /api/auth/google/native
 *
 * Tests the native Google Sign-In endpoint for iOS/Android apps.
 * Verifies the Request → Response contract and boundary obligations.
 *
 * Coverage:
 * - Authentication (valid/invalid Google ID tokens)
 * - Rate limiting (IP-based)
 * - User creation/update logic
 * - Session management with session fixation prevention
 * - Device token creation
 * - Input validation
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

import { POST } from '../route';

vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    findUserByGoogleIdOrEmail: vi.fn(),
    findUserById: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/auth/session-service', () => ({
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
    revokeSession: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('@pagespace/lib/auth/csrf-utils', () => ({
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
}));
vi.mock('@pagespace/lib/auth/constants', () => ({
  SESSION_DURATION_MS: 7 * 24 * 60 * 60 * 1000,
}));

vi.mock('@pagespace/lib/auth/device-auth-utils', () => ({
  validateOrCreateDeviceToken: vi.fn().mockResolvedValue({
      deviceToken: 'mock-device-token',
      deviceTokenRecordId: 'device-record-id',
    }),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
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
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
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

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-user-id'),
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn().mockResolvedValue({ driveId: 'drive-123', created: true }),
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

import { authRepository } from '@/lib/repositories/auth-repository';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { generateCSRFToken } from '@pagespace/lib/auth/csrf-utils';
import { validateOrCreateDeviceToken } from '@pagespace/lib/auth/device-auth-utils';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { checkDistributedRateLimit, resetDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { trackAuthEvent } from '@pagespace/lib/monitoring/activity-tracker';
import { getClientIP } from '@/lib/auth';
import { resolveGoogleAvatarImage } from '@/lib/auth/google-avatar';

const mockNewUser = {
  id: 'user-123',
  name: 'Test User',
  email: 'test@example.com',
  googleId: 'google-id-123',
  tokenVersion: 0,
  role: 'user',
  provider: 'google',
  image: 'https://example.com/avatar.png',
};

const mockExistingUser = {
  id: 'existing-user-456',
  name: 'Existing User',
  email: 'test@example.com',
  googleId: 'google-id-123',
  tokenVersion: 1,
  role: 'user',
  provider: 'google',
  image: 'https://example.com/old-avatar.png',
};

const validNativePayload = {
  idToken: 'valid-google-id-token',
  platform: 'ios',
  deviceId: 'device-123',
  deviceName: 'iPhone 15',
};

const createNativeRequest = (
  payload: Record<string, unknown>,
  additionalHeaders: Record<string, string> = {}
) => {
  return new Request('http://localhost/api/auth/google/native', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'PageSpace-iOS/1.0',
      ...additionalHeaders,
    },
    body: JSON.stringify(payload),
  });
};

describe('POST /api/auth/google/native', () => {
  const originalEnv = {
    GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_IOS_CLIENT_ID: process.env.GOOGLE_OAUTH_IOS_CLIENT_ID,
  };

  beforeEach(() => {
    vi.resetAllMocks();

    // Set up required env vars
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-web-client-id';
    process.env.GOOGLE_OAUTH_IOS_CLIENT_ID = 'test-ios-client-id';

    // Reset Google token verification mock to default successful behavior
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

    // Default device token mock
    vi.mocked(validateOrCreateDeviceToken).mockResolvedValue({
      deviceToken: 'mock-device-token',
      deviceTokenRecordId: 'device-record-id',
    } as never);

    // Default provisioning mock
    vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValue({ driveId: 'drive-123', created: true });

    // Default getClientIP mock
    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');

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
    process.env.GOOGLE_OAUTH_IOS_CLIENT_ID = originalEnv.GOOGLE_OAUTH_IOS_CLIENT_ID;
  });

  describe('successful authentication', () => {
    it('given valid idToken for new user, should create user and return tokens', async () => {
      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionToken).toBe('ps_sess_mock_session_token');
      expect(body.csrfToken).toBe('mock-csrf-token');
      expect(body.deviceToken).toBe('mock-device-token');
      expect(body.isNewUser).toBe(true);
    });

    it('given valid idToken for existing user, should return tokens without creating user', async () => {
      vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValue(mockExistingUser as never);

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionToken).toBe('ps_sess_mock_session_token');
      expect(body.deviceToken).toBe('mock-device-token');
      expect(body.isNewUser).toBe(false);
      expect(authRepository.createUser).not.toHaveBeenCalled();
    });

    it('given new user, should provision Getting Started drive', async () => {
      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledWith(mockNewUser.id);
    });

    it('given existing user, should not provision Getting Started drive', async () => {
      vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValue(mockExistingUser as never);

      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(provisionGettingStartedDriveIfNeeded).not.toHaveBeenCalled();
    });

    it('should create session with correct parameters', async () => {
      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(sessionService.createSession).toHaveBeenCalledWith({
        userId: mockNewUser.id,
        type: 'user',
        scopes: ['*'],
        expiresInMs: 7 * 24 * 60 * 60 * 1000,
        deviceId: 'device-123',
        createdByIp: '127.0.0.1',
      });
    });

    it('should create device token with platform info', async () => {
      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith({
        providedDeviceToken: undefined,
        userId: mockNewUser.id,
        deviceId: 'device-123',
        platform: 'ios',
        tokenVersion: 0,
        deviceName: 'iPhone 15',
        userAgent: 'PageSpace-iOS/1.0',
        ipAddress: '127.0.0.1',
      });
    });

    it('given deviceName not provided, should use default name based on platform', async () => {
      const payloadWithoutDeviceName = {
        idToken: 'valid-google-id-token',
        platform: 'ios',
        deviceId: 'device-123',
      };

      const request = createNativeRequest(payloadWithoutDeviceName);
      await POST(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith({
        providedDeviceToken: undefined,
        userId: mockNewUser.id,
        deviceId: 'device-123',
        platform: 'ios',
        tokenVersion: 0,
        deviceName: 'iOS App',
        userAgent: 'PageSpace-iOS/1.0',
        ipAddress: '127.0.0.1',
      });
    });

    it('given android platform, should use Android default name', async () => {
      const androidPayload = {
        idToken: 'valid-google-id-token',
        platform: 'android',
        deviceId: 'device-123',
      };

      const request = createNativeRequest(androidPayload);
      await POST(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith({
        providedDeviceToken: undefined,
        userId: mockNewUser.id,
        deviceId: 'device-123',
        platform: 'android',
        tokenVersion: 0,
        deviceName: 'Android App',
        userAgent: 'PageSpace-iOS/1.0',
        ipAddress: '127.0.0.1',
      });
    });

    it('should reset rate limit on successful auth', async () => {
      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(resetDistributedRateLimit).toHaveBeenCalledWith('oauth:native:ip:127.0.0.1');
    });

    it('should log auth events on successful login', async () => {
      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'auth.login.success',
          userId: mockNewUser.id,
          sessionId: 'mock-session-id',
          details: { method: 'Google OAuth Native (ios)' },
        })
      );

      expect(trackAuthEvent).toHaveBeenCalledWith(
        mockNewUser.id,
        'login',
        {
          email: 'test@example.com',
          ip: '127.0.0.1',
          provider: 'google-native',
          platform: 'ios',
          userAgent: 'PageSpace-iOS/1.0',
        }
      );
    });
  });

  describe('input validation', () => {
    it('given missing idToken, should return 400', async () => {
      const request = createNativeRequest({
        platform: 'ios',
        deviceId: 'device-123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request');
      expect(body.details.idToken).toEqual(['Invalid input: expected string, received undefined']);
    });

    it('given empty idToken, should return 400', async () => {
      const request = createNativeRequest({
        idToken: '',
        platform: 'ios',
        deviceId: 'device-123',
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('given missing deviceId, should return 400', async () => {
      const request = createNativeRequest({
        idToken: 'valid-token',
        platform: 'ios',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.details.deviceId).toEqual(['Invalid input: expected string, received undefined']);
    });

    it('given empty deviceId, should return 400', async () => {
      const request = createNativeRequest({
        idToken: 'valid-token',
        platform: 'ios',
        deviceId: '',
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('given invalid platform, should return 400', async () => {
      const request = createNativeRequest({
        idToken: 'valid-token',
        platform: 'web',
        deviceId: 'device-123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.details.platform).toEqual(['Invalid option: expected one of "ios"|"android"']);
    });

    it('given missing platform, should return 400', async () => {
      const request = createNativeRequest({
        idToken: 'valid-token',
        deviceId: 'device-123',
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });
  });

  describe('token verification', () => {
    it('given invalid Google ID token, should return 500', async () => {
      mockVerifyIdToken.mockRejectedValueOnce(new Error('Invalid token'));

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);

      expect(response.status).toBe(500);
    });

    it('given expired token, should return 401 with specific message', async () => {
      mockVerifyIdToken.mockRejectedValueOnce(new Error('Token used too late'));

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Token expired. Please try again.');
    });

    it('given token without email, should return 401', async () => {
      mockVerifyIdToken.mockResolvedValueOnce({
        getPayload: () => ({
          sub: 'google-id-123',
          name: 'Test User',
        }),
      });

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid token');
    });
  });

  describe('rate limiting', () => {
    it('given rate limit exceeded, should return 429', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: 900,
      });

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toBe('Too many login attempts. Please try again later.');
      expect(body.retryAfter).toBe(900);
    });

    it('given rate limit exceeded, should include Retry-After header', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: 900,
      });

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);

      expect(response.headers.get('Retry-After')).toBe('900');
    });
  });

  describe('session management', () => {
    it('should revoke existing sessions before creating new one (session fixation prevention)', async () => {
      vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValue(2);

      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(
        mockNewUser.id,
        'new_login'
      );
    });

    it('given session validation fails, should return 500', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(null);

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Session creation failed');
    });

    it('should generate CSRF token bound to session', async () => {
      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(sessionService.validateSession).toHaveBeenCalledWith('ps_sess_mock_session_token');
      expect(generateCSRFToken).toHaveBeenCalledWith('mock-session-id');
    });
  });

  describe('environment configuration', () => {
    it('given missing GOOGLE_OAUTH_CLIENT_ID, should return 500', async () => {
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Google sign-in not configured');
    });

    it('given missing GOOGLE_OAUTH_IOS_CLIENT_ID, should return 500', async () => {
      delete process.env.GOOGLE_OAUTH_IOS_CLIENT_ID;

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Google sign-in not configured');
    });
  });

  describe('error handling', () => {
    it('given unexpected error, should return 500', async () => {
      vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockRejectedValueOnce(new Error('Database error'));

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Authentication failed');
    });

    it('given provisioning error, should still succeed', async () => {
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockRejectedValueOnce(
        new Error('Provisioning failed')
      );

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionToken).toBe('ps_sess_mock_session_token');
    });

    it('given rate limit reset fails, should still succeed', async () => {
      vi.mocked(resetDistributedRateLimit).mockRejectedValueOnce(new Error('Redis error'));

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionToken).toBe('ps_sess_mock_session_token');
    });
  });

  describe('user update scenarios', () => {
    it('given existing user without googleId, should update with googleId', async () => {
      const userWithoutGoogleId = { ...mockExistingUser, googleId: null };
      vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValueOnce(userWithoutGoogleId as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce(mockExistingUser as never);

      const request = createNativeRequest(validNativePayload);
      await POST(request);

      const updateArgs = vi.mocked(authRepository.updateUser).mock.calls[0];
      expect(updateArgs[0]).toBe(userWithoutGoogleId.id);
      expect((updateArgs[1] as Record<string, unknown>).googleId).toBe('google-id-123');
    });

    it('given existing user without name, should set name from Google payload', async () => {
      const userWithoutName = { ...mockExistingUser, googleId: null, name: null };
      vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValueOnce(userWithoutName as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce({ ...userWithoutName, name: 'Test User', googleId: 'google-id-123' } as never);

      const request = createNativeRequest(validNativePayload);
      await POST(request);

      const updateArgs = vi.mocked(authRepository.updateUser).mock.calls[0];
      expect(updateArgs[0]).toBe(userWithoutName.id);
      expect((updateArgs[1] as Record<string, unknown>).name).toBe('Test User');
    });

    it('given existing user with different avatar, should update image', async () => {
      const userWithOldAvatar = { ...mockExistingUser, image: '/old-avatar.jpg' };
      vi.mocked(resolveGoogleAvatarImage).mockResolvedValue('/new-avatar.jpg');
      vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValueOnce(userWithOldAvatar as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce({ ...userWithOldAvatar, image: '/new-avatar.jpg' } as never);

      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(authRepository.updateUser).toHaveBeenCalledTimes(1);
      expect(vi.mocked(authRepository.updateUser).mock.calls[0][0]).toBe(userWithOldAvatar.id);
      expect((vi.mocked(authRepository.updateUser).mock.calls[0][1] as Record<string, unknown>).image).toBe('/new-avatar.jpg');
    });

    it('given existing user with unverified email and email_verified token, should update emailVerified', async () => {
      const userUnverified = { ...mockExistingUser, emailVerified: null };
      vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValueOnce(userUnverified as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce({ ...userUnverified, emailVerified: new Date() } as never);

      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(authRepository.updateUser).toHaveBeenCalledTimes(1);
      const updateArgs = vi.mocked(authRepository.updateUser).mock.calls[0];
      expect(updateArgs[0]).toBe(userUnverified.id);
      expect(updateArgs[1]).toHaveProperty('emailVerified');
      expect((updateArgs[1] as Record<string, unknown>).emailVerified).toBeInstanceOf(Date);
    });

    it('given existing user where no updates needed, should NOT call updateUser', async () => {
      // User has all fields set correctly
      const fullyUpdatedUser = {
        ...mockExistingUser,
        googleId: 'google-id-123',
        name: 'Existing User',
        image: null, // resolveGoogleAvatarImage returns null by default
        emailVerified: new Date(),
      };
      vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValue(fullyUpdatedUser as never);

      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(authRepository.updateUser).not.toHaveBeenCalled();
    });

    it('given new user where resolvedImage differs from initial null, should update avatar', async () => {
      vi.mocked(resolveGoogleAvatarImage).mockResolvedValue('/processed-avatar.jpg');

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      // updateUser should be called to set the resolved image
      const updateArgs = vi.mocked(authRepository.updateUser).mock.calls[0];
      expect(updateArgs[0]).toBe(mockNewUser.id);
      expect((updateArgs[1] as Record<string, unknown>).image).toBe('/processed-avatar.jpg');
    });

  });

  describe('PII scrub in log metadata', () => {
    const findInfoCall = (msg: string) =>
      vi.mocked(loggers.auth.info).mock.calls.find(call => call[0] === msg);

    it('masks email in "Creating new user via native Google OAuth" log', async () => {
      vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValue(null);
      vi.mocked(authRepository.createUser).mockResolvedValue(mockNewUser as never);

      const request = createNativeRequest(validNativePayload);
      await POST(request);

      const call = findInfoCall('Creating new user via native Google OAuth');
      expect(call).toBeDefined();
      const meta = call?.[1] as { email?: string };
      expect(meta.email).toBe('te***@example.com');
    });

    it('masks email in "Updating existing user via native Google OAuth" log', async () => {
      const userWithoutGoogleId = { ...mockExistingUser, googleId: null };
      vi.mocked(authRepository.findUserByGoogleIdOrEmail).mockResolvedValueOnce(userWithoutGoogleId as never);
      vi.mocked(authRepository.findUserById).mockResolvedValueOnce(mockExistingUser as never);

      const request = createNativeRequest(validNativePayload);
      await POST(request);

      const call = findInfoCall('Updating existing user via native Google OAuth');
      expect(call).toBeDefined();
      const meta = call?.[1] as { email?: string };
      expect(meta.email).toBe('te***@example.com');
    });
  });
});
