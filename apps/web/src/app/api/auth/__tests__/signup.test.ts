/**
 * Contract tests for POST /api/auth/signup
 *
 * These tests verify the Request → Response contract for user registration.
 * Mocks are placed at system boundaries (database, external services).
 *
 * Coverage:
 * - User creation with valid/invalid input
 * - Email verification flow
 * - Rate limiting
 * - Session management (session-based auth with opaque tokens)
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { POST } from '../signup/route';

// Mock all external dependencies
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
    hash: vi.fn().mockResolvedValue('$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewY5GyYzpLLEm4Eu'),
  },
}));

// Mock session service from @pagespace/lib/auth
vi.mock('@pagespace/lib/auth', () => ({
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock_session_token'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'mock-session-id',
      userId: 'new-user-id',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
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
  slugify: vi.fn((name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
  createNotification: vi.fn().mockResolvedValue(undefined),
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
  logAuthEvent: vi.fn(),
  logSecurityEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

// Mock distributed rate limiting (P1-T5)
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

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('mock-cuid'),
}));

vi.mock('cookie', () => ({
  serialize: vi.fn().mockReturnValue('mock-cookie'),
  parse: vi.fn(() => ({ login_csrf: 'valid-csrf-token' })),
}));

// Mock login CSRF validation
vi.mock('@/lib/auth/login-csrf-utils', () => ({
  validateLoginCSRFToken: vi.fn(() => true),
}));

// Mock client IP extraction
vi.mock('@/lib/auth', () => ({
  validateLoginCSRFToken: vi.fn(() => true),
  getClientIP: vi.fn().mockReturnValue('unknown'),
}));

vi.mock('@/lib/onboarding/getting-started-drive', () => ({
  provisionGettingStartedDriveIfNeeded: vi.fn().mockResolvedValue({ driveId: 'new-drive-id' }),
}));

vi.mock('react', () => ({
  default: {
    createElement: vi.fn().mockReturnValue({}),
  },
}));

import { db } from '@pagespace/db';
import bcrypt from 'bcryptjs';
import { sessionService } from '@pagespace/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { getClientIP } from '@/lib/auth';
import {
  createNotification,
  logAuthEvent,
  loggers,
} from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
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

  // Helper function to create requests with CSRF headers
  const createSignupRequest = (
    payload: Record<string, unknown>,
    additionalHeaders: Record<string, string> = {}
  ) => {
    return new Request('http://localhost/api/auth/signup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Login-CSRF-Token': 'valid-csrf-token',
        'Cookie': 'login_csrf=valid-csrf-token',
        ...additionalHeaders,
      },
      body: JSON.stringify(payload),
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: no existing user
    (db.query.users.findFirst as Mock).mockResolvedValue(null);
    // Reset client IP mock
    (getClientIP as Mock).mockReturnValue('unknown');
  });

  describe('with valid input', () => {
    it('returns 303 redirect to dashboard on successful signup', async () => {
      const request = createSignupRequest(validSignupPayload);
      const response = await POST(request);

      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toContain('/dashboard/new-drive-id');
    });

    it('creates session and sets session cookie', async () => {
      const request = createSignupRequest(validSignupPayload);
      await POST(request);

      // Verify session creation
      expect(sessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'new-user-id',
          type: 'user',
          scopes: ['*'],
        })
      );

      // Verify session cookie is set
      expect(appendSessionCookie).toHaveBeenCalled();
    });

    it('hashes password with bcrypt cost factor 12', async () => {
      const request = createSignupRequest(validSignupPayload);
      await POST(request);

      expect(bcrypt.hash).toHaveBeenCalledWith('ValidPass123!', 12);
    });

    it('creates user with correct data', async () => {
      interface CapturedUserData {
        email?: string;
        name?: string;
        password?: string;
      }
      let capturedUserData: CapturedUserData | undefined;
      const mockValues = vi.fn().mockImplementation((data: CapturedUserData) => {
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

      const request = createSignupRequest(validSignupPayload);
      await POST(request);

      expect(capturedUserData).toBeDefined();
      expect(capturedUserData!.email).toBe('new@example.com');
      expect(capturedUserData!.name).toBe('New User');
      expect(typeof capturedUserData!.password).toBe('string');
      expect(capturedUserData!.password).not.toBe('ValidPass123!');
      expect(capturedUserData!.password).toMatch(/^\$2[aby]?\$\d{1,2}\$[./A-Za-z0-9]{53}$/);
    });

    it('creates a personal drive for new user', async () => {
      const request = createSignupRequest(validSignupPayload);
      await POST(request);

      expect(provisionGettingStartedDriveIfNeeded).toHaveBeenCalledWith('new-user-id');
    });

    it('sends verification email', async () => {
      const request = createSignupRequest(validSignupPayload);
      await POST(request);

      expect(createVerificationToken).toHaveBeenCalled();
      expect(sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'new@example.com',
          subject: 'Verify your PageSpace email',
        })
      );
    });

    it('creates notification for email verification', async () => {
      const request = createSignupRequest(validSignupPayload);
      await POST(request);

      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EMAIL_VERIFICATION_REQUIRED',
          title: 'Please verify your email',
        })
      );
    });

    it('logs successful signup event', async () => {
      (getClientIP as Mock).mockReturnValue('192.168.1.1');

      const request = createSignupRequest(validSignupPayload, {
        'x-forwarded-for': '192.168.1.1',
      });

      await POST(request);

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
      (getClientIP as Mock).mockReturnValue('192.168.1.1');

      const request = createSignupRequest(validSignupPayload, {
        'x-forwarded-for': '192.168.1.1',
      });

      await POST(request);

      expect(resetDistributedRateLimit).toHaveBeenCalledWith('signup:ip:192.168.1.1');
      expect(resetDistributedRateLimit).toHaveBeenCalledWith('signup:email:new@example.com');
    });

    it('continues signup even if verification email fails', async () => {
      (sendEmail as Mock).mockRejectedValue(new Error('SMTP error'));

      const request = createSignupRequest(validSignupPayload);
      const response = await POST(request);

      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toContain('/dashboard/new-drive-id');
    });

    it('continues signup even if drive provisioning fails', async () => {
      (provisionGettingStartedDriveIfNeeded as Mock).mockRejectedValue(
        new Error('Database error')
      );

      const request = createSignupRequest(validSignupPayload);
      const response = await POST(request);

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
      (db.query.users.findFirst as Mock).mockResolvedValue({
        id: 'existing-user-id',
        email: 'new@example.com',
      });

      const request = createSignupRequest(validSignupPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toBe('User with this email already exists');
    });

    it('logs failed signup for duplicate email', async () => {
      (getClientIP as Mock).mockReturnValue('192.168.1.1');
      (db.query.users.findFirst as Mock).mockResolvedValue({
        id: 'existing-user-id',
        email: 'new@example.com',
      });

      const request = createSignupRequest(validSignupPayload, {
        'x-forwarded-for': '192.168.1.1',
      });

      await POST(request);

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
      const payload = { ...validSignupPayload };
      // @ts-expect-error - intentionally testing invalid input
      delete payload.name;

      const request = createSignupRequest(payload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.name).toBeDefined();
    });

    it('returns 400 for invalid email format', async () => {
      const request = createSignupRequest({
        ...validSignupPayload,
        email: 'not-an-email',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.email).toBeDefined();
    });

    it('returns 400 for password shorter than 12 characters', async () => {
      const request = createSignupRequest({
        ...validSignupPayload,
        password: 'Short1!',
        confirmPassword: 'Short1!',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });

    it('returns 400 for password without uppercase', async () => {
      const request = createSignupRequest({
        ...validSignupPayload,
        password: 'validpass123!',
        confirmPassword: 'validpass123!',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });

    it('returns 400 for password without lowercase', async () => {
      const request = createSignupRequest({
        ...validSignupPayload,
        password: 'VALIDPASS123!',
        confirmPassword: 'VALIDPASS123!',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });

    it('returns 400 for password without number', async () => {
      const request = createSignupRequest({
        ...validSignupPayload,
        password: 'ValidPassword!',
        confirmPassword: 'ValidPassword!',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });

    it('returns 400 when passwords do not match', async () => {
      const request = createSignupRequest({
        ...validSignupPayload,
        confirmPassword: 'DifferentPass123!',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.confirmPassword).toBeDefined();
    });

    it('returns 400 when ToS not accepted', async () => {
      const request = createSignupRequest({
        ...validSignupPayload,
        acceptedTos: false,
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.acceptedTos).toBeDefined();
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when IP rate limit exceeded', async () => {
      (getClientIP as Mock).mockReturnValue('192.168.1.1');
      (checkDistributedRateLimit as Mock)
        .mockResolvedValueOnce({ allowed: false, retryAfter: 3600, attemptsRemaining: 0 })
        .mockResolvedValue({ allowed: true, attemptsRemaining: 2 });

      const request = createSignupRequest(validSignupPayload, {
        'x-forwarded-for': '192.168.1.1',
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

      const request = createSignupRequest(validSignupPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many signup attempts for this email');
    });

    it('logs rate limit failure', async () => {
      (getClientIP as Mock).mockReturnValue('192.168.1.1');
      (checkDistributedRateLimit as Mock).mockResolvedValue({ allowed: false, retryAfter: 3600, attemptsRemaining: 0 });

      const request = createSignupRequest(validSignupPayload, {
        'x-forwarded-for': '192.168.1.1',
      });

      await POST(request);

      expect(logAuthEvent).toHaveBeenCalledWith(
        'failed',
        undefined,
        'new@example.com',
        '192.168.1.1',
        'IP rate limit exceeded'
      );
    });
  });

  describe('distributed rate limiting', () => {
    it('calls checkDistributedRateLimit for IP and email', async () => {
      (getClientIP as Mock).mockReturnValue('192.168.1.100');

      const request = createSignupRequest(validSignupPayload, {
        'x-forwarded-for': '192.168.1.100',
      });

      await POST(request);

      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'signup:ip:192.168.1.100',
        DISTRIBUTED_RATE_LIMITS.SIGNUP
      );
      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'signup:email:new@example.com',
        DISTRIBUTED_RATE_LIMITS.SIGNUP
      );
    });

    it('returns 429 with X-RateLimit headers when distributed IP limit exceeded', async () => {
      (checkDistributedRateLimit as Mock)
        .mockResolvedValueOnce({ allowed: false, retryAfter: 3600, attemptsRemaining: 0 })
        .mockResolvedValue({ allowed: true, attemptsRemaining: 2 });

      const request = createSignupRequest(validSignupPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many signup attempts from this IP');
      expect(response.headers.get('Retry-After')).toBe('3600');
      expect(response.headers.get('X-RateLimit-Limit')).toBe('3');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    });

    it('returns 429 with X-RateLimit headers when distributed email limit exceeded', async () => {
      (checkDistributedRateLimit as Mock)
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 2 })
        .mockResolvedValueOnce({ allowed: false, retryAfter: 3600, attemptsRemaining: 0 });

      const request = createSignupRequest(validSignupPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many signup attempts for this email');
      expect(response.headers.get('X-RateLimit-Limit')).toBe('3');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    });

    it('resets distributed rate limits on successful signup', async () => {
      (getClientIP as Mock).mockReturnValue('192.168.1.100');

      const request = createSignupRequest(validSignupPayload, {
        'x-forwarded-for': '192.168.1.100',
      });

      await POST(request);

      expect(resetDistributedRateLimit).toHaveBeenCalledWith('signup:ip:192.168.1.100');
      expect(resetDistributedRateLimit).toHaveBeenCalledWith('signup:email:new@example.com');
    });

    it('uses correct rate limit key format (signup:ip and signup:email)', async () => {
      (getClientIP as Mock).mockReturnValue('10.0.0.1');

      const request = createSignupRequest(validSignupPayload, {
        'x-forwarded-for': '10.0.0.1',
      });

      await POST(request);

      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        expect.stringMatching(/^signup:ip:/),
        expect.any(Object)
      );
      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        expect.stringMatching(/^signup:email:/),
        expect.any(Object)
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected errors', async () => {
      (db.insert as Mock).mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      const request = createSignupRequest(validSignupPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred.');
    });
  });
});
