import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { POST } from '../signup/route';

// Mock all external dependencies
vi.mock('@pagespace/db', () => ({
  users: { email: 'email', id: 'id' },
  drives: {},
  userAiSettings: {},
  refreshTokens: {},
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: 'new-user-id',
            name: 'New User',
            email: 'new@example.com',
            tokenVersion: 0,
            role: 'user',
          },
        ]),
      }),
    }),
  },
  eq: vi.fn((field, value) => ({ field, value })),
}));

vi.mock('bcryptjs', () => ({
  default: {
    // Use a properly formatted bcrypt hash (60 chars: $2a$12$ + 53 char salt+hash)
    hash: vi.fn().mockResolvedValue('$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5GyYzpLLEm4Eu'),
  },
}));

vi.mock('@pagespace/lib/server', () => ({
  slugify: vi.fn((name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
  generateAccessToken: vi.fn().mockResolvedValue('mock-access-token'),
  generateRefreshToken: vi.fn().mockResolvedValue('mock-refresh-token'),
  getRefreshTokenMaxAge: vi.fn().mockReturnValue(2592000),
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true }),
  resetRateLimit: vi.fn(),
  RATE_LIMIT_CONFIGS: {
    SIGNUP: { maxAttempts: 3, windowMs: 3600000 },
  },
  createNotification: vi.fn().mockResolvedValue(undefined),
  decodeToken: vi.fn().mockResolvedValue({
    userId: 'new-user-id',
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

vi.mock('@pagespace/lib/verification-utils', () => ({
  createVerificationToken: vi.fn().mockResolvedValue('mock-verification-token'),
}));

vi.mock('@pagespace/lib/services/email-service', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/email-templates/VerificationEmail', () => ({
  VerificationEmail: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('mock-cuid'),
}));

vi.mock('cookie', () => ({
  serialize: vi.fn().mockReturnValue('mock-cookie'),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn().mockResolvedValue({ driveId: 'new-drive-id' }),
}));

import { serialize } from 'cookie';

vi.mock('react', () => ({
  default: {
    createElement: vi.fn().mockReturnValue({}),
  },
}));

import { db } from '@pagespace/db';
import bcrypt from 'bcryptjs';
import {
  checkRateLimit,
  resetRateLimit,
  generateAccessToken,
  generateRefreshToken,
  createNotification,
  logAuthEvent,
  loggers,
} from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { createVerificationToken } from '@pagespace/lib/verification-utils';
import { sendEmail } from '@pagespace/lib/services/email-service';
import { provisionGettingStartedDriveIfNeeded } from '@/lib/onboarding/getting-started-drive';

describe('/api/auth/signup', () => {
  const validSignupPayload = {
    name: 'New User',
    email: 'new@example.com',
    password: 'ValidPass123!',
    confirmPassword: 'ValidPass123!',
    acceptedTos: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: no existing user
    (db.query.users.findFirst as Mock).mockResolvedValue(null);
    (checkRateLimit as Mock).mockReturnValue({ allowed: true });
  });

  describe('with valid input', () => {
    it('returns 303 redirect to dashboard on successful signup', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toContain('/dashboard/new-drive-id');
    });

    it('sets httpOnly cookies for accessToken and refreshToken', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      // Act
      const response = await POST(request);

      // Assert - verify serialize was called with httpOnly and security options
      expect(response.headers.get('set-cookie')).toBeTruthy();
      // Use "at least 2" to allow for future cookies (CSRF hints, etc.)
      expect((serialize as Mock).mock.calls.length).toBeGreaterThanOrEqual(2);

      // Verify accessToken cookie options
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

    it('hashes password with bcrypt cost factor 12', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(bcrypt.hash).toHaveBeenCalledWith('ValidPass123!', 12);
    });

    it('creates user with correct data', async () => {
      // Arrange - capture insert values for user creation
      interface CapturedUserData {
        email?: string;
        name?: string;
        password?: string;
      }
      let capturedUserData: CapturedUserData | undefined;
      const mockValues = vi.fn().mockImplementation((data: CapturedUserData) => {
        // Capture the first insert (user creation)
        if (!capturedUserData && data.email) {
          capturedUserData = data;
        }
        return {
          returning: vi.fn().mockResolvedValue([
            {
              id: 'new-user-id',
              name: data.name || 'New User',
              email: data.email || 'new@example.com',
              tokenVersion: 0,
              role: 'user',
            },
          ]),
        };
      });
      (db.insert as Mock).mockReturnValue({ values: mockValues });

      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      // Act
      await POST(request);

      // Assert - verify user was created with correct fields
      expect(capturedUserData).toBeDefined();
      expect(capturedUserData!.email).toBe('new@example.com');
      expect(capturedUserData!.name).toBe('New User');
      // Password should be hashed, not plaintext
      expect(typeof capturedUserData!.password).toBe('string');
      expect(capturedUserData!.password).not.toBe('ValidPass123!');
      expect(capturedUserData!.password).toMatch(/^\$2[aby]?\$\d{1,2}\$[./A-Za-z0-9]{53}$/); // Full bcrypt hash format
    });

    it('creates a personal drive for new user', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      // Act
      await POST(request);

      expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledWith('new-user-id');
    });

    it('sends verification email', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(createVerificationToken).toHaveBeenCalled();
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'new@example.com',
          subject: 'Verify your PageSpace email',
        })
      );
    });

    it('creates notification for email verification', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EMAIL_VERIFICATION_REQUIRED',
          title: 'Please verify your email',
        })
      );
    });

    it('logs successful signup event', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '192.168.1.1',
        },
        body: JSON.stringify(validSignupPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(logAuthEvent).toHaveBeenCalledWith(
        'signup',
        'new-user-id',
        'new@example.com',
        '192.168.1.1'
      );
      expect(trackAuthEvent).toHaveBeenCalledWith(
        'new-user-id',
        'signup',
        expect.objectContaining({
          email: 'new@example.com',
          name: 'New User',
        })
      );
    });

    it('resets rate limits on successful signup', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '192.168.1.1',
        },
        body: JSON.stringify(validSignupPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(resetRateLimit).toHaveBeenCalledWith('192.168.1.1');
      expect(resetRateLimit).toHaveBeenCalledWith('new@example.com');
    });

    it('generates tokens for automatic authentication', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(generateAccessToken).toHaveBeenCalledWith('new-user-id', 0, 'user');
      expect(generateRefreshToken).toHaveBeenCalledWith('new-user-id', 0, 'user');
    });

    it('continues signup even if verification email fails', async () => {
      // Arrange
      (sendEmail as Mock).mockRejectedValue(new Error('SMTP error'));

      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      // Act
      const response = await POST(request);

      // Assert - signup should still succeed
      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toContain('/dashboard/new-drive-id');
    });

    it('continues signup even if drive provisioning fails', async () => {
      // Arrange
      (provisionGettingStartedDriveIfNeeded as Mock).mockRejectedValue(
        new Error('Database error')
      );

      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      // Act
      const response = await POST(request);

      // Assert - signup should still succeed with fallback to /dashboard
      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toContain('/dashboard');
      expect(response.headers.get('Location')).not.toContain('/dashboard/new-drive-id');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Failed to provision Getting Started drive',
        expect.any(Error),
        expect.objectContaining({ userId: 'new-user-id' })
      );
    });
  });

  describe('with duplicate email', () => {
    it('returns 409 when email already exists', async () => {
      // Arrange
      (db.query.users.findFirst as Mock).mockResolvedValue({
        id: 'existing-user-id',
        email: 'new@example.com',
      });

      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(409);
      expect(body.error).toBe('User with this email already exists');
    });

    it('logs failed signup for duplicate email', async () => {
      // Arrange
      (db.query.users.findFirst as Mock).mockResolvedValue({
        id: 'existing-user-id',
        email: 'new@example.com',
      });

      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '192.168.1.1',
        },
        body: JSON.stringify(validSignupPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(logAuthEvent).toHaveBeenCalledWith(
        'failed',
        undefined,
        'new@example.com',
        '192.168.1.1',
        'Email already exists'
      );
    });
  });

  describe('input validation', () => {
    it('returns 400 for missing name', async () => {
      // Arrange
      const payload = { ...validSignupPayload };
      // @ts-expect-error - intentionally testing invalid input
      delete payload.name;

      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.errors.name).toBeDefined();
    });

    it('returns 400 for invalid email format', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validSignupPayload,
          email: 'not-an-email',
        }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.errors.email).toBeDefined();
    });

    it('returns 400 for password shorter than 12 characters', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validSignupPayload,
          password: 'Short1!',
          confirmPassword: 'Short1!',
        }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });

    it('returns 400 for password without uppercase', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validSignupPayload,
          password: 'validpass123!',
          confirmPassword: 'validpass123!',
        }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });

    it('returns 400 for password without lowercase', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validSignupPayload,
          password: 'VALIDPASS123!',
          confirmPassword: 'VALIDPASS123!',
        }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });

    it('returns 400 for password without number', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validSignupPayload,
          password: 'ValidPassword!',
          confirmPassword: 'ValidPassword!',
        }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });

    it('returns 400 when passwords do not match', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validSignupPayload,
          confirmPassword: 'DifferentPass123!',
        }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.errors.confirmPassword).toBeDefined();
    });

    it('returns 400 when ToS not accepted', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validSignupPayload,
          acceptedTos: false,
        }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.errors.acceptedTos).toBeDefined();
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when IP rate limit exceeded', async () => {
      // Arrange
      (checkRateLimit as Mock)
        .mockReturnValueOnce({ allowed: false, retryAfter: 3600 })
        .mockReturnValue({ allowed: true });

      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '192.168.1.1',
        },
        body: JSON.stringify(validSignupPayload),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many signup attempts from this IP');
      expect(response.headers.get('Retry-After')).toBe('3600');
    });

    it('returns 429 when email rate limit exceeded', async () => {
      // Arrange
      (checkRateLimit as Mock)
        .mockReturnValueOnce({ allowed: true })
        .mockReturnValueOnce({ allowed: false, retryAfter: 3600 });

      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many signup attempts for this email');
    });

    it('logs rate limit failure', async () => {
      // Arrange
      (checkRateLimit as Mock).mockReturnValue({ allowed: false, retryAfter: 3600 });

      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '192.168.1.1',
        },
        body: JSON.stringify(validSignupPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(logAuthEvent).toHaveBeenCalledWith(
        'failed',
        undefined,
        'new@example.com',
        '192.168.1.1',
        'IP rate limit exceeded'
      );
    });
  });

  describe('device token creation', () => {
    it('creates device token when deviceId is provided', async () => {
      // Arrange
      const payloadWithDevice = {
        ...validSignupPayload,
        deviceId: 'device-123',
        deviceName: 'Test Device',
      };

      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithDevice),
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.headers.get('Location')).toContain('deviceToken=mock-device-token');
    });

    it('does not create device token when deviceId is not provided', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.headers.get('Location')).not.toContain('deviceToken');
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected errors', async () => {
      // Arrange - Make the insert chain throw an error
      (db.insert as Mock).mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      const request = new Request('http://localhost/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
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
