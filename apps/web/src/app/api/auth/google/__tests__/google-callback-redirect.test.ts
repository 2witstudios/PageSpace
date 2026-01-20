/**
 * Contract tests for GET /api/auth/google/callback
 *
 * These tests verify the web device token creation in OAuth callback flow.
 * Focus: Device token integration for web platform persistence.
 */

import { describe, it, expect, beforeEach, vi, afterEach, type Mock } from 'vitest';
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
  and: vi.fn((...conditions: unknown[]) => conditions),
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

import { db, refreshTokens } from '@pagespace/db';
import {
  decodeToken,
  generateAccessToken,
  generateRefreshToken,
  getRefreshTokenMaxAge,
  validateOrCreateDeviceToken,
} from '@pagespace/lib/server';
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
    (checkDistributedRateLimit as Mock).mockResolvedValue({ allowed: true, attemptsRemaining: 5 });
    (generateAccessToken as Mock).mockResolvedValue('access-token');
    (generateRefreshToken as Mock).mockResolvedValue('refresh-token');
    (decodeToken as Mock).mockResolvedValue({
      exp: Math.floor(Date.now() / 1000) + 60,
      iat: Math.floor(Date.now() / 1000),
    });
    (getRefreshTokenMaxAge as Mock).mockReturnValue(60);
    (provisionGettingStartedDriveIfNeeded as Mock).mockResolvedValue(null);
    (validateOrCreateDeviceToken as Mock).mockResolvedValue({
      deviceToken: 'web-device-token-callback',
      deviceTokenRecordId: 'device-record-callback',
    });

    // Default to existing user
    (db.query.users.findFirst as Mock).mockResolvedValue(mockExistingUser);

    (db.insert as Mock).mockImplementation((table: unknown) => {
      if (table === refreshTokens) {
        return {
          values: vi.fn(() => Promise.resolve(undefined)),
        };
      }
      return {
        values: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([mockExistingUser])),
        })),
      };
    });

    (db.update as Mock).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('web device token creation', () => {
    it('given web platform with deviceId in state, should create device token', async () => {
      const state = createSignedState({
        platform: 'web',
        deviceId: 'web-device-id-callback',
        deviceName: 'Test Browser',
        returnUrl: '/dashboard',
      });

      const request = createCallbackRequest({
        code: 'valid-auth-code',
        state,
      });

      await GET(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockExistingUser.id,
          deviceId: 'web-device-id-callback',
          platform: 'web',
        })
      );
    });

    it('given device token created, should include deviceToken in redirect URL', async () => {
      const state = createSignedState({
        platform: 'web',
        deviceId: 'web-device-id-callback',
        returnUrl: '/dashboard',
      });

      const request = createCallbackRequest({
        code: 'valid-auth-code',
        state,
      });

      const response = await GET(request);

      // Response should be a redirect
      expect(response.status).toBe(307);

      const location = response.headers.get('location');
      expect(location).toBeTruthy();
      expect(location).toContain('deviceToken=web-device-token-callback');
    });

    it('given device token creation fails, should still redirect successfully', async () => {
      (validateOrCreateDeviceToken as Mock).mockRejectedValue(new Error('Device token error'));

      const state = createSignedState({
        platform: 'web',
        deviceId: 'web-device-id-failing',
        returnUrl: '/dashboard',
      });

      const request = createCallbackRequest({
        code: 'valid-auth-code',
        state,
      });

      const response = await GET(request);

      // Should still redirect (not error out)
      expect(response.status).toBe(307);

      const location = response.headers.get('location');
      expect(location).toBeTruthy();
      // deviceToken should NOT be in URL when creation fails
      expect(location).not.toContain('deviceToken=');
      // But auth=success should still be there
      expect(location).toContain('auth=success');
    });

    it('given web platform without deviceId, should not create device token', async () => {
      (validateOrCreateDeviceToken as Mock).mockClear();

      const state = createSignedState({
        platform: 'web',
        // No deviceId
        returnUrl: '/dashboard',
      });

      const request = createCallbackRequest({
        code: 'valid-auth-code',
        state,
      });

      await GET(request);

      // validateOrCreateDeviceToken should not be called for web without deviceId
      expect(validateOrCreateDeviceToken).not.toHaveBeenCalled();
    });
  });
});
