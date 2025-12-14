import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { POST } from '../refresh/route';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  users: { id: 'id', tokenVersion: 'tokenVersion' },
  refreshTokens: { id: 'id', token: 'token' },
  deviceTokens: { userId: 'userId', revokedAt: 'revokedAt' },
  db: {
    query: {
      refreshTokens: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    transaction: vi.fn().mockImplementation(async (cb) => {
      const trx = {
        query: {
          refreshTokens: {
            findFirst: vi.fn(),
          },
        },
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      return cb(trx);
    }),
  },
  eq: vi.fn((field, value) => ({ field, value })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
  and: vi.fn((...conditions) => conditions),
  isNull: vi.fn((field) => ({ field, isNull: true })),
}));

vi.mock('cookie', () => ({
  parse: vi.fn().mockReturnValue({ refreshToken: 'valid-refresh-token' }),
  serialize: vi.fn().mockReturnValue('mock-cookie'),
}));

vi.mock('@pagespace/lib/server', () => ({
  decodeToken: vi.fn(),
  generateAccessToken: vi.fn().mockResolvedValue('new-access-token'),
  generateRefreshToken: vi.fn().mockResolvedValue('new-refresh-token'),
  getRefreshTokenMaxAge: vi.fn().mockReturnValue(2592000),
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
  RATE_LIMIT_CONFIGS: {
    REFRESH: { maxAttempts: 10, windowMs: 300000 },
  },
}));

vi.mock('@pagespace/lib/device-auth-utils', () => ({
  validateDeviceToken: vi.fn().mockResolvedValue({ id: 'device-token-id' }),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('mock-cuid'),
}));

import { db } from '@pagespace/db';
import { parse } from 'cookie';
import {
  decodeToken,
  checkRateLimit,
  generateAccessToken,
  generateRefreshToken,
} from '@pagespace/lib/server';
import { validateDeviceToken } from '@pagespace/lib/device-auth-utils';

describe('/api/auth/refresh', () => {
  const mockUser = {
    id: 'test-user-id',
    email: 'test@example.com',
    name: 'Test User',
    tokenVersion: 0,
    role: 'user' as const,
  };

  const mockRefreshToken = {
    id: 'refresh-token-id',
    token: 'valid-refresh-token',
    userId: 'test-user-id',
    user: mockUser,
    expiresAt: new Date(Date.now() + 86400000),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: valid refresh token flow
    (parse as Mock).mockReturnValue({ refreshToken: 'valid-refresh-token' });
    (checkRateLimit as Mock).mockReturnValue({ allowed: true });

    // Mock transaction to return valid token
    (db.transaction as Mock).mockImplementation(async (cb) => {
      const trx = {
        query: {
          refreshTokens: {
            findFirst: vi.fn().mockResolvedValue(mockRefreshToken),
          },
        },
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      return cb(trx);
    });

    (decodeToken as Mock).mockResolvedValue({
      userId: 'test-user-id',
      tokenVersion: 0,
      role: 'user',
      exp: Math.floor(Date.now() / 1000) + 2592000,
      iat: Math.floor(Date.now() / 1000),
    });
  });

  describe('successful refresh', () => {
    it('returns 200 on successful token refresh', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: 'refreshToken=valid-refresh-token',
        },
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(200);
      expect(body.message).toBe('Token refreshed successfully');
    });

    it('sets new access and refresh token cookies', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: 'refreshToken=valid-refresh-token',
        },
      });

      // Act
      const response = await POST(request);

      // Assert
      const setCookieHeaders = response.headers.getSetCookie();
      expect(setCookieHeaders.length).toBe(2);
    });

    it('generates new access and refresh tokens', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: 'refreshToken=valid-refresh-token',
        },
      });

      // Act
      await POST(request);

      // Assert
      expect(generateAccessToken).toHaveBeenCalledWith(
        mockUser.id,
        mockUser.tokenVersion,
        mockUser.role
      );
      expect(generateRefreshToken).toHaveBeenCalledWith(
        mockUser.id,
        mockUser.tokenVersion,
        mockUser.role
      );
    });

    it('deletes old refresh token to prevent reuse', async () => {
      // Arrange
      let deleteWasCalled = false;
      (db.transaction as Mock).mockImplementation(async (cb) => {
        const trx = {
          query: {
            refreshTokens: {
              findFirst: vi.fn().mockResolvedValue(mockRefreshToken),
            },
          },
          delete: vi.fn().mockImplementation(() => {
            deleteWasCalled = true;
            return {
              where: vi.fn().mockResolvedValue(undefined),
            };
          }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        return cb(trx);
      });

      const request = new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: 'refreshToken=valid-refresh-token',
        },
      });

      // Act
      await POST(request);

      // Assert
      expect(deleteWasCalled).toBe(true);
    });

    it('stores new refresh token in database', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: 'refreshToken=valid-refresh-token',
        },
      });

      // Act
      await POST(request);

      // Assert
      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe('invalid refresh token', () => {
    it('returns 401 when refresh token cookie is missing', async () => {
      // Arrange
      (parse as Mock).mockReturnValue({});

      const request = new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {},
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(401);
      expect(body.error).toBe('Refresh token not found.');
    });

    it('returns 401 when refresh token is not found in database', async () => {
      // Arrange - use callback-shaped mock to exercise real control flow
      (db.transaction as Mock).mockImplementation(async (cb) => {
        const trx = {
          query: {
            refreshTokens: {
              findFirst: vi.fn().mockResolvedValue(null), // Token not found
            },
          },
          delete: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        return cb(trx);
      });

      // Token decodes to null (invalid signature), so no user invalidation occurs
      (decodeToken as Mock).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: 'refreshToken=invalid-token',
        },
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid refresh token.');
      // Verify transaction callback was actually executed
      expect(db.transaction).toHaveBeenCalled();
    });

    it('returns 401 when token version does not match', async () => {
      // Arrange - user's tokenVersion has been incremented (logged out elsewhere)
      // The user in DB now has tokenVersion: 1
      const updatedMockRefreshToken = {
        ...mockRefreshToken,
        user: { ...mockUser, tokenVersion: 1 },
      };

      // Use callback-shaped mock to exercise real control flow
      (db.transaction as Mock).mockImplementation(async (cb) => {
        const trx = {
          query: {
            refreshTokens: {
              findFirst: vi.fn().mockResolvedValue(updatedMockRefreshToken),
            },
          },
          delete: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        return cb(trx);
      });

      // Token was issued with old tokenVersion: 0
      (decodeToken as Mock).mockResolvedValue({
        userId: 'test-user-id',
        tokenVersion: 0, // old version - doesn't match user's current tokenVersion: 1
        role: 'user',
      });

      const request = new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: 'refreshToken=valid-refresh-token',
        },
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid refresh token version.');
      // Verify transaction callback was actually executed
      expect(db.transaction).toHaveBeenCalled();
    });
  });

  describe('token reuse detection (stolen token scenario)', () => {
    it('invalidates all sessions when already-used token is reused', async () => {
      // Arrange - token not in DB but valid signature (stolen and already used)
      let tokenVersionBumped = false;
      let deviceTokensRevoked = false;

      (db.transaction as Mock).mockImplementation(async (cb) => {
        const trx = {
          query: {
            refreshTokens: {
              findFirst: vi.fn().mockResolvedValue(null), // Token already deleted
            },
          },
          delete: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
          update: vi.fn().mockImplementation(() => {
            return {
              set: vi.fn().mockImplementation(() => {
                return {
                  where: vi.fn().mockImplementation(() => {
                    tokenVersionBumped = true;
                    deviceTokensRevoked = true;
                    return Promise.resolve(undefined);
                  }),
                };
              }),
            };
          }),
        };
        return cb(trx);
      });

      // Token is valid (not expired, correct signature) but not in DB
      (decodeToken as Mock).mockResolvedValue({
        userId: 'test-user-id',
        tokenVersion: 0,
        role: 'user',
      });

      const request = new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: 'refreshToken=stolen-token',
        },
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid refresh token.');
      expect(tokenVersionBumped).toBe(true);
      expect(deviceTokensRevoked).toBe(true);
    });
  });

  describe('device token validation', () => {
    it('validates device token when X-Device-Token header is provided', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: 'refreshToken=valid-refresh-token',
          'x-device-token': 'valid-device-token',
        },
      });

      // Act
      await POST(request);

      // Assert
      expect(validateDeviceToken).toHaveBeenCalledWith('valid-device-token');
    });

    it('returns 401 when device token is invalid or revoked', async () => {
      // Arrange
      (validateDeviceToken as Mock).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: 'refreshToken=valid-refresh-token',
          'x-device-token': 'invalid-device-token',
        },
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(401);
      expect(body.error).toBe('Device token is invalid or has been revoked.');
    });

    it('links new refresh token to device token', async () => {
      // Arrange
      (validateDeviceToken as Mock).mockResolvedValue({ id: 'device-token-record-id' });

      const request = new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: 'refreshToken=valid-refresh-token',
          'x-device-token': 'valid-device-token',
        },
      });

      // Act
      await POST(request);

      // Assert
      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when rate limit exceeded', async () => {
      // Arrange
      (checkRateLimit as Mock).mockReturnValue({ allowed: false, retryAfter: 300 });

      const request = new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: 'refreshToken=valid-refresh-token',
          'x-forwarded-for': '192.168.1.1',
        },
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many refresh attempts');
      expect(response.headers.get('Retry-After')).toBe('300');
    });

    it('checks rate limit with prefixed identifier', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: 'refreshToken=valid-refresh-token',
          'x-forwarded-for': '192.168.1.1',
        },
      });

      // Act
      await POST(request);

      // Assert
      expect(checkRateLimit).toHaveBeenCalledWith(
        'refresh:192.168.1.1',
        expect.any(Object)
      );
    });
  });
});
