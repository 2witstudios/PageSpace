/**
 * Security tests for open redirect protection in Google OAuth flow.
 *
 * These tests verify that returnUrl is validated to prevent attackers from
 * redirecting OAuth callbacks to external domains.
 */

import { describe, it, expect, beforeEach, vi, afterEach, type Mock } from 'vitest';
import { POST } from '../signin/route';
import { GET } from '../callback/route';

// Mock dependencies for signin
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
  checkDistributedRateLimit: vi.fn().mockResolvedValue({ allowed: true, attemptsRemaining: 5 }),
  resetDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: {
    LOGIN: { maxAttempts: 5, windowMs: 900000, blockDurationMs: 900000, progressiveDelay: true },
    REFRESH: { maxAttempts: 10, windowMs: 60000 },
  },
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    getToken: vi.fn().mockResolvedValue({
      tokens: { id_token: 'valid-id-token', access_token: 'access-token' },
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
  db: {
    query: {
      users: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'user-123',
          name: 'Test User',
          email: 'test@example.com',
          googleId: 'google-id-123',
          tokenVersion: 1,
          role: 'user',
          provider: 'google',
          password: null,
        }),
      },
    },
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockResolvedValue(undefined),
    })),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
  eq: vi.fn(),
  or: vi.fn(),
  and: vi.fn(),
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
  SESSION_DURATION_MS: 7 * 24 * 60 * 60 * 1000,
}));

// Mock cookie utilities
vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
  appendClearCookies: vi.fn(),
  getSessionFromCookies: vi.fn().mockReturnValue('ps_sess_mock_session_token'),
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('mock-id'),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn().mockResolvedValue(null),
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

const createSigninRequest = (body: Record<string, unknown>) => {
  return new Request('http://localhost/api/auth/google/signin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

const createCallbackRequest = (params: Record<string, string>) => {
  const url = new URL('http://localhost/api/auth/google/callback');
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return new Request(url.toString(), { method: 'GET' });
};

const createSignedState = (data: Record<string, unknown>) => {
  const stateData = { data, sig: 'valid-signature' };
  return Buffer.from(JSON.stringify(stateData)).toString('base64');
};

import { checkDistributedRateLimit } from '@pagespace/lib/security';

describe('Open Redirect Protection', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'http://localhost/api/auth/google/callback';
    process.env.OAUTH_STATE_SECRET = 'test-state-secret';
    process.env.NEXTAUTH_URL = 'http://localhost';

    // Reset rate limiting mock
    (checkDistributedRateLimit as Mock).mockResolvedValue({ allowed: true, attemptsRemaining: 5 });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('POST /api/auth/google/signin - returnUrl validation', () => {
    it('given valid relative returnUrl, should accept and include in OAuth URL', async () => {
      const request = createSigninRequest({
        returnUrl: '/dashboard/my-drive',
        platform: 'web',
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.url).toBeTruthy();
    });

    it('given absolute external URL, should reject with 400', async () => {
      const request = createSigninRequest({
        returnUrl: 'https://evil.com/steal',
        platform: 'web',
        deviceId: 'device-123',
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Invalid return URL');
    });

    it('given protocol-relative URL (//evil.com), should reject with 400', async () => {
      const request = createSigninRequest({
        returnUrl: '//evil.com/steal',
        platform: 'web',
        deviceId: 'device-123',
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Invalid return URL');
    });

    it('given backslash URL (/\\evil.com), should reject with 400', async () => {
      const request = createSigninRequest({
        returnUrl: '/\\evil.com/steal',
        platform: 'web',
        deviceId: 'device-123',
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Invalid return URL');
    });

    it('given javascript: URL, should reject with 400', async () => {
      const request = createSigninRequest({
        returnUrl: '/dashboard?next=javascript:alert(1)',
        platform: 'web',
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Invalid return URL');
    });

    it('given URL-encoded malicious URL, should reject with 400', async () => {
      // %2f%2f = //
      const request = createSigninRequest({
        returnUrl: '/%2f%2fevil.com',
        platform: 'web',
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('Invalid return URL');
    });

    it('given no returnUrl, should accept (defaults to /dashboard)', async () => {
      const request = createSigninRequest({
        platform: 'web',
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.url).toBeTruthy();
    });
  });

  describe('GET /api/auth/google/callback - defense-in-depth validation', () => {
    it('given unsafe returnUrl in state, should redirect to /dashboard instead', async () => {
      // Simulate a state that somehow has an unsafe returnUrl (legacy or bypass)
      const state = createSignedState({
        platform: 'web',
        deviceId: 'device-123',
        returnUrl: 'https://evil.com/steal',
      });

      const request = createCallbackRequest({
        code: 'valid-auth-code',
        state,
      });

      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toBeTruthy();
      // Should NOT redirect to evil.com
      expect(location).not.toContain('evil.com');
      // Should redirect to dashboard
      expect(location).toContain('/dashboard');
    });

    it('given safe returnUrl in state, should redirect to that path with CSRF token', async () => {
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
      expect(location).toContain('csrfToken=');
    });

    it('given protocol-relative URL in legacy state, should redirect to /dashboard', async () => {
      const state = createSignedState({
        platform: 'web',
        returnUrl: '//evil.com/steal',
      });

      const request = createCallbackRequest({
        code: 'valid-auth-code',
        state,
      });

      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).not.toContain('evil.com');
      expect(location).toContain('/dashboard');
    });
  });
});
