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
 * - Account lockout (lock check, record failed attempts, reset on success)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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

// Mock session service, CSRF generation, and account lockout from @pagespace/lib/auth
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
  isAccountLockedByEmail: vi.fn().mockResolvedValue({ isLocked: false, lockedUntil: null }),
  recordFailedLoginAttemptByEmail: vi.fn().mockResolvedValue({ success: true }),
  resetFailedLoginAttempts: vi.fn().mockResolvedValue(undefined),
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
  securityAudit: {
    logAuthSuccess: vi.fn().mockResolvedValue(undefined),
    logAuthFailure: vi.fn().mockResolvedValue(undefined),
    logTokenCreated: vi.fn().mockResolvedValue(undefined),
    logAccessDenied: vi.fn().mockResolvedValue(undefined),
  },
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

vi.mock('@pagespace/lib/audit', () => ({
  securityAudit: {
    logEvent: vi.fn().mockResolvedValue(undefined),
    logAuthSuccess: vi.fn().mockResolvedValue(undefined),
    logAuthFailure: vi.fn().mockResolvedValue(undefined),
    logTokenCreated: vi.fn().mockResolvedValue(undefined),
  },
  maskEmail: vi.fn((email: string) => {
    const [local, domain] = email.split('@');
    if (!local || !domain) return '***@***';
    const visibleChars = Math.min(2, local.length);
    return `${local.slice(0, visibleChars)}***@${domain}`;
  }),
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
  provisionGettingStartedDriveIfNeeded: vi.fn().mockResolvedValue({ driveId: 'existing-drive', created: false }),
}));

import { authRepository } from '@/lib/repositories/auth-repository';
import bcrypt from 'bcryptjs';
import {
  sessionService,
  generateCSRFToken,
  isAccountLockedByEmail,
  recordFailedLoginAttemptByEmail,
  resetFailedLoginAttempts,
} from '@pagespace/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { logAuthEvent } from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';
import { getClientIP } from '@/lib/auth';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { securityAudit } from '@pagespace/lib/audit';

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
  appleId: null,
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
  suspendedAt: null,
  suspendedReason: null,
  timezone: null,
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
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
    // Reset client IP mock
    vi.mocked(getClientIP).mockReturnValue('unknown');
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
      expect(appendSessionCookie).toHaveBeenCalledWith(expect.any(Headers), 'ps_sess_mock_session_token');
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
      vi.mocked(getClientIP).mockReturnValue('192.168.1.1');

      const request = createLoginRequest(validLoginPayload, {
        'x-forwarded-for': '192.168.1.1',
      });

      await POST(request);

      expect(resetDistributedRateLimit).toHaveBeenCalledWith('login:ip:192.168.1.1');
      expect(resetDistributedRateLimit).toHaveBeenCalledWith('login:email:test@example.com');
    });

    it('logs successful login event', async () => {
      vi.mocked(getClientIP).mockReturnValue('192.168.1.1');

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
      vi.mocked(authRepository.findUserByEmail).mockResolvedValue(null as never);
      vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

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
      vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

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
      vi.mocked(authRepository.findUserByEmail).mockResolvedValue(null as never);

      const request = createLoginRequest({
        email: 'nonexistent@example.com',
        password: 'anypassword',
      });
      await POST(request);

      expect(bcrypt.compare).toHaveBeenCalledWith('anypassword', expect.stringMatching(/^\$2[aby]?\$\d{1,2}\$[./A-Za-z0-9]{53}$/));
      const [password, hash] = vi.mocked(bcrypt.compare).mock.calls[0];
      expect(password).toBe('anypassword');
      // Verify a valid bcrypt hash was used (not null/undefined/empty)
      expect(hash).toBeTruthy();
      expect(typeof hash).toBe('string');
      expect(hash).toMatch(/^\$2[aby]?\$\d{1,2}\$[./A-Za-z0-9]{53}$/);
    });

    it('logs failed login attempt', async () => {
      vi.mocked(bcrypt.compare).mockResolvedValue(false as never);
      vi.mocked(getClientIP).mockReturnValue('192.168.1.1');

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
      vi.mocked(getClientIP).mockReturnValue('192.168.1.1');
      vi.mocked(checkDistributedRateLimit)
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
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 4 })
        .mockResolvedValueOnce({ allowed: false, retryAfter: 900, attemptsRemaining: 0 });

      const request = createLoginRequest(validLoginPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many login attempts for this email');
    });

    it('checks rate limits before database query', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: false, retryAfter: 900, attemptsRemaining: 0 });

      const request = createLoginRequest(validLoginPayload);
      await POST(request);

      // Database should not be queried when rate limited
      expect(authRepository.findUserByEmail).not.toHaveBeenCalled();
    });

    it('emits security audit event when IP rate limit triggers', async () => {
      vi.mocked(getClientIP).mockReturnValue('192.168.1.1');
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({ allowed: false, retryAfter: 900, attemptsRemaining: 0 })
        .mockResolvedValue({ allowed: true, attemptsRemaining: 4 });

      const request = createLoginRequest(validLoginPayload);
      await POST(request);

      expect(securityAudit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'security.rate.limited',
          ipAddress: '192.168.1.1',
          details: expect.objectContaining({
            limiter: 'ip',
            endpoint: '/api/auth/login',
          }),
          riskScore: 0.4,
        })
      );
    });

    it('emits security audit event when email rate limit triggers', async () => {
      vi.mocked(getClientIP).mockReturnValue('10.0.0.1');
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 4 })
        .mockResolvedValueOnce({ allowed: false, retryAfter: 900, attemptsRemaining: 0 });

      const request = createLoginRequest(validLoginPayload);
      await POST(request);

      expect(securityAudit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'security.rate.limited',
          ipAddress: '10.0.0.1',
          details: expect.objectContaining({
            limiter: 'email',
            endpoint: '/api/auth/login',
          }),
          riskScore: 0.4,
        })
      );
    });

    it('masks email in security audit event details', async () => {
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 4 })
        .mockResolvedValueOnce({ allowed: false, retryAfter: 900, attemptsRemaining: 0 });

      const request = createLoginRequest(validLoginPayload);
      await POST(request);

      expect(securityAudit.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            email: 'te***@example.com',
          }),
        })
      );
    });
  });

  describe('IP extraction', () => {
    it('extracts IP from x-forwarded-for header', async () => {
      vi.mocked(getClientIP).mockReturnValue('203.0.113.195');

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
      vi.mocked(getClientIP).mockReturnValue('192.168.1.100');

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
      vi.mocked(getClientIP).mockReturnValue('unknown');

      const request = createLoginRequest(validLoginPayload);
      await POST(request);

      expect(checkDistributedRateLimit).toHaveBeenCalledWith('login:ip:unknown', expect.any(Object));
    });
  });

  describe('error handling', () => {
    beforeEach(() => {
      // Reset rate limiting mock to allow requests
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: true,
        attemptsRemaining: 4,
        retryAfter: undefined,
      });
    });

    it('returns 500 on unexpected errors', async () => {
      vi.mocked(authRepository.findUserByEmail).mockRejectedValueOnce(
        new Error('Database connection failed')
      );

      const request = createLoginRequest(validLoginPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred.');
    });

    it('does not expose internal error details to client', async () => {
      vi.mocked(authRepository.findUserByEmail).mockRejectedValueOnce(
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
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
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
      vi.mocked(getClientIP).mockReturnValue('192.168.1.1');

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
      vi.mocked(getClientIP).mockReturnValue('192.168.1.1');
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
      vi.mocked(getClientIP).mockReturnValue('192.168.1.1');

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

  describe('account lockout', () => {
    it('returns 423 when account is locked', async () => {
      const lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
      vi.mocked(isAccountLockedByEmail).mockResolvedValueOnce({
        isLocked: true,
        lockedUntil,
      });

      const request = createLoginRequest(validLoginPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(423);
      expect(body.error).toMatch(/locked/i);
      expect(body.lockedUntil).toBeDefined();
    });

    it('does not attempt password validation when account is locked', async () => {
      vi.mocked(isAccountLockedByEmail).mockResolvedValueOnce({
        isLocked: true,
        lockedUntil: new Date(Date.now() + 15 * 60 * 1000),
      });

      const request = createLoginRequest(validLoginPayload);
      await POST(request);

      expect(authRepository.findUserByEmail).not.toHaveBeenCalled();
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    it('records failed login attempt on invalid credentials', async () => {
      vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

      const request = createLoginRequest({
        email: 'test@example.com',
        password: 'wrongpassword',
      });
      await POST(request);

      expect(recordFailedLoginAttemptByEmail).toHaveBeenCalledWith('test@example.com');
    });

    it('resets failed login attempts on successful login', async () => {
      const request = createLoginRequest(validLoginPayload);
      await POST(request);

      expect(resetFailedLoginAttempts).toHaveBeenCalledWith(mockUser.id);
    });

    it('does not record failed attempt for non-existent email', async () => {
      vi.mocked(authRepository.findUserByEmail).mockResolvedValue(null as never);
      vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

      const request = createLoginRequest({
        email: 'nonexistent@example.com',
        password: 'anypassword',
      });
      await POST(request);

      expect(recordFailedLoginAttemptByEmail).not.toHaveBeenCalled();
    });

    it('checks lockout after rate limiting passes', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: 900,
      });

      const request = createLoginRequest(validLoginPayload);
      await POST(request);

      // When rate-limited, lockout check should not be reached
      expect(isAccountLockedByEmail).not.toHaveBeenCalled();
    });
  });

  describe('CSRF validation', () => {
    beforeEach(() => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: true,
        attemptsRemaining: 4,
        retryAfter: undefined,
      });
    });

    it('returns 403 when CSRF header is missing', async () => {
      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': 'login_csrf=valid-csrf-token',
        },
        body: JSON.stringify(validLoginPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.code).toBe('LOGIN_CSRF_MISSING');
    });

    it('returns 403 when CSRF cookie is missing', async () => {
      // Mock parse to return empty cookies
      const { parse } = await import('cookie');
      vi.mocked(parse).mockReturnValueOnce({});

      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Login-CSRF-Token': 'valid-csrf-token',
        },
        body: JSON.stringify(validLoginPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.code).toBe('LOGIN_CSRF_MISSING');
    });

    it('returns 403 when CSRF header does not match cookie', async () => {
      const { parse } = await import('cookie');
      vi.mocked(parse).mockReturnValueOnce({ login_csrf: 'different-token' });

      const request = new Request('http://localhost/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Login-CSRF-Token': 'valid-csrf-token',
          'Cookie': 'login_csrf=different-token',
        },
        body: JSON.stringify(validLoginPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.code).toBe('LOGIN_CSRF_MISMATCH');
    });

    it('returns 403 when CSRF token validation fails', async () => {
      const { validateLoginCSRFToken } = await import('@/lib/auth');
      vi.mocked(validateLoginCSRFToken).mockReturnValueOnce(false);

      const request = createLoginRequest(validLoginPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.code).toBe('LOGIN_CSRF_INVALID');
    });
  });

  describe('session creation edge cases', () => {
    beforeEach(() => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: true,
        attemptsRemaining: 4,
        retryAfter: undefined,
      });
    });

    it('returns 500 when session validation fails after creation', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValueOnce(null);

      const request = createLoginRequest(validLoginPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create session.');
    });

    it('logs revoked sessions count when sessions exist', async () => {
      vi.mocked(sessionService.revokeAllUserSessions).mockResolvedValueOnce(3);

      const request = createLoginRequest(validLoginPayload);
      await POST(request);

      const { loggers } = await import('@pagespace/lib/server');
      expect(loggers.auth.info).toHaveBeenCalledWith(
        'Revoked existing sessions on login',
        expect.objectContaining({ userId: mockUser.id, count: 3 })
      );
    });

    it('logs warning when rate limit reset fails', async () => {
      vi.mocked(resetDistributedRateLimit).mockRejectedValueOnce(new Error('Redis down'));

      const request = createLoginRequest(validLoginPayload);
      await POST(request);

      const { loggers } = await import('@pagespace/lib/server');
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Rate limit reset failed after successful login',
        expect.objectContaining({ failureCount: expect.any(Number) })
      );
    });
  });

  describe('drive provisioning', () => {
    beforeEach(() => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: true,
        attemptsRemaining: 4,
        retryAfter: undefined,
      });
    });

    it('includes redirectTo when a new drive is provisioned', async () => {
      const { provisionGettingStartedDriveIfNeeded } = await import('@/lib/onboarding/getting-started-drive');
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockResolvedValueOnce({
        driveId: 'new-drive-123',
        created: true,
      });

      const request = createLoginRequest(validLoginPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.redirectTo).toBe('/dashboard/new-drive-123');
    });

    it('does not include redirectTo when drive already exists', async () => {
      const request = createLoginRequest(validLoginPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.redirectTo).toBeUndefined();
    });

    it('continues login when drive provisioning throws', async () => {
      const { provisionGettingStartedDriveIfNeeded } = await import('@/lib/onboarding/getting-started-drive');
      vi.mocked(provisionGettingStartedDriveIfNeeded).mockRejectedValueOnce(
        new Error('DB error')
      );

      const request = createLoginRequest(validLoginPayload);
      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });
});
