/**
 * Contract tests for GET /api/auth/google/callback
 *
 * These tests verify session-based authentication in OAuth callback flow.
 * Uses session-based auth with opaque tokens for web platform.
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
}));

// Mock cookie utilities
vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
  appendClearCookies: vi.fn(),
  getSessionFromCookies: vi.fn().mockReturnValue('ps_sess_mock_session_token'),
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

import { db } from '@pagespace/db';
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
    (checkDistributedRateLimit as Mock).mockResolvedValue({ allowed: true, attemptsRemaining: 5 });
    (provisionGettingStartedDriveIfNeeded as Mock).mockResolvedValue(null);

    // Default to existing user
    (db.query.users.findFirst as Mock).mockResolvedValue(mockExistingUser);

    (db.insert as Mock).mockImplementation(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([mockExistingUser])),
      })),
    }));

    (db.update as Mock).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('session-based authentication', () => {
    it('given successful OAuth, should create session and redirect with CSRF token', async () => {
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
      expect(sessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockExistingUser.id,
          type: 'user',
          scopes: ['*'],
        })
      );

      // Verify session cookie is set
      expect(appendSessionCookie).toHaveBeenCalled();

      // Response should be a redirect
      expect(response.status).toBe(307);

      const location = response.headers.get('location');
      expect(location).toBeTruthy();
      expect(location).toContain('csrfToken=mock-csrf-token');
      expect(location).toContain('auth=success');
    });

    it('should revoke existing sessions on login (session fixation prevention)', async () => {
      const state = createSignedState({
        platform: 'web',
        returnUrl: '/dashboard',
      });

      const request = createCallbackRequest({
        code: 'valid-auth-code',
        state,
      });

      await GET(request);

      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(
        mockExistingUser.id,
        'new_login'
      );
    });

    it('given provisioned drive, should redirect to that drive', async () => {
      (provisionGettingStartedDriveIfNeeded as Mock).mockResolvedValue({
        driveId: 'new-drive-123',
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
      const location = response.headers.get('location');
      expect(location).toBeTruthy();
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
      (checkDistributedRateLimit as Mock).mockResolvedValue({
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
