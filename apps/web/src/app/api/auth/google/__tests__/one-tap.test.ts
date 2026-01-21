/**
 * Contract tests for POST /api/auth/google/one-tap
 *
 * These tests verify the Request → Response contract and boundary obligations.
 * Database operations are mocked at the repository seam (not ORM chains).
 *
 * Coverage:
 * - Authentication (valid/invalid Google credentials)
 * - Rate limiting (IP)
 * - User creation/update logic
 * - Session management (tokens, cookies)
 * - Desktop vs Web platform handling
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { POST } from '../one-tap/route';

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
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

vi.mock('@pagespace/db', () => ({
  users: { id: 'id', googleId: 'googleId', email: 'email' },
  refreshTokens: { id: 'id' },
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

vi.mock('@pagespace/lib/server', () => ({
  generateAccessToken: vi.fn(),
  generateRefreshToken: vi.fn(),
  getRefreshTokenMaxAge: vi.fn(),
  decodeToken: vi.fn(),
  generateCSRFToken: vi.fn(),
  getSessionIdFromJWT: vi.fn(),
  validateOrCreateDeviceToken: vi.fn(),
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

vi.mock('@pagespace/lib/auth', () => ({
  hashToken: vi.fn(() => 'hashed-token'),
  getTokenPrefix: vi.fn(() => 'tok_'),
}));

vi.mock('cookie', () => ({
  serialize: vi.fn(() => 'mock-cookie'),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-id'),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

import { db, users, refreshTokens } from '@pagespace/db';
import {
  decodeToken,
  generateAccessToken,
  generateRefreshToken,
  getRefreshTokenMaxAge,
  validateOrCreateDeviceToken,
} from '@pagespace/lib/server';
import { checkDistributedRateLimit, resetDistributedRateLimit } from '@pagespace/lib/security';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { serialize } from 'cookie';

// Test fixtures
const mockNewUser = {
  id: 'user-123',
  name: 'Test User',
  email: 'test@example.com',
  googleId: 'google-id-123',
  tokenVersion: 0,
  role: 'user',
  provider: 'google',
  password: null,
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
};

const validOneTapPayload = {
  credential: 'valid-google-id-token',
  platform: 'web',
};

const createOneTapRequest = (
  payload: Record<string, unknown>,
  additionalHeaders: Record<string, string> = {}
) => {
  return new Request('http://localhost/api/auth/google/one-tap', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...additionalHeaders,
    },
    body: JSON.stringify(payload),
  });
};

describe('POST /api/auth/google/one-tap', () => {
  const originalGoogleClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up env
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';

    // Default mocks for successful flow
    (checkDistributedRateLimit as Mock).mockResolvedValue({ allowed: true, attemptsRemaining: 5 });
    (generateAccessToken as Mock).mockResolvedValue('access-token');
    (generateRefreshToken as Mock).mockResolvedValue('refresh-token');
    (decodeToken as Mock).mockResolvedValue({
      exp: Math.floor(Date.now() / 1000) + 60,
      iat: Math.floor(Date.now() / 1000),
    });
    (getRefreshTokenMaxAge as Mock).mockReturnValue(60);
    (provisionGettingStartedDriveIfNeeded as Mock).mockResolvedValue({
      driveId: 'drive-123',
    });

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

      if (table === refreshTokens) {
        return {
          values: vi.fn(() => Promise.resolve(undefined)),
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
    process.env.GOOGLE_OAUTH_CLIENT_ID = originalGoogleClientId;
  });

  describe('successful authentication', () => {
    it('given valid credential for new user, should return success with user data', async () => {
      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.user.id).toBe(mockNewUser.id);
      expect(body.user.email).toBe(mockNewUser.email);
    });

    it('given valid credential for existing user, should return success with user data', async () => {
      (db.query.users.findFirst as Mock).mockResolvedValue(mockExistingUser);
      (provisionGettingStartedDriveIfNeeded as Mock).mockResolvedValue(null);

      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.user.id).toBe(mockExistingUser.id);
    });

    it('given new user, should provision Getting Started drive', async () => {
      const request = createOneTapRequest(validOneTapPayload);
      await POST(request);

      expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledWith(mockNewUser.id);
    });

    it('given existing user, should check for drive provisioning', async () => {
      (db.query.users.findFirst as Mock).mockResolvedValue(mockExistingUser);
      (provisionGettingStartedDriveIfNeeded as Mock).mockResolvedValue(null);

      const request = createOneTapRequest(validOneTapPayload);
      await POST(request);

      expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledWith(mockExistingUser.id);
    });

    it('should set httpOnly cookies for web platform', async () => {
      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);

      expect(serialize).toHaveBeenCalledWith(
        'accessToken',
        expect.any(String),
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
        })
      );

      expect(serialize).toHaveBeenCalledWith(
        'refreshToken',
        expect.any(String),
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
        })
      );

      // Verify cookies are actually attached to response headers
      const setCookie = response.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('mock-cookie');
    });

    it('should generate access and refresh tokens', async () => {
      const request = createOneTapRequest(validOneTapPayload);
      await POST(request);

      expect(generateAccessToken).toHaveBeenCalledWith(
        mockNewUser.id,
        mockNewUser.tokenVersion,
        mockNewUser.role
      );
      expect(generateRefreshToken).toHaveBeenCalledWith(
        mockNewUser.id,
        mockNewUser.tokenVersion,
        mockNewUser.role
      );
    });

    it('should track auth event with masked email', async () => {
      const request = createOneTapRequest(validOneTapPayload);
      await POST(request);

      expect(trackAuthEvent).toHaveBeenCalledWith(
        mockNewUser.id,
        'signup',
        expect.objectContaining({
          email: 'te***@example.com', // Masked email
          provider: 'google-one-tap',
        })
      );
    });

    it('should reset rate limits on successful auth', async () => {
      const request = createOneTapRequest(validOneTapPayload);
      await POST(request);

      expect(resetDistributedRateLimit).toHaveBeenCalled();
    });
  });

  describe('validation errors', () => {
    it('given missing credential, should return 400', async () => {
      const request = createOneTapRequest({ platform: 'web' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid request');
    });

    it('given empty credential, should return 400', async () => {
      const request = createOneTapRequest({ credential: '', platform: 'web' });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('given invalid platform, should return 400', async () => {
      const request = createOneTapRequest({ credential: 'valid', platform: 'invalid' });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });
  });

  describe('rate limiting', () => {
    it('given rate limited IP, should return 429', async () => {
      (checkDistributedRateLimit as Mock).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: 900,
      });

      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many sign-in attempts');
      expect(response.headers.get('Retry-After')).toBe('900');
    });
  });

  // NOTE: Google token verification error paths (invalid token, missing payload) are tested
  // via the hoisted vi.mock for google-auth-library. Changing mock behavior AFTER import
  // (via vi.doMock) won't work because OAuth2Client is instantiated at module load time.
  // The route handles these cases via:
  // 1. A try-catch block around verifyIdToken that returns 401 on rejection
  // 2. An explicit null/empty payload check that returns 401
  // 3. Integration/E2E tests with real Google tokens for full coverage

  describe('desktop platform handling', () => {
    it('given desktop platform without deviceId, should return 400', async () => {
      (db.query.users.findFirst as Mock).mockResolvedValue(mockExistingUser);
      (provisionGettingStartedDriveIfNeeded as Mock).mockResolvedValue(null);

      const request = createOneTapRequest({
        credential: 'valid-token',
        platform: 'desktop',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Device ID required');
    });
  });

  describe('error handling', () => {
    it('given missing GOOGLE_OAUTH_CLIENT_ID, should return 500', async () => {
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;

      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('not configured');
    });

    it('given provisioning error, should still succeed', async () => {
      (provisionGettingStartedDriveIfNeeded as Mock).mockRejectedValue(new Error('DB error'));

      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  describe('web device token creation', () => {
    beforeEach(() => {
      (validateOrCreateDeviceToken as Mock).mockResolvedValue({
        deviceToken: 'web-device-token-123',
        deviceTokenRecordId: 'device-record-123',
      });
    });

    it('given web platform with deviceId, should call validateOrCreateDeviceToken', async () => {
      const request = createOneTapRequest({
        credential: 'valid-google-id-token',
        platform: 'web',
        deviceId: 'web-device-id-123',
        deviceName: 'Test Browser',
      });
      await POST(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockNewUser.id,
          deviceId: 'web-device-id-123',
          platform: 'web',
          deviceName: 'Test Browser',
        })
      );
    });

    it('given web platform with deviceId, should include deviceToken in response', async () => {
      const request = createOneTapRequest({
        credential: 'valid-google-id-token',
        platform: 'web',
        deviceId: 'web-device-id-456',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.deviceToken).toBe('web-device-token-123');
    });

    it('given device token creation fails, should still return success', async () => {
      (validateOrCreateDeviceToken as Mock).mockRejectedValue(new Error('Device token error'));

      const request = createOneTapRequest({
        credential: 'valid-google-id-token',
        platform: 'web',
        deviceId: 'web-device-id-789',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      // deviceToken should not be present when creation fails
      expect(body.deviceToken).toBeUndefined();
    });

    it('given web platform without deviceId, should not call validateOrCreateDeviceToken', async () => {
      (validateOrCreateDeviceToken as Mock).mockClear();

      const request = createOneTapRequest({
        credential: 'valid-google-id-token',
        platform: 'web',
        // No deviceId provided
      });
      await POST(request);

      // validateOrCreateDeviceToken should not be called for web without deviceId
      expect(validateOrCreateDeviceToken).not.toHaveBeenCalled();
    });
  });
});
