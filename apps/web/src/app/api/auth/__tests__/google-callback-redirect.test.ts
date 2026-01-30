/**
 * Tests for Google OAuth callback redirect to Getting Started drive
 */

import { describe, expect, test, beforeEach, vi, type Mock } from 'vitest';
import { GET } from '../google/callback/route';

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    getToken: vi.fn().mockResolvedValue({
      tokens: {
        id_token: 'mock-id-token',
      },
    }),
    verifyIdToken: vi.fn().mockResolvedValue({
      getPayload: () => ({
        sub: 'google-id',
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
  SESSION_DURATION_MS: 7 * 24 * 60 * 60 * 1000,
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
  // Use actual implementation for isSafeReturnUrl so redirect tests are valid
  isSafeReturnUrl: (url: string | undefined): boolean => {
    if (!url) return true;
    if (!url.startsWith('/')) return false;
    if (url.startsWith('//') || url.startsWith('/\\')) return false;
    if (/[a-z]+:/i.test(url)) return false;
    try {
      const decoded = decodeURIComponent(url);
      if (decoded.startsWith('//') || decoded.startsWith('/\\')) return false;
      if (/[a-z]+:/i.test(decoded)) return false;
    } catch {
      return false;
    }
    return true;
  },
}));

import { db, users } from '@pagespace/db';
import { checkDistributedRateLimit } from '@pagespace/lib/security';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';

describe('/api/auth/google/callback redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (checkDistributedRateLimit as Mock).mockResolvedValue({ allowed: true, attemptsRemaining: 5 });
    (provisionGettingStartedDriveIfNeeded as Mock).mockResolvedValue({
      driveId: 'drive-123',
    });

    (db.query.users.findFirst as Mock).mockResolvedValue(null);

    (db.insert as Mock).mockImplementation((table: unknown) => {
      if (table === users) {
        return {
          values: vi.fn(() => ({
            returning: vi.fn(() =>
              Promise.resolve([
                {
                  id: 'user-123',
                  name: 'Test User',
                  email: 'test@example.com',
                  googleId: 'google-id',
                  tokenVersion: 0,
                  role: 'user',
                },
              ])
            ),
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

  test('given new user, should redirect to Getting Started drive', async () => {
    const request = new Request(
      'http://localhost/api/auth/google/callback?code=valid-code',
      { method: 'GET' }
    );

    const response = await GET(request);

    expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledWith('user-123');
    expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(307);
    expect(response.headers.get('Location')).toContain('/dashboard/drive-123');
    expect(response.headers.get('Location')).toContain('auth=success');
  });

  test('given existing user with drives, should redirect to default dashboard', async () => {
    (provisionGettingStartedDriveIfNeeded as Mock).mockResolvedValue(null);
    (db.query.users.findFirst as Mock).mockResolvedValue({
      id: 'user-123',
      name: 'Existing User',
      email: 'test@example.com',
      googleId: 'google-id',
      tokenVersion: 0,
      role: 'user',
    });

    const request = new Request(
      'http://localhost/api/auth/google/callback?code=valid-code',
      { method: 'GET' }
    );

    const response = await GET(request);

    expect(response.headers.get('Location')).toContain('/dashboard');
    expect(response.headers.get('Location')).not.toContain('/dashboard/drive-');
  });

  test('given provisioning throws error, should still redirect successfully', async () => {
    (provisionGettingStartedDriveIfNeeded as Mock).mockRejectedValue(new Error('DB error'));

    const request = new Request(
      'http://localhost/api/auth/google/callback?code=valid-code',
      { method: 'GET' }
    );

    const response = await GET(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('Location')).toContain('/dashboard');
  });
});
