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

vi.mock('cookie', () => ({
  serialize: vi.fn(() => 'mock-cookie'),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-id'),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn(),
}));

import { db, users, refreshTokens } from '@pagespace/db';
import {
  decodeToken,
  generateAccessToken,
  generateRefreshToken,
  getRefreshTokenMaxAge,
} from '@pagespace/lib/server';
import { checkDistributedRateLimit } from '@pagespace/lib/security';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';

describe('/api/auth/google/callback redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();

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

  test('given new user, should redirect to Getting Started drive', async () => {
    // Arrange
    const request = new Request(
      'http://localhost/api/auth/google/callback?code=valid-code',
      { method: 'GET' }
    );

    // Act
    const response = await GET(request);

    // Assert
    expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledWith('user-123');
    expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(307);
    expect(response.headers.get('Location')).toContain('/dashboard/drive-123');
    expect(response.headers.get('Location')).toContain('auth=success');
  });

  test('given existing user with drives, should redirect to default dashboard', async () => {
    // Arrange
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

    // Act
    const response = await GET(request);

    // Assert
    expect(response.headers.get('Location')).toContain('/dashboard');
    expect(response.headers.get('Location')).not.toContain('/dashboard/drive-');
  });

  test('given provisioning throws error, should still redirect successfully', async () => {
    // Arrange
    (provisionGettingStartedDriveIfNeeded as Mock).mockRejectedValue(new Error('DB error'));

    const request = new Request(
      'http://localhost/api/auth/google/callback?code=valid-code',
      { method: 'GET' }
    );

    // Act
    const response = await GET(request);

    // Assert
    expect(response.status).toBe(307);
    expect(response.headers.get('Location')).toContain('/dashboard');
  });
});
