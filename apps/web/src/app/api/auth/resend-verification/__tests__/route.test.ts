/**
 * Contract tests for POST /api/auth/resend-verification
 *
 * Coverage:
 * - Authentication requirement (session-based with CSRF)
 * - User not found
 * - Rate limiting by email
 * - Already verified email
 * - Verification token creation and email sending
 * - Rate limit error from email service
 * - Unexpected errors
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies BEFORE imports
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn().mockResolvedValue({
    userId: 'test-user-id',
    tokenType: 'session',
    sessionId: 'mock-session-id',
  }),
  isAuthError: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    findUserById: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/auth/verification-utils', () => ({
  createVerificationToken: vi.fn().mockResolvedValue('mock-verification-token'),
}));

vi.mock('@pagespace/lib/services/email-service', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@pagespace/lib/email-templates/VerificationEmail', () => ({
  VerificationEmail: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
      auth: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
      security: {
        warn: vi.fn(),
      },
    },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    attemptsRemaining: 2,
    retryAfter: undefined,
  }),
  DISTRIBUTED_RATE_LIMITS: {
    EMAIL_RESEND: { maxAttempts: 3, windowMs: 3600000, progressiveDelay: false },
  },
}));

vi.mock('react', () => ({
  default: {
    createElement: vi.fn().mockReturnValue({}),
  },
}));

import { POST } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { authRepository } from '@/lib/repositories/auth-repository';
import { createVerificationToken } from '@pagespace/lib/auth/verification-utils';
import { sendEmail } from '@pagespace/lib/services/email-service';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { NextResponse } from 'next/server';

const createResendRequest = () =>
  new Request('http://localhost/api/auth/resend-verification', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'valid-csrf',
      'Cookie': 'session=ps_sess_mock_token',
    },
  });

describe('POST /api/auth/resend-verification', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      WEB_APP_URL: 'https://example.com',
    };

    // Default: authenticated
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      userId: 'test-user-id',
      tokenType: 'session',
      sessionId: 'mock-session-id',
    } as never);

    // Default: user found with unverified email
    vi.mocked(authRepository.findUserById).mockResolvedValue({
      id: 'test-user-id',
      email: 'test@example.com',
      name: 'Test User',
      emailVerified: null,
    } as never);

    vi.mocked(checkDistributedRateLimit).mockResolvedValue({
      allowed: true,
      attemptsRemaining: 2,
      retryAfter: undefined,
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('authentication', () => {
    it('returns auth error when not authenticated', async () => {
      const mockErrorResponse = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
        error: mockErrorResponse,
      } as never);

      const response = await POST(createResendRequest());

      expect(response.status).toBe(401);
    });

    it('passes correct auth options', async () => {
      await POST(createResendRequest());

      expect(authenticateRequestWithOptions).toHaveBeenCalledTimes(1);
      expect(vi.mocked(authenticateRequestWithOptions).mock.calls[0][0]).toBeInstanceOf(Request);
      expect(vi.mocked(authenticateRequestWithOptions).mock.calls[0][1]).toEqual(
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('user lookup', () => {
    it('returns 404 when user not found', async () => {
      vi.mocked(authRepository.findUserById).mockResolvedValue(null);

      const response = await POST(createResendRequest());
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when email resend rate limit exceeded', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: 3600,
      });

      const response = await POST(createResendRequest());
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many verification emails');
      expect(response.headers.get('Retry-After')).toBe('3600');
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Email resend rate limit exceeded',
        { email: 'te***@example.com' }
      );
    });

    it('uses correct rate limit key with lowercase email', async () => {
      await POST(createResendRequest());

      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'email-resend:test@example.com',
        { maxAttempts: 3, windowMs: 3600000, progressiveDelay: false }
      );
    });

    it('uses default retryAfter of 3600 when retryAfter is undefined', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: undefined,
      });

      const response = await POST(createResendRequest());

      expect(response.headers.get('Retry-After')).toBe('3600');
    });
  });

  describe('already verified', () => {
    it('returns 400 when email is already verified', async () => {
      vi.mocked(authRepository.findUserById).mockResolvedValue({
        id: 'test-user-id',
        email: 'test@example.com',
        name: 'Test User',
        emailVerified: new Date(),
      } as never);

      const response = await POST(createResendRequest());
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Email is already verified');
    });
  });

  describe('successful verification email', () => {
    it('creates verification token and sends email', async () => {
      const response = await POST(createResendRequest());
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toContain('Verification email sent successfully');
      expect(authRepository.findUserById).toHaveBeenCalledWith('test-user-id');
      expect(createVerificationToken).toHaveBeenCalledWith({
        userId: 'test-user-id',
        type: 'email_verification',
      });
      const sendArgs = vi.mocked(sendEmail).mock.calls[0][0];
      expect(sendArgs.to).toBe('test@example.com');
      expect(sendArgs.subject).toBe('Verify your PageSpace email');
    });

    it('logs successful email resend', async () => {
      await POST(createResendRequest());

      expect(loggers.auth.info).toHaveBeenCalledWith(
        'Verification email resent',
        { userId: 'test-user-id', email: 'te***@example.com' }
      );
    });

    it('constructs correct verification URL', async () => {
      process.env.WEB_APP_URL = 'https://app.example.com';

      await POST(createResendRequest());

      const sendArgs = vi.mocked(sendEmail).mock.calls[0][0];
      expect(sendArgs.to).toBe('test@example.com');
    });

    it('uses NEXT_PUBLIC_APP_URL as fallback', async () => {
      delete process.env.WEB_APP_URL;
      process.env.NEXT_PUBLIC_APP_URL = 'https://public.example.com';

      const response = await POST(createResendRequest());

      expect(response.status).toBe(200);
    });

    it('uses localhost as final fallback', async () => {
      delete process.env.WEB_APP_URL;
      delete process.env.NEXT_PUBLIC_APP_URL;

      const response = await POST(createResendRequest());

      expect(response.status).toBe(200);
    });
  });

  describe('email rate limit from service', () => {
    it('returns 429 when email service throws rate limit error', async () => {
      vi.mocked(sendEmail).mockRejectedValueOnce(new Error('Too many emails sent'));

      const response = await POST(createResendRequest());
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toBe('Too many emails sent');
    });

    it('propagates other email errors as 500', async () => {
      vi.mocked(sendEmail).mockRejectedValueOnce(new Error('SMTP connection failed'));

      const response = await POST(createResendRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to send verification email');
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected errors', async () => {
      vi.mocked(authRepository.findUserById).mockRejectedValueOnce(new Error('Database down'));

      const response = await POST(createResendRequest());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to send verification email');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Error resending verification email',
        new Error('Database down')
      );
    });
  });
});
