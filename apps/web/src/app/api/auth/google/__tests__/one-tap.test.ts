/**
 * Contract tests for POST /api/auth/google/one-tap
 *
 * These tests verify the Request → Response contract and boundary obligations.
 * Uses session-based authentication for web platform.
 *
 * Coverage:
 * - Authentication (valid/invalid Google credentials)
 * - Rate limiting (IP)
 * - User creation/update logic
 * - Session management (session-based auth with opaque tokens)
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

// Mock session service from @pagespace/lib/auth
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
}));

// Mock cookie utilities
vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
  appendClearCookies: vi.fn(),
  getSessionFromCookies: vi.fn().mockReturnValue('ps_sess_mock_session_token'),
}));

vi.mock('@pagespace/lib/server', () => ({
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

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-id'),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

import { db, users } from '@pagespace/db';
import { sessionService, generateCSRFToken } from '@pagespace/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { validateOrCreateDeviceToken } from '@pagespace/lib/server';
import { checkDistributedRateLimit, resetDistributedRateLimit } from '@pagespace/lib/security';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';

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

    it('should create session and set session cookie for web platform', async () => {
      const request = createOneTapRequest(validOneTapPayload);
      await POST(request);

      expect(sessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockNewUser.id,
          type: 'user',
          scopes: ['*'],
        })
      );
      expect(appendSessionCookie).toHaveBeenCalled();
    });

    it('should generate CSRF token bound to session', async () => {
      const request = createOneTapRequest(validOneTapPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(sessionService.validateSession).toHaveBeenCalledWith('ps_sess_mock_session_token');
      expect(generateCSRFToken).toHaveBeenCalledWith('mock-session-id');
      expect(body.csrfToken).toBe('mock-csrf-token');
    });

    it('should revoke existing sessions on login (session fixation prevention)', async () => {
      const request = createOneTapRequest(validOneTapPayload);
      await POST(request);

      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(mockNewUser.id, 'new_login');
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

    it('given desktop platform with deviceId, should return device token', async () => {
      (db.query.users.findFirst as Mock).mockResolvedValue(mockExistingUser);
      (provisionGettingStartedDriveIfNeeded as Mock).mockResolvedValue(null);
      (validateOrCreateDeviceToken as Mock).mockResolvedValue({
        deviceToken: 'desktop-device-token',
        deviceTokenRecordId: 'device-record-id',
      });

      const request = createOneTapRequest({
        credential: 'valid-token',
        platform: 'desktop',
        deviceId: 'desktop-device-123',
        deviceName: 'Desktop App',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.tokens.deviceToken).toBe('desktop-device-token');
      // Desktop should NOT have session cookie
      expect(appendSessionCookie).not.toHaveBeenCalled();
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
});
