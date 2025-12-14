import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { POST } from '../login/route';

// Mock all external dependencies
vi.mock('@pagespace/db', () => ({
  users: { email: 'email' },
  refreshTokens: { id: 'id' },
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  },
  eq: vi.fn((field, value) => ({ field, value })),
}));

vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/server', () => ({
  generateAccessToken: vi.fn().mockResolvedValue('mock-access-token'),
  generateRefreshToken: vi.fn().mockResolvedValue('mock-refresh-token'),
  getRefreshTokenMaxAge: vi.fn().mockReturnValue(2592000), // 30 days
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
  resetRateLimit: vi.fn(),
  RATE_LIMIT_CONFIGS: {
    LOGIN: { maxAttempts: 5, windowMs: 900000 },
  },
  decodeToken: vi.fn().mockResolvedValue({
    userId: 'test-user-id',
    exp: Math.floor(Date.now() / 1000) + 2592000,
    iat: Math.floor(Date.now() / 1000),
  }),
  validateOrCreateDeviceToken: vi.fn().mockResolvedValue({
    deviceToken: 'mock-device-token',
    deviceTokenRecordId: 'mock-device-token-record-id',
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

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('mock-cuid'),
}));

vi.mock('cookie', () => ({
  serialize: vi.fn().mockReturnValue('mock-cookie'),
}));

import { serialize } from 'cookie';
import { db } from '@pagespace/db';
import bcrypt from 'bcryptjs';
import {
  checkRateLimit,
  resetRateLimit,
  generateAccessToken,
  generateRefreshToken,
  validateOrCreateDeviceToken,
  logAuthEvent,
} from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';

describe('/api/auth/login', () => {
  const mockUser = {
    id: 'test-user-id',
    email: 'test@example.com',
    name: 'Test User',
    password: '$2a$12$hashedpassword',
    tokenVersion: 0,
    role: 'user' as const,
  };

  const validLoginPayload = {
    email: 'test@example.com',
    password: 'validPassword123',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mocks for successful login
    (db.query.users.findFirst as Mock).mockResolvedValue(mockUser);
    (bcrypt.compare as Mock).mockResolvedValue(true);
    (checkRateLimit as Mock).mockReturnValue({ allowed: true });
  });

  describe('with valid credentials', () => {
    it('returns 200 and user data on successful login', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLoginPayload),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(200);
      expect(body.id).toBe(mockUser.id);
      expect(body.name).toBe(mockUser.name);
      expect(body.email).toBe(mockUser.email);
    });

    it('sets httpOnly cookies for accessToken and refreshToken', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLoginPayload),
      });

      // Act
      const response = await POST(request);

      // Assert - verify cookie contract: both tokens set with security attributes
      expect(response.headers.get('set-cookie')).toBeTruthy();

      // Verify accessToken cookie contract
      expect(serialize).toHaveBeenCalledWith(
        'accessToken',
        expect.any(String),
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
        })
      );

      // Verify refreshToken cookie options
      expect(serialize).toHaveBeenCalledWith(
        'refreshToken',
        expect.any(String),
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
        })
      );
    });

    it('generates access and refresh tokens with correct user data', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLoginPayload),
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

    it('resets rate limits on successful login', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '192.168.1.1',
        },
        body: JSON.stringify(validLoginPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(resetRateLimit).toHaveBeenCalledWith('192.168.1.1');
      expect(resetRateLimit).toHaveBeenCalledWith('test@example.com');
    });

    it('logs successful login event', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '192.168.1.1',
        },
        body: JSON.stringify(validLoginPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(logAuthEvent).toHaveBeenCalledWith(
        'login',
        mockUser.id,
        mockUser.email,
        '192.168.1.1'
      );
      expect(trackAuthEvent).toHaveBeenCalledWith(
        mockUser.id,
        'login',
        expect.objectContaining({
          email: mockUser.email,
          ip: '192.168.1.1',
        })
      );
    });

    it('creates device token when deviceId is provided', async () => {
      // Arrange
      const payloadWithDevice = {
        ...validLoginPayload,
        deviceId: 'device-123',
        deviceName: 'Test Device',
      };
      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithDevice),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockUser.id,
          deviceId: 'device-123',
          platform: 'web',
        })
      );
      expect(body.deviceToken).toBe('mock-device-token');
    });
  });

  describe('with invalid credentials', () => {
    it('returns 401 for non-existent email', async () => {
      // Arrange
      (db.query.users.findFirst as Mock).mockResolvedValue(null);
      (bcrypt.compare as Mock).mockResolvedValue(false);

      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'nonexistent@example.com',
          password: 'anypassword',
        }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid email or password');
    });

    it('returns 401 for incorrect password', async () => {
      // Arrange
      (bcrypt.compare as Mock).mockResolvedValue(false);

      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'wrongpassword',
        }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid email or password');
    });

    it('performs timing-safe comparison even for non-existent users', async () => {
      // Arrange - ensure bcrypt.compare is called even when user doesn't exist
      (db.query.users.findFirst as Mock).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'nonexistent@example.com',
          password: 'anypassword',
        }),
      });

      // Act
      await POST(request);

      // Assert - security property: bcrypt.compare must be called even for non-existent users
      // This prevents timing attacks that could reveal user existence
      expect(bcrypt.compare).toHaveBeenCalled();

      // Verify the password was passed (first argument)
      const [password, hash] = (bcrypt.compare as Mock).mock.calls[0];
      expect(password).toBe('anypassword');

      // Verify a valid bcrypt hash was used (not null/undefined/empty)
      // The specific hash value is an implementation detail; we only care that
      // a consistent-cost hash comparison occurs
      expect(hash).toBeTruthy();
      expect(hash).toMatch(/^\$2[aby]?\$\d+\$/); // Valid bcrypt hash format
    });

    it('logs failed login attempt', async () => {
      // Arrange
      (bcrypt.compare as Mock).mockResolvedValue(false);

      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '192.168.1.1',
        },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'wrongpassword',
        }),
      });

      // Act
      await POST(request);

      // Assert
      expect(logAuthEvent).toHaveBeenCalledWith(
        'failed',
        mockUser.id,
        mockUser.email,
        '192.168.1.1',
        'Invalid password'
      );
    });

    it('returns 401 for OAuth-only user (no password set)', async () => {
      // Arrange
      (db.query.users.findFirst as Mock).mockResolvedValue({
        ...mockUser,
        password: null, // OAuth user has no password
      });

      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLoginPayload),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid email or password');
    });
  });

  describe('input validation', () => {
    it('returns 400 for missing email', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'somepassword' }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.errors.email).toBeDefined();
    });

    it('returns 400 for invalid email format', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email', password: 'somepassword' }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.errors.email).toBeDefined();
    });

    it('returns 400 for missing password', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com' }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });

    it('returns 400 for empty password', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', password: '' }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when IP rate limit exceeded', async () => {
      // Arrange
      (checkRateLimit as Mock)
        .mockReturnValueOnce({ allowed: false, retryAfter: 900 }) // IP limit
        .mockReturnValue({ allowed: true }); // email limit

      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '192.168.1.1',
        },
        body: JSON.stringify(validLoginPayload),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many login attempts from this IP');
      expect(body.retryAfter).toBe(900);
      expect(response.headers.get('Retry-After')).toBe('900');
    });

    it('returns 429 when email rate limit exceeded', async () => {
      // Arrange
      (checkRateLimit as Mock)
        .mockReturnValueOnce({ allowed: true }) // IP limit
        .mockReturnValueOnce({ allowed: false, retryAfter: 900 }); // email limit

      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLoginPayload),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many login attempts for this email');
    });

    it('checks rate limits before database query', async () => {
      // Arrange
      (checkRateLimit as Mock).mockReturnValue({ allowed: false, retryAfter: 900 });

      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLoginPayload),
      });

      // Act
      await POST(request);

      // Assert - database should not be queried when rate limited
      expect(db.query.users.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('IP extraction', () => {
    it('extracts IP from x-forwarded-for header', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '203.0.113.195, 70.41.3.18, 150.172.238.178',
        },
        body: JSON.stringify(validLoginPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(checkRateLimit).toHaveBeenCalledWith('203.0.113.195', expect.any(Object));
    });

    it('extracts IP from x-real-ip header when x-forwarded-for is missing', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-real-ip': '192.168.1.100',
        },
        body: JSON.stringify(validLoginPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(checkRateLimit).toHaveBeenCalledWith('192.168.1.100', expect.any(Object));
    });

    it('uses "unknown" as fallback IP when headers are missing', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLoginPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(checkRateLimit).toHaveBeenCalledWith('unknown', expect.any(Object));
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected errors', async () => {
      // Arrange
      (db.query.users.findFirst as Mock).mockRejectedValue(new Error('Database connection failed'));

      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLoginPayload),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred.');
    });

    it('does not expose internal error details to client', async () => {
      // Arrange
      (db.query.users.findFirst as Mock).mockRejectedValue(
        new Error('Sensitive database error: connection string leaked')
      );

      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLoginPayload),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(body.error).not.toContain('Sensitive');
      expect(body.error).not.toContain('connection string');
    });
  });

  describe('case sensitivity', () => {
    it('normalizes email to lowercase for rate limiting', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'TEST@EXAMPLE.COM',
          password: 'validPassword123',
        }),
      });

      // Act
      await POST(request);

      // Assert
      expect(checkRateLimit).toHaveBeenCalledWith('test@example.com', expect.any(Object));
    });
  });
});
