/**
 * Mobile Signup Route Tests
 *
 * Comprehensive test coverage for /api/auth/mobile/signup:
 * - Successful user registration
 * - Password validation requirements
 * - Email verification workflow
 * - Device token creation
 * - Rate limiting (IP and email)
 * - Error handling
 * - Drive creation
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { POST } from '../mobile/signup/route';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  users: { email: 'email', id: 'id' },
  drives: {},
  userAiSettings: {},
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockReturnValue({
          then: vi.fn(),
        }),
      }),
    }),
  },
  eq: vi.fn((field, value) => ({ field, value })),
}));

vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$2a$12$hashedpassword'),
  },
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'test-user-id-123'),
}));

vi.mock('@pagespace/lib/server', () => ({
  slugify: vi.fn((name) => name.toLowerCase().replace(/\s+/g, '-')),
  createNotification: vi.fn().mockResolvedValue(undefined),
  validateOrCreateDeviceToken: vi.fn().mockResolvedValue({
    deviceToken: 'mock-device-token',
  }),
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
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

vi.mock('@pagespace/lib/auth', () => ({
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock-session-token'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'session-id-123',
      userId: 'test-user-id-123',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    }),
  },
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    attemptsRemaining: 2,
    retryAfter: undefined,
  }),
  resetDistributedRateLimit: vi.fn().mockResolvedValue(undefined),
  DISTRIBUTED_RATE_LIMITS: {
    LOGIN: { maxAttempts: 5, windowMs: 900000, progressiveDelay: true },
    SIGNUP: { maxAttempts: 3, windowMs: 3600000, progressiveDelay: false },
    REFRESH: { maxAttempts: 10, windowMs: 300000, progressiveDelay: false },
  },
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

vi.mock('@/lib/onboarding/drive-setup', () => ({
  populateUserDrive: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn().mockReturnValue('192.168.1.1'),
}));

import { db } from '@pagespace/db';
import {
  validateOrCreateDeviceToken,
  logAuthEvent,
  createNotification,
} from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
} from '@pagespace/lib/security';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { sendEmail } from '@pagespace/lib/services/email-service';
import { createVerificationToken } from '@pagespace/lib/verification-utils';
import { populateUserDrive } from '@/lib/onboarding/drive-setup';

describe('/api/auth/mobile/signup', () => {
  const mockNewUser = {
    id: 'test-user-id-123',
    email: 'newuser@example.com',
    name: 'New User',
    image: null,
    tokenVersion: 0,
    role: 'user' as const,
    storageUsedBytes: 0,
    subscriptionTier: 'free',
  };

  const mockDrive = {
    id: 'drive-id-123',
    name: 'Getting Started',
    slug: 'getting-started',
    ownerId: 'test-user-id-123',
  };

  const validSignupPayload = {
    name: 'New User',
    email: 'newuser@example.com',
    password: 'ValidPassword123',
    confirmPassword: 'ValidPassword123',
    deviceId: 'ios-device-456',
    platform: 'ios' as const,
    deviceName: 'iPhone 15 Pro',
    appVersion: '1.0.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mocks for successful signup
    (db.query.users.findFirst as Mock).mockResolvedValue(null); // No existing user
    (db.insert as Mock).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockReturnValue({
          then: vi.fn((cb) => Promise.resolve(cb([mockNewUser]))),
        }),
      }),
    });
  });

  describe('successful mobile signup', () => {
    it('returns 201 with user data and tokens', async () => {
      // Setup for drive creation
      let driveInsertCallback: ((results: typeof mockDrive[]) => typeof mockDrive) | null = null;
      (db.insert as Mock).mockImplementation(() => ({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockReturnValue({
            then: vi.fn((cb) => {
              if (!driveInsertCallback) {
                driveInsertCallback = cb;
                return Promise.resolve(cb([mockNewUser]));
              }
              return Promise.resolve(cb([mockDrive]));
            }),
          }),
        }),
      }));

      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.user.email).toBe(validSignupPayload.email);
      expect(body.user.name).toBe(validSignupPayload.name);
      expect(body.sessionToken).toBe('ps_sess_mock-session-token');
      expect(body.csrfToken).toBe('mock-csrf-token');
      expect(body.deviceToken).toBe('mock-device-token');
    });

    it('does not return password in response', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(body.user.password).toBeUndefined();
    });

    it('creates device token for mobile platform', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      await POST(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'test-user-id-123',
          deviceId: 'ios-device-456',
          platform: 'ios',
          deviceName: 'iPhone 15 Pro',
        })
      );
    });

    it('creates Getting Started drive for new user', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      await POST(request);

      // Verify drive creation
      expect(db.insert).toHaveBeenCalled();
    });

    it('sends verification email', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      await POST(request);

      expect(createVerificationToken).toHaveBeenCalled();
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: validSignupPayload.email,
          subject: 'Verify your PageSpace email',
        })
      );
    });

    it('creates notification to verify email', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      await POST(request);

      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'test-user-id-123',
          type: 'EMAIL_VERIFICATION_REQUIRED',
        })
      );
    });

    it('resets rate limits on successful signup', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '192.168.1.1',
        },
        body: JSON.stringify(validSignupPayload),
      });

      await POST(request);

      expect(resetDistributedRateLimit).toHaveBeenCalledWith('signup:ip:192.168.1.1');
      expect(resetDistributedRateLimit).toHaveBeenCalledWith(
        `signup:email:${validSignupPayload.email.toLowerCase()}`
      );
    });

    it('logs signup event', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      await POST(request);

      expect(logAuthEvent).toHaveBeenCalledWith(
        'signup',
        'test-user-id-123',
        validSignupPayload.email,
        '192.168.1.1'
      );
    });

    it('tracks signup event with platform info', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      await POST(request);

      expect(trackAuthEvent).toHaveBeenCalledWith(
        'test-user-id-123',
        'signup',
        expect.objectContaining({
          platform: 'ios',
          appVersion: '1.0.0',
          email: validSignupPayload.email,
        })
      );
    });
  });

  describe('platform support', () => {
    it('supports iOS platform', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validSignupPayload, platform: 'ios' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(201);
    });

    it('supports Android platform', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validSignupPayload, platform: 'android' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(201);
    });

    it('supports desktop platform', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validSignupPayload, platform: 'desktop' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(201);
    });

    it('defaults platform to ios', async () => {
      const payloadWithoutPlatform = {
        name: 'Test User',
        email: 'test@example.com',
        password: 'ValidPassword123',
        confirmPassword: 'ValidPassword123',
        deviceId: 'device-123',
      };

      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadWithoutPlatform),
      });

      await POST(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: 'ios',
        })
      );
    });
  });

  describe('password validation', () => {
    it('returns 400 for password less than 12 characters', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validSignupPayload,
          password: 'Short1A',
          confirmPassword: 'Short1A',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });

    it('returns 400 for password without uppercase', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validSignupPayload,
          password: 'nouppercase123',
          confirmPassword: 'nouppercase123',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });

    it('returns 400 for password without lowercase', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validSignupPayload,
          password: 'NOLOWERCASE123',
          confirmPassword: 'NOLOWERCASE123',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });

    it('returns 400 for password without number', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validSignupPayload,
          password: 'NoNumbersHere',
          confirmPassword: 'NoNumbersHere',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });

    it('returns 400 for mismatched passwords', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validSignupPayload,
          password: 'ValidPassword123',
          confirmPassword: 'DifferentPassword123',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.confirmPassword).toBeDefined();
    });
  });

  describe('input validation', () => {
    it('returns 400 for missing name', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'ValidPassword123',
          confirmPassword: 'ValidPassword123',
          deviceId: 'device-123',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.name).toBeDefined();
    });

    it('returns 400 for invalid email', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validSignupPayload,
          email: 'not-an-email',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.email).toBeDefined();
    });

    it('returns 400 for missing deviceId', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Test User',
          email: 'test@example.com',
          password: 'ValidPassword123',
          confirmPassword: 'ValidPassword123',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.deviceId).toBeDefined();
    });

    it('returns 400 for invalid platform', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validSignupPayload,
          platform: 'windows',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.platform).toBeDefined();
    });
  });

  describe('existing user', () => {
    it('returns 409 when email already exists', async () => {
      (db.query.users.findFirst as Mock).mockResolvedValue({
        id: 'existing-user',
        email: validSignupPayload.email,
      });

      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toBe('User with this email already exists');
    });

    it('logs failed signup for existing email', async () => {
      (db.query.users.findFirst as Mock).mockResolvedValue({
        id: 'existing-user',
        email: validSignupPayload.email,
      });

      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      await POST(request);

      expect(logAuthEvent).toHaveBeenCalledWith(
        'failed',
        undefined,
        validSignupPayload.email,
        '192.168.1.1',
        'Email already exists'
      );
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when IP rate limit exceeded', async () => {
      (checkDistributedRateLimit as Mock)
        .mockResolvedValueOnce({ allowed: false, retryAfter: 3600, attemptsRemaining: 0 })
        .mockResolvedValue({ allowed: true, attemptsRemaining: 2 });

      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many signup attempts from this IP');
      expect(response.headers.get('Retry-After')).toBe('3600');
    });

    it('returns 429 when email rate limit exceeded', async () => {
      (checkDistributedRateLimit as Mock)
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 2 })
        .mockResolvedValueOnce({ allowed: false, retryAfter: 3600, attemptsRemaining: 0 });

      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many signup attempts for this email');
    });

    it('includes X-RateLimit headers on rate limit response', async () => {
      (checkDistributedRateLimit as Mock)
        .mockResolvedValueOnce({ allowed: false, retryAfter: 3600, attemptsRemaining: 0 })
        .mockResolvedValue({ allowed: true, attemptsRemaining: 2 });

      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      const response = await POST(request);

      expect(response.headers.get('X-RateLimit-Limit')).toBe('3');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    });
  });

  describe('error handling', () => {
    it('returns 500 on database error', async () => {
      (db.query.users.findFirst as Mock).mockRejectedValue(new Error('Database error'));

      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred.');
    });

    it('continues signup if email sending fails', async () => {
      (sendEmail as Mock).mockRejectedValue(new Error('Email service down'));

      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      const response = await POST(request);

      // Signup should still succeed
      expect(response.status).toBe(201);
    });

    it('continues signup if drive population fails', async () => {
      (populateUserDrive as Mock).mockRejectedValue(new Error('Population failed'));

      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      const response = await POST(request);

      // Signup should still succeed
      expect(response.status).toBe(201);
    });
  });

  describe('session creation', () => {
    it('creates 90-day session for mobile', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      await POST(request);

      const { sessionService } = await import('@pagespace/lib/auth');
      expect(sessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresInMs: 90 * 24 * 60 * 60 * 1000,
          createdByService: 'mobile-signup',
        })
      );
    });
  });

  describe('AI settings', () => {
    it('creates default Ollama AI provider for new user', async () => {
      const request = new Request('http://localhost/api/auth/mobile/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validSignupPayload),
      });

      await POST(request);

      // Verify AI settings insert was called
      expect(db.insert).toHaveBeenCalled();
    });
  });
});
