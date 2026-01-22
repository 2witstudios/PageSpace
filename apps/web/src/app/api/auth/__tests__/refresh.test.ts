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
  atomicTokenRefresh: vi.fn(),
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
  loggers: {
    auth: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/lib/device-auth-utils', () => ({
  validateDeviceToken: vi.fn().mockResolvedValue({ id: 'device-token-id' }),
}));

// Mock distributed rate limiting (P1-T5)
vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    attemptsRemaining: 9,
    retryAfter: undefined,
  }),
  resetDistributedRateLimit: vi.fn().mockResolvedValue(undefined),
  DISTRIBUTED_RATE_LIMITS: {
    LOGIN: { maxAttempts: 5, windowMs: 900000, progressiveDelay: true },
    SIGNUP: { maxAttempts: 3, windowMs: 3600000, progressiveDelay: false },
    REFRESH: { maxAttempts: 10, windowMs: 300000, progressiveDelay: false },
  },
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('mock-cuid'),
}));

vi.mock('@pagespace/lib/auth', () => ({
  validateDeviceToken: vi.fn().mockResolvedValue({ id: 'device-token-id' }),
  hashToken: vi.fn().mockReturnValue('mock-token-hash'),
  getTokenPrefix: vi.fn().mockReturnValue('mock-prefix'),
}));

import { db, atomicTokenRefresh } from '@pagespace/db';
import { parse } from 'cookie';
import {
  decodeToken,
  generateAccessToken,
  generateRefreshToken,
} from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { validateDeviceToken } from '@pagespace/lib/auth';

describe('/api/auth/refresh', () => {
  const mockUser = {
    id: 'test-user-id',
    email: 'test@example.com',
    name: 'Test User',
    tokenVersion: 0,
    role: 'user' as const,
  };

  // Reference structure for refresh token (used by atomicTokenRefresh internally)
  const _mockRefreshToken = {
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

    // Mock atomicTokenRefresh to return success
    (atomicTokenRefresh as Mock).mockResolvedValue({
      success: true,
      userId: mockUser.id,
      tokenVersion: mockUser.tokenVersion,
      role: mockUser.role,
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
      // Expects 3 cookies: accessToken, refreshToken (scoped path), and legacy clear cookie
      const setCookieHeaders = response.headers.getSetCookie();
      expect(setCookieHeaders.length).toBe(3);
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

    it('atomically refreshes token (marks old token as used)', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: 'refreshToken=valid-refresh-token',
        },
      });

      // Act
      await POST(request);

      // Assert - atomicTokenRefresh handles marking old token as used
      expect(atomicTokenRefresh).toHaveBeenCalledWith('valid-refresh-token', expect.any(Function));
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
      // Arrange - atomicTokenRefresh returns failure
      (atomicTokenRefresh as Mock).mockResolvedValue({
        success: false,
        error: 'Invalid or expired token',
      });

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
      expect(body.error).toBe('Invalid or expired token');
      expect(atomicTokenRefresh).toHaveBeenCalled();
    });

    it('returns 401 when token version does not match', async () => {
      // Arrange - atomicTokenRefresh detects version mismatch
      (atomicTokenRefresh as Mock).mockResolvedValue({
        success: false,
        error: 'Invalid refresh token version.',
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
      expect(atomicTokenRefresh).toHaveBeenCalled();
    });
  });

  describe('token reuse detection (stolen token scenario)', () => {
    it('invalidates all sessions when already-used token is reused', async () => {
      // Arrange - atomicTokenRefresh detects token reuse (stolen and already used)
      // The atomic function handles invalidating all sessions internally
      (atomicTokenRefresh as Mock).mockResolvedValue({
        success: false,
        tokenReuse: true,
        error: 'Token reuse detected - all sessions invalidated',
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
      expect(body.error).toBe('Token reuse detected - all sessions invalidated');
      expect(atomicTokenRefresh).toHaveBeenCalled();
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
      (checkDistributedRateLimit as Mock).mockResolvedValue({ allowed: false, retryAfter: 300, attemptsRemaining: 0 });

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
      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'refresh:ip:192.168.1.1',
        expect.any(Object)
      );
    });
  });

  describe('distributed rate limiting', () => {
    beforeEach(() => {
      // Reset rate limiting mock to allow requests
      (checkDistributedRateLimit as Mock).mockResolvedValue({
        allowed: true,
        attemptsRemaining: 9,
        retryAfter: undefined,
      });
    });

    it('calls checkDistributedRateLimit for IP', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: 'refreshToken=valid-refresh-token',
          'x-forwarded-for': '192.168.1.100',
        },
      });

      // Act
      await POST(request);

      // Assert
      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'refresh:ip:192.168.1.100',
        DISTRIBUTED_RATE_LIMITS.REFRESH
      );
    });

    it('returns 429 with X-RateLimit headers when distributed limit exceeded', async () => {
      // Arrange
      (checkDistributedRateLimit as Mock).mockResolvedValueOnce({
        allowed: false,
        retryAfter: 300,
        attemptsRemaining: 0,
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
      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many refresh attempts');
      expect(response.headers.get('Retry-After')).toBe('300');
      expect(response.headers.get('X-RateLimit-Limit')).toBe('10');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    });

    it('resets distributed rate limit on successful refresh', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: 'refreshToken=valid-refresh-token',
          'x-forwarded-for': '192.168.1.100',
        },
      });

      // Act
      await POST(request);

      // Assert
      expect(resetDistributedRateLimit).toHaveBeenCalledWith('refresh:ip:192.168.1.100');
    });

    it('includes X-RateLimit headers on successful response', async () => {
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
      expect(response.status).toBe(200);
      expect(response.headers.get('X-RateLimit-Limit')).toBe('10');
      expect(response.headers.get('X-RateLimit-Remaining')).toBeTruthy();
    });

    it('uses refresh:ip key format (IP only, no email)', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: 'refreshToken=valid-refresh-token',
          'x-forwarded-for': '10.0.0.1',
        },
      });

      // Act
      await POST(request);

      // Assert - refresh uses IP only, not email
      expect(checkDistributedRateLimit).toHaveBeenCalledTimes(1);
      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        expect.stringMatching(/^refresh:ip:/),
        expect.any(Object)
      );
    });
  });
});
