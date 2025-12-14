import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { POST } from '../mobile/login/route';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  users: { email: 'email' },
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
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
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
  resetRateLimit: vi.fn(),
  RATE_LIMIT_CONFIGS: {
    LOGIN: { maxAttempts: 5, windowMs: 900000 },
  },
  decodeToken: vi.fn().mockResolvedValue({
    userId: 'test-user-id',
    iat: Math.floor(Date.now() / 1000),
  }),
  validateOrCreateDeviceToken: vi.fn().mockResolvedValue({
    deviceToken: 'mock-device-token',
  }),
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
  getSessionIdFromJWT: vi.fn().mockReturnValue('session-id-123'),
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

import { db } from '@pagespace/db';
import bcrypt from 'bcryptjs';
import {
  checkRateLimit,
  resetRateLimit,
  generateAccessToken,
  validateOrCreateDeviceToken,
  logAuthEvent,
} from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';

describe('/api/auth/mobile/login', () => {
  const mockUser = {
    id: 'test-user-id',
    email: 'test@example.com',
    name: 'Test User',
    image: 'https://example.com/avatar.png',
    password: '$2a$12$hashedpassword',
    tokenVersion: 0,
    role: 'user' as const,
  };

  const validLoginPayload = {
    email: 'test@example.com',
    password: 'validPassword123',
    deviceId: 'ios-device-123',
    platform: 'ios' as const,
    deviceName: 'iPhone 15',
    appVersion: '1.0.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mocks for successful login
    (db.query.users.findFirst as Mock).mockResolvedValue(mockUser);
    (bcrypt.compare as Mock).mockResolvedValue(true);
    (checkRateLimit as Mock).mockReturnValue({ allowed: true });
  });

  describe('successful mobile login', () => {
    it('returns 200 with user data and tokens', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/mobile/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLoginPayload),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(200);
      expect(body.user.id).toBe(mockUser.id);
      expect(body.user.email).toBe(mockUser.email);
      expect(body.user.name).toBe(mockUser.name);
      expect(body.token).toBe('mock-access-token');
      expect(body.csrfToken).toBe('mock-csrf-token');
      expect(body.deviceToken).toBe('mock-device-token');
    });

    it('does not return refresh token (device-token-only pattern)', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/mobile/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLoginPayload),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert - mobile uses device tokens, not refresh tokens
      expect(body.refreshToken).toBeUndefined();
    });

    it('creates device token for mobile platform', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/mobile/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLoginPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockUser.id,
          deviceId: 'ios-device-123',
          platform: 'ios',
          deviceName: 'iPhone 15',
        })
      );
    });

    it('resets rate limits on successful login', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/mobile/login', {
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

    it('logs login event with platform info', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/mobile/login', {
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
      expect(trackAuthEvent).toHaveBeenCalledWith(
        mockUser.id,
        'login',
        expect.objectContaining({
          platform: 'ios',
          appVersion: '1.0.0',
        })
      );
    });
  });

  describe('platform support', () => {
    it('supports iOS platform', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/mobile/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validLoginPayload, platform: 'ios' }),
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(200);
    });

    it('supports Android platform', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/mobile/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validLoginPayload, platform: 'android' }),
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(200);
    });

    it('supports desktop platform', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/mobile/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validLoginPayload, platform: 'desktop' }),
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(200);
    });

    it('defaults platform to ios', async () => {
      // Arrange
      const payloadWithoutPlatform = {
        email: 'test@example.com',
        password: 'validPassword123',
        deviceId: 'device-123',
      };

      const request = new Request('http://localhost/api/auth/mobile/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithoutPlatform),
      });

      // Act
      await POST(request);

      // Assert
      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: 'ios',
        })
      );
    });
  });

  describe('invalid credentials', () => {
    it('returns 401 for non-existent email', async () => {
      // Arrange
      (db.query.users.findFirst as Mock).mockResolvedValue(null);
      (bcrypt.compare as Mock).mockResolvedValue(false);

      const request = new Request('http://localhost/api/auth/mobile/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validLoginPayload,
          email: 'nonexistent@example.com',
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

      const request = new Request('http://localhost/api/auth/mobile/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validLoginPayload,
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

    it('performs timing-safe comparison', async () => {
      // Arrange
      (db.query.users.findFirst as Mock).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/mobile/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validLoginPayload),
      });

      // Act
      await POST(request);

      // Assert - bcrypt.compare should be called even for non-existent users
      expect(bcrypt.compare).toHaveBeenCalled();
    });

    it('logs failed login attempt', async () => {
      // Arrange
      (bcrypt.compare as Mock).mockResolvedValue(false);

      const request = new Request('http://localhost/api/auth/mobile/login', {
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
        'failed',
        mockUser.id,
        mockUser.email,
        '192.168.1.1',
        'Invalid password'
      );
    });
  });

  describe('input validation', () => {
    it('returns 400 for missing email', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/mobile/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password: 'somepassword',
          deviceId: 'device-123',
        }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.errors.email).toBeDefined();
    });

    it('returns 400 for missing deviceId', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/mobile/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'somepassword',
        }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.errors.deviceId).toBeDefined();
    });

    it('returns 400 for invalid platform', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/mobile/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validLoginPayload,
          platform: 'windows', // Invalid platform
        }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.errors.platform).toBeDefined();
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when IP rate limit exceeded', async () => {
      // Arrange
      (checkRateLimit as Mock)
        .mockReturnValueOnce({ allowed: false, retryAfter: 900 })
        .mockReturnValue({ allowed: true });

      const request = new Request('http://localhost/api/auth/mobile/login', {
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
      expect(response.headers.get('Retry-After')).toBe('900');
    });

    it('returns 429 when email rate limit exceeded', async () => {
      // Arrange
      (checkRateLimit as Mock)
        .mockReturnValueOnce({ allowed: true })
        .mockReturnValueOnce({ allowed: false, retryAfter: 900 });

      const request = new Request('http://localhost/api/auth/mobile/login', {
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
  });

  describe('error handling', () => {
    it('returns 500 on unexpected errors', async () => {
      // Arrange
      (db.query.users.findFirst as Mock).mockRejectedValue(new Error('Database error'));

      const request = new Request('http://localhost/api/auth/mobile/login', {
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
  });
});
