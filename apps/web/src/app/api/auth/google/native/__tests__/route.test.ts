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

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';

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
    revokeSession: vi.fn().mockResolvedValue(undefined),
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
  provisionGettingStartedDriveIfNeeded: vi.fn().mockResolvedValue({ driveId: 'drive-123' }),
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
}));

import { db, users } from '@pagespace/db';
import { sessionService, generateCSRFToken } from '@pagespace/lib/auth';
import { validateOrCreateDeviceToken, logAuthEvent } from '@pagespace/lib/server';
import { checkDistributedRateLimit, resetDistributedRateLimit } from '@pagespace/lib/security';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { getClientIP } from '@/lib/auth';

const mockNewUser = {
  id: 'user-123',
  name: 'Test User',
  email: 'test@example.com',
  googleId: 'google-id-123',
  tokenVersion: 0,
  role: 'user',
  provider: 'google',
  password: null,
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
  password: null,
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
    (checkDistributedRateLimit as Mock).mockResolvedValue({ allowed: true, attemptsRemaining: 5 });
    (resetDistributedRateLimit as Mock).mockResolvedValue(undefined);

    // Default session mocks
    (sessionService.createSession as Mock).mockResolvedValue('ps_sess_mock_session_token');
    (sessionService.validateSession as Mock).mockResolvedValue({
      sessionId: 'mock-session-id',
      userId: 'user-123',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
    });
    (sessionService.revokeAllUserSessions as Mock).mockResolvedValue(0);
    (generateCSRFToken as Mock).mockReturnValue('mock-csrf-token');

    // Default device token mock
    (validateOrCreateDeviceToken as Mock).mockResolvedValue({
      deviceToken: 'mock-device-token',
      deviceTokenRecordId: 'device-record-id',
    });

    // Default provisioning mock
    (provisionGettingStartedDriveIfNeeded as Mock).mockResolvedValue({ driveId: 'drive-123' });

    // Default getClientIP mock
    (getClientIP as Mock).mockReturnValue('127.0.0.1');

    // Default to new user flow
    (db.query.users.findFirst as Mock).mockResolvedValue(null);

    (db.insert as Mock).mockImplementation((table: unknown) => {
      if (table === users) {
        return {
          values: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([mockNewUser])),
          })),
        };
      }
      return {
        values: vi.fn(() => Promise.resolve(undefined)),
      };
    });

    (db.update as Mock).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });
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
      (db.query.users.findFirst as Mock).mockResolvedValue(mockExistingUser);

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionToken).toBe('ps_sess_mock_session_token');
      expect(body.deviceToken).toBe('mock-device-token');
      expect(body.isNewUser).toBe(false);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('given new user, should provision Getting Started drive', async () => {
      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledWith(mockNewUser.id);
    });

    it('given existing user, should not provision Getting Started drive', async () => {
      (db.query.users.findFirst as Mock).mockResolvedValue(mockExistingUser);

      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(provisionGettingStartedDriveIfNeeded).not.toHaveBeenCalled();
    });

    it('should create session with correct parameters', async () => {
      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(sessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockNewUser.id,
          type: 'user',
          scopes: ['*'],
          expiresInMs: 7 * 24 * 60 * 60 * 1000,
          createdByIp: '127.0.0.1',
        })
      );
    });

    it('should create device token with platform info', async () => {
      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockNewUser.id,
          deviceId: 'device-123',
          platform: 'ios',
          deviceName: 'iPhone 15',
          tokenVersion: 0,
        })
      );
    });

    it('given deviceName not provided, should use default name based on platform', async () => {
      const payloadWithoutDeviceName = {
        idToken: 'valid-google-id-token',
        platform: 'ios',
        deviceId: 'device-123',
      };

      const request = createNativeRequest(payloadWithoutDeviceName);
      await POST(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceName: 'iOS App',
        })
      );
    });

    it('given android platform, should use Android default name', async () => {
      const androidPayload = {
        idToken: 'valid-google-id-token',
        platform: 'android',
        deviceId: 'device-123',
      };

      const request = createNativeRequest(androidPayload);
      await POST(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceName: 'Android App',
        })
      );
    });

    it('should reset rate limit on successful auth', async () => {
      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(resetDistributedRateLimit).toHaveBeenCalledWith('oauth:native:ip:127.0.0.1');
    });

    it('should log auth events on successful login', async () => {
      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(logAuthEvent).toHaveBeenCalledWith(
        'login',
        mockNewUser.id,
        'test@example.com',
        '127.0.0.1',
        'Google OAuth Native (ios)'
      );

      expect(trackAuthEvent).toHaveBeenCalledWith(
        mockNewUser.id,
        'login',
        expect.objectContaining({
          provider: 'google-native',
          platform: 'ios',
        })
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
      expect(body.details.idToken).toBeDefined();
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
      expect(body.details.deviceId).toBeDefined();
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
      expect(body.details.platform).toBeDefined();
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
      expect(body.error).toContain('expired');
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
      (checkDistributedRateLimit as Mock).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: 900,
      });

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many login attempts');
      expect(body.retryAfter).toBe(900);
    });

    it('given rate limit exceeded, should include Retry-After header', async () => {
      (checkDistributedRateLimit as Mock).mockResolvedValue({
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
      (sessionService.revokeAllUserSessions as Mock).mockResolvedValue(2);

      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(
        mockNewUser.id,
        'new_login'
      );
    });

    it('given session validation fails, should return 500', async () => {
      (sessionService.validateSession as Mock).mockResolvedValue(null);

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
      expect(body.error).toContain('not configured');
    });

    it('given missing GOOGLE_OAUTH_IOS_CLIENT_ID, should return 500', async () => {
      delete process.env.GOOGLE_OAUTH_IOS_CLIENT_ID;

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('not configured');
    });
  });

  describe('error handling', () => {
    it('given unexpected error, should return 500', async () => {
      (db.query.users.findFirst as Mock).mockRejectedValue(new Error('Database error'));

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Authentication failed');
    });

    it('given provisioning error, should still succeed', async () => {
      (provisionGettingStartedDriveIfNeeded as Mock).mockRejectedValue(
        new Error('Provisioning failed')
      );

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionToken).toBeDefined();
    });

    it('given rate limit reset fails, should still succeed', async () => {
      (resetDistributedRateLimit as Mock).mockRejectedValue(new Error('Redis error'));

      const request = createNativeRequest(validNativePayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionToken).toBeDefined();
    });
  });

  describe('user update scenarios', () => {
    it('given existing user without googleId, should update with googleId', async () => {
      const userWithoutGoogleId = { ...mockExistingUser, googleId: null };
      (db.query.users.findFirst as Mock)
        .mockResolvedValueOnce(userWithoutGoogleId)
        .mockResolvedValueOnce(mockExistingUser);

      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(db.update).toHaveBeenCalled();
    });

    it('given existing user with password, should set provider to both', async () => {
      const userWithPassword = { ...mockExistingUser, googleId: null, password: 'hashed-pw' };
      (db.query.users.findFirst as Mock)
        .mockResolvedValueOnce(userWithPassword)
        .mockResolvedValueOnce({ ...userWithPassword, provider: 'both', googleId: 'google-id-123' });

      const request = createNativeRequest(validNativePayload);
      await POST(request);

      expect(db.update).toHaveBeenCalled();
    });
  });
});
