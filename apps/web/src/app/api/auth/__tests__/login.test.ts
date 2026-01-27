/**
 * Contract tests for POST /api/auth/login
 *
 * These tests verify the Request → Response contract and boundary obligations.
 * Database operations are mocked at the repository seam (not ORM chains).
 *
 * Coverage:
 * - Authentication (valid/invalid credentials)
 * - Validation (email, password)
 * - Rate limiting (IP, email)
 * - Security (timing-safe comparison, no sensitive data leakage)
 * - Session management (session-based auth with opaque tokens)
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { POST } from '../login/route';
import type { User } from '@/lib/repositories/auth-repository';

// Mock the repository seam (boundary) - NOT the ORM chains
vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    findUserByEmail: vi.fn(),
  },
}));

// Mock bcrypt (external boundary)
vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn(),
  },
}));

// Mock session service and CSRF generation from @pagespace/lib/auth
vi.mock('@pagespace/lib/auth', () => ({
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock_session_token'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'mock-session-id',
      userId: 'test-user-id',
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
  SESSION_DURATION_MS: 7 * 24 * 60 * 60 * 1000,
}));

// Mock cookie utilities
vi.mock('@/lib/auth/cookie-config', () => ({
  appendSessionCookie: vi.fn(),
  appendClearCookies: vi.fn(),
  getSessionFromCookies: vi.fn().mockReturnValue('ps_sess_mock_session_token'),
}));

// Mock server utilities
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
  logSecurityEvent: vi.fn(),
}));

// Mock distributed rate limiting (P1-T5)
vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    attemptsRemaining: 4,
    retryAfter: undefined,
  }),
  resetDistributedRateLimit: vi.fn().mockResolvedValue(undefined),
  DISTRIBUTED_RATE_LIMITS: {
    LOGIN: { maxAttempts: 5, windowMs: 900000, progressiveDelay: true },
    SIGNUP: { maxAttempts: 3, windowMs: 3600000, progressiveDelay: false },
    REFRESH: { maxAttempts: 10, windowMs: 300000, progressiveDelay: false },
  },
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
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
  provisionGettingStartedDriveIfNeeded: vi.fn().mockResolvedValue(null),
}));

import { authRepository } from '@/lib/repositories/auth-repository';
import bcrypt from 'bcryptjs';
import { sessionService, generateCSRFToken } from '@pagespace/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { getClientIP } from '@/lib/auth';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';

// Test fixtures
const mockUser: User = {
  id: 'test-user-id',
  email: 'test@example.com',
  name: 'Test User',
  password: '$2a$12$hashedpassword',
  tokenVersion: 0,
  adminRoleVersion: 0,
  role: 'user',
  provider: 'email',
  image: null,
  googleId: null,
  emailVerified: null,
  currentAiProvider: 'pagespace',
  currentAiModel: 'glm-4.5-air',
  storageUsedBytes: 0,
  activeUploads: 0,
  lastStorageCalculated: null,
  stripeCustomerId: null,
  subscriptionTier: 'free',
  tosAcceptedAt: null,
  failedLoginAttempts: 0,
  lockedUntil: null,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
};

const validLoginPayload = {
  email: 'test@example.com',
  password: 'validPassword123',
};

// Helper function to create requests with CSRF headers
const createLoginRequest = (
  payload: Record<string, unknown>,
  additionalHeaders: Record<string, string> = {}
) => {
  return new Request('http://localhost/api/auth/login', {
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

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mocks for successful login
    vi.mocked(authRepository.findUserByEmail).mockResolvedValue(mockUser);
    (bcrypt.compare as Mock).mockResolvedValue(true);
    // Reset client IP mock
    (getClientIP as Mock).mockReturnValue('unknown');
  });

  describe('successful login', () => {
    it('returns 200 and user data on successful login', async () => {
      const request = createLoginRequest(validLoginPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.id).toBe(mockUser.id);
      expect(body.name).toBe(mockUser.name);
      expect(body.email).toBe(mockUser.email);
      expect(body.csrfToken).toBe('mock-csrf-token');
    });

    it('creates session and sets session cookie', async () => {
      const request = createLoginRequest(validLoginPayload);
      await POST(request);

      // Verify session creation
      expect(sessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockUser.id,
          type: 'user',
          scopes: ['*'],
        })
      );

      // Verify session cookie is set
      expect(appendSessionCookie).toHaveBeenCalled();
    });

    it('generates CSRF token bound to session', async () => {
      const request = createLoginRequest(validLoginPayload);
      await POST(request);

      // Verify CSRF token is generated with session ID
      expect(sessionService.validateSession).toHaveBeenCalledWith('ps_sess_mock_session_token');
      expect(generateCSRFToken).toHaveBeenCalledWith('mock-session-id');
    });

    it('revokes existing sessions on login (session fixation prevention)', async () => {
      const request = createLoginRequest(validLoginPayload);
      await POST(request);

      expect(sessionService.revokeAllUserSessions).toHaveBeenCalledWith(mockUser.id, 'new_login');
    });

    it('resets rate limits on successful login', async () => {
      (getClientIP as Mock).mockReturnValue('192.168.1.1');

      const request = createLoginRequest(validLoginPayload, {
        'x-forwarded-for': '192.168.1.1',
      });

      await POST(request);

      expect(resetDistributedRateLimit).toHaveBeenCalledWith('login:ip:192.168.1.1');
      expect(resetDistributedRateLimit).toHaveBeenCalledWith('login:email:test@example.com');
    });

    it('logs successful login event', async () => {
      (getClientIP as Mock).mockReturnValue('192.168.1.1');

      const request = createLoginRequest(validLoginPayload, {
        'x-forwarded-for': '192.168.1.1',
      });

      await POST(request);

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
  });

  describe('invalid credentials', () => {
    it('returns 401 for non-existent email', async () => {
      vi.mocked(authRepository.findUserByEmail).mockResolvedValue(null);
      (bcrypt.compare as Mock).mockResolvedValue(false);

      const request = createLoginRequest({
        email: 'nonexistent@example.com',
        password: 'anypassword',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid email or password');
    });

    it('returns 401 for incorrect password', async () => {
      (bcrypt.compare as Mock).mockResolvedValue(false);

      const request = createLoginRequest({
        email: 'test@example.com',
        password: 'wrongpassword',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid email or password');
    });

    it('performs timing-safe comparison even for non-existent users', async () => {
      // Security property: bcrypt.compare must be called even for non-existent users
      // This prevents timing attacks that could reveal user existence
      vi.mocked(authRepository.findUserByEmail).mockResolvedValue(null);

      const request = createLoginRequest({
        email: 'nonexistent@example.com',
        password: 'anypassword',
      });
      await POST(request);

      expect(bcrypt.compare).toHaveBeenCalled();
      const [password, hash] = (bcrypt.compare as Mock).mock.calls[0];
      expect(password).toBe('anypassword');
      // Verify a valid bcrypt hash was used (not null/undefined/empty)
      expect(hash).toBeTruthy();
      expect(typeof hash).toBe('string');
      expect(hash).toMatch(/^\$2[aby]?\$\d{1,2}\$[./A-Za-z0-9]{53}$/);
    });

    it('logs failed login attempt', async () => {
      (bcrypt.compare as Mock).mockResolvedValue(false);
      (getClientIP as Mock).mockReturnValue('192.168.1.1');

      const request = createLoginRequest({
        email: 'test@example.com',
        password: 'wrongpassword',
      }, {
        'x-forwarded-for': '192.168.1.1',
      });

      await POST(request);

      expect(logAuthEvent).toHaveBeenCalledWith(
        'failed',
        mockUser.id,
        mockUser.email,
        '192.168.1.1',
        'Invalid password'
      );
    });

    it('returns 401 for OAuth-only user (no password set)', async () => {
      vi.mocked(authRepository.findUserByEmail).mockResolvedValue({
        ...mockUser,
        password: null, // OAuth user has no password
      });

      const request = createLoginRequest(validLoginPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid email or password');
    });
  });

  describe('input validation', () => {
    it('returns 400 for missing email', async () => {
      const request = createLoginRequest({ password: 'somepassword' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.email).toBeDefined();
    });

    it('returns 400 for invalid email format', async () => {
      const request = createLoginRequest({ email: 'not-an-email', password: 'somepassword' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.email).toBeDefined();
    });

    it('returns 400 for missing password', async () => {
      const request = createLoginRequest({ email: 'test@example.com' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });

    it('returns 400 for empty password', async () => {
      const request = createLoginRequest({ email: 'test@example.com', password: '' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when IP rate limit exceeded', async () => {
      (getClientIP as Mock).mockReturnValue('192.168.1.1');
      (checkDistributedRateLimit as Mock)
        .mockResolvedValueOnce({ allowed: false, retryAfter: 900, attemptsRemaining: 0 })
        .mockResolvedValue({ allowed: true, attemptsRemaining: 4 });

      const request = createLoginRequest(validLoginPayload, {
        'x-forwarded-for': '192.168.1.1',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many login attempts from this IP');
      expect(response.headers.get('Retry-After')).toBe('900');
    });

    it('returns 429 when email rate limit exceeded', async () => {
      (checkDistributedRateLimit as Mock)
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 4 })
        .mockResolvedValueOnce({ allowed: false, retryAfter: 900, attemptsRemaining: 0 });

      const request = createLoginRequest(validLoginPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many login attempts for this email');
    });

    it('checks rate limits before database query', async () => {
      (checkDistributedRateLimit as Mock).mockResolvedValue({ allowed: false, retryAfter: 900, attemptsRemaining: 0 });

      const request = createLoginRequest(validLoginPayload);
      await POST(request);

      // Database should not be queried when rate limited
      expect(authRepository.findUserByEmail).not.toHaveBeenCalled();
    });
  });

  describe('IP extraction', () => {
    it('extracts IP from x-forwarded-for header', async () => {
      (getClientIP as Mock).mockReturnValue('203.0.113.195');

      const request = createLoginRequest(validLoginPayload, {
        'x-forwarded-for': '203.0.113.195, 70.41.3.18, 150.172.238.178',
      });

      await POST(request);

      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'login:ip:203.0.113.195',
        expect.any(Object)
      );
    });

    it('extracts IP from x-real-ip header when x-forwarded-for is missing', async () => {
      (getClientIP as Mock).mockReturnValue('192.168.1.100');

      const request = createLoginRequest(validLoginPayload, {
        'x-real-ip': '192.168.1.100',
      });

      await POST(request);

      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'login:ip:192.168.1.100',
        expect.any(Object)
      );
    });

    it('uses "unknown" as fallback IP when headers are missing', async () => {
      (getClientIP as Mock).mockReturnValue('unknown');

      const request = createLoginRequest(validLoginPayload);
      await POST(request);

      expect(checkDistributedRateLimit).toHaveBeenCalledWith('login:ip:unknown', expect.any(Object));
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      // Reset rate limiting mock to allow requests
      (checkDistributedRateLimit as Mock).mockResolvedValue({
        allowed: true,
        attemptsRemaining: 4,
        retryAfter: undefined,
      });
    });

    it('returns 500 on unexpected errors', async () => {
      vi.mocked(authRepository.findUserByEmail).mockRejectedValue(
        new Error('Database connection failed')
      );

      const request = createLoginRequest(validLoginPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred.');
    });

    it('does not expose internal error details to client', async () => {
      vi.mocked(authRepository.findUserByEmail).mockRejectedValue(
        new Error('Sensitive database error: connection string leaked')
      );

      const request = createLoginRequest(validLoginPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(body.error).not.toContain('Sensitive');
      expect(body.error).not.toContain('connection string');
    });
  });

  describe('case sensitivity', () => {
    beforeEach(() => {
      // Reset rate limiting mock to allow requests
      (checkDistributedRateLimit as Mock).mockResolvedValue({
        allowed: true,
        attemptsRemaining: 4,
        retryAfter: undefined,
      });
    });

    it('normalizes email to lowercase for rate limiting', async () => {
      const request = createLoginRequest({
        email: 'TEST@EXAMPLE.COM',
        password: 'validPassword123',
      });

      await POST(request);

      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'login:email:test@example.com',
        expect.any(Object)
      );
    });
  });

  describe('distributed rate limiting', () => {
    beforeEach(() => {
      // Default: distributed rate limiting allows requests
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: true,
        attemptsRemaining: 4,
        retryAfter: undefined,
      });
    });

    it('calls checkDistributedRateLimit for IP', async () => {
      (getClientIP as Mock).mockReturnValue('192.168.1.1');

      const request = createLoginRequest(validLoginPayload, {
        'x-forwarded-for': '192.168.1.1',
      });

      await POST(request);

      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        expect.stringContaining('192.168.1.1'),
        DISTRIBUTED_RATE_LIMITS.LOGIN
      );
    });

    it('calls checkDistributedRateLimit for email', async () => {
      const request = createLoginRequest(validLoginPayload);

      await POST(request);

      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        expect.stringContaining('test@example.com'),
        DISTRIBUTED_RATE_LIMITS.LOGIN
      );
    });

    it('returns 429 with X-RateLimit headers when IP rate limit exceeded', async () => {
      (getClientIP as Mock).mockReturnValue('192.168.1.1');
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({
          allowed: false,
          attemptsRemaining: 0,
          retryAfter: 900,
        })
        .mockResolvedValue({
          allowed: true,
          attemptsRemaining: 4,
          retryAfter: undefined,
        });

      const request = createLoginRequest(validLoginPayload, {
        'x-forwarded-for': '192.168.1.1',
      });

      const response = await POST(request);

      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBeTruthy();
      expect(response.headers.get('X-RateLimit-Limit')).toBeTruthy();
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    });

    it('returns 429 with X-RateLimit headers when email rate limit exceeded', async () => {
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({
          allowed: true,
          attemptsRemaining: 4,
          retryAfter: undefined,
        })
        .mockResolvedValueOnce({
          allowed: false,
          attemptsRemaining: 0,
          retryAfter: 900,
        });

      const request = createLoginRequest(validLoginPayload);

      const response = await POST(request);

      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBeTruthy();
    });

    it('calls resetDistributedRateLimit on successful login', async () => {
      (getClientIP as Mock).mockReturnValue('192.168.1.1');

      const request = createLoginRequest(validLoginPayload, {
        'x-forwarded-for': '192.168.1.1',
      });

      await POST(request);

      expect(resetDistributedRateLimit).toHaveBeenCalledWith(
        expect.stringContaining('192.168.1.1')
      );
      expect(resetDistributedRateLimit).toHaveBeenCalledWith(
        expect.stringContaining('test@example.com')
      );
    });

    it('includes X-RateLimit headers in successful responses', async () => {
      const request = createLoginRequest(validLoginPayload);

      const response = await POST(request);

      expect(response.status).toBe(200);
      // After P1-T5 implementation, these headers should be present
      expect(response.headers.get('X-RateLimit-Limit')).toBeTruthy();
      expect(response.headers.get('X-RateLimit-Remaining')).toBeTruthy();
    });
  });
});
