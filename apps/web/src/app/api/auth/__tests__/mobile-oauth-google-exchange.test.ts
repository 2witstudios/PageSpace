/**
 * Mobile OAuth Google Exchange Route Tests
 *
 * Comprehensive test coverage for /api/auth/mobile/oauth/google/exchange:
 * - ID token verification
 * - User creation/linking
 * - Device token management
 * - Dual rate limiting (IP + email + OAuth verification)
 * - CSRF token generation
 * - Error handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '../mobile/oauth/google/exchange/route';

// Mock dependencies
vi.mock('@pagespace/lib/server', async () => {
  const { maskEmail } = await vi.importActual<typeof import('@pagespace/lib/audit/mask-email')>(
    '@pagespace/lib/audit/mask-email'
  );
  return {
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
  validateOrCreateDeviceToken: vi.fn().mockResolvedValue({
    deviceToken: 'mock-device-token',
  }),
  verifyOAuthIdToken: vi.fn(),
  createOrLinkOAuthUser: vi.fn(),
  OAuthProvider: {
    GOOGLE: 'google',
    APPLE: 'apple',
  },
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
  auditRequest: vi.fn(),
  maskEmail,
  };
});

vi.mock('@pagespace/lib/auth', () => ({
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_oauth-token'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'sfh0haxfpzowht3oi213oas1',
      userId: 'ofh0haxfpzowht3oi213oau1',
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
    attemptsRemaining: 4,
    retryAfter: undefined,
  }),
  resetDistributedRateLimit: vi.fn().mockResolvedValue(undefined),
  DISTRIBUTED_RATE_LIMITS: {
    LOGIN: { maxAttempts: 5, windowMs: 900000, progressiveDelay: true },
    SIGNUP: { maxAttempts: 3, windowMs: 3600000, progressiveDelay: false },
    REFRESH: { maxAttempts: 10, windowMs: 300000, progressiveDelay: false },
    OAUTH_VERIFY: { maxAttempts: 10, windowMs: 300000, progressiveDelay: false },
  },
}));

vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    updateUser: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/auth/google-avatar', () => ({
  resolveGoogleAvatarImage: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  createSessionCookie: vi.fn().mockReturnValue('mock-session-cookie'),
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn().mockReturnValue('192.168.1.1'),
}));

import {
  verifyOAuthIdToken,
  createOrLinkOAuthUser,
  validateOrCreateDeviceToken,
  auditRequest,
  loggers,
} from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { sessionService } from '@pagespace/lib/auth';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';

describe('/api/auth/mobile/oauth/google/exchange', () => {
  const mockUserInfo = {
    provider: 'google',
    providerId: 'google-123456',
    email: 'oauth@example.com',
    emailVerified: true,
    name: 'OAuth User',
    picture: 'https://example.com/avatar.png',
  };

  const mockUser = {
    id: 'ofh0haxfpzowht3oi213oau1',
    email: 'oauth@example.com',
    name: 'OAuth User',
    image: 'https://example.com/avatar.png',
    tokenVersion: 0,
    role: 'user' as const,
    provider: 'google',
  };

  const validExchangePayload = {
    idToken: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.valid-google-id-token',
    deviceId: 'ios-device-789',
    platform: 'ios' as const,
    deviceName: 'iPhone 15 Pro Max',
    appVersion: '1.0.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset all mocks to their default implementations
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({
      allowed: true,
      attemptsRemaining: 4,
      retryAfter: undefined,
    });
    vi.mocked(resetDistributedRateLimit).mockResolvedValue(undefined);
    vi.mocked(verifyOAuthIdToken).mockResolvedValue({
      success: true,
      userInfo: mockUserInfo,
    } as never);
    vi.mocked(createOrLinkOAuthUser).mockResolvedValue(mockUser as never);
    vi.mocked(validateOrCreateDeviceToken).mockResolvedValue({
      deviceToken: 'mock-device-token',
    } as never);
    vi.mocked(sessionService.createSession).mockResolvedValue('ps_sess_oauth-token');
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      sessionId: 'sfh0haxfpzowht3oi213oas1',
      userId: 'ofh0haxfpzowht3oi213oau1',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    } as never);
  });

  describe('successful OAuth exchange', () => {
    it('returns 200 with user data and tokens', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.user.id).toBe(mockUser.id);
      expect(body.user.email).toBe(mockUser.email);
      expect(body.user.name).toBe(mockUser.name);
      expect(body.user.provider).toBe('google');
      expect(body.sessionToken).toBe('ps_sess_oauth-token');
      expect(body.csrfToken).toBe('mock-csrf-token');
      expect(body.deviceToken).toBe('mock-device-token');
    });

    it('verifies Google ID token', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      expect(verifyOAuthIdToken).toHaveBeenCalledWith(
        'google',
        validExchangePayload.idToken
      );
    });

    it('creates or links OAuth user', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      expect(createOrLinkOAuthUser).toHaveBeenCalledWith({
        ...mockUserInfo,
        picture: undefined,
      });
    });

    it('creates device token for mobile platform', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith({
        providedDeviceToken: undefined,
        userId: mockUser.id,
        deviceId: 'ios-device-789',
        platform: 'ios',
        tokenVersion: 0,
        deviceName: 'iPhone 15 Pro Max',
        userAgent: undefined,
        ipAddress: '192.168.1.1',
      });
    });

    it('logs OAuth login event', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'auth.login.success',
          userId: mockUser.id,
          sessionId: 'sfh0haxfpzowht3oi213oas1',
          details: { method: 'Google OAuth Mobile' },
        })
      );
    });

    it('tracks OAuth login event', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      expect(trackAuthEvent).toHaveBeenCalledWith(
        mockUser.id,
        'login',
        {
          email: 'oauth@example.com',
          ip: '192.168.1.1',
          provider: 'google',
          userAgent: null,
          platform: 'ios',
          appVersion: '1.0.0',
        }
      );
    });

    it('resets all rate limits on success', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      expect(resetDistributedRateLimit).toHaveBeenCalledWith(
        'oauth:exchange:ip:192.168.1.1'
      );
      expect(resetDistributedRateLimit).toHaveBeenCalledWith(
        'oauth:exchange:verify:192.168.1.1'
      );
      expect(resetDistributedRateLimit).toHaveBeenCalledWith(
        `oauth:exchange:email:${mockUserInfo.email.toLowerCase()}`
      );
    });
  });

  describe('platform support', () => {
    it('supports iOS platform', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validExchangePayload, platform: 'ios' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
    });

    it('supports Android platform', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validExchangePayload, platform: 'android' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
    });

    it('supports desktop platform', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validExchangePayload, platform: 'desktop' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
    });

    it('defaults platform to ios', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken: validExchangePayload.idToken,
          deviceId: validExchangePayload.deviceId,
        }),
      });

      await POST(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith({
        providedDeviceToken: undefined,
        userId: mockUser.id,
        deviceId: 'ios-device-789',
        platform: 'ios',
        tokenVersion: 0,
        deviceName: undefined,
        userAgent: undefined,
        ipAddress: '192.168.1.1',
      });
    });
  });

  describe('ID token verification', () => {
    it('returns 401 for invalid ID token', async () => {
      vi.mocked(verifyOAuthIdToken).mockResolvedValue({
        success: false,
        error: 'Invalid token signature',
      });

      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid token signature');
    });

    it('returns 401 for expired ID token', async () => {
      vi.mocked(verifyOAuthIdToken).mockResolvedValue({
        success: false,
        error: 'Token expired',
      });

      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Token expired');
    });

    it('returns 401 for wrong audience in ID token', async () => {
      vi.mocked(verifyOAuthIdToken).mockResolvedValue({
        success: false,
        error: 'Invalid audience',
      });

      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid audience');
    });

    it('tracks failed OAuth attempt on verification failure', async () => {
      vi.mocked(verifyOAuthIdToken).mockResolvedValue({
        success: false,
        error: 'Verification failed',
      });

      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      expect(trackAuthEvent).toHaveBeenCalledWith(
        undefined,
        'failed_oauth',
        {
          provider: 'google',
          reason: 'Verification failed',
          ip: '192.168.1.1',
          platform: 'ios',
        }
      );
    });
  });

  describe('input validation', () => {
    it('returns 400 for missing idToken', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'device-123',
          platform: 'ios',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.idToken).toEqual(['Invalid input: expected string, received undefined']);
    });

    it('returns 400 for missing deviceId', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken: 'some-token',
          platform: 'ios',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.deviceId).toEqual(['Invalid input: expected string, received undefined']);
    });

    it('returns 400 for invalid platform', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validExchangePayload,
          platform: 'windows',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.platform).toEqual(['Invalid option: expected one of "ios"|"android"|"desktop"']);
    });

    it('returns 400 for empty idToken', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validExchangePayload,
          idToken: '',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.idToken).toEqual(['ID token is required']);
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when IP rate limit exceeded', async () => {
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({ allowed: false, retryAfter: 900, attemptsRemaining: 0 })
        .mockResolvedValue({ allowed: true, attemptsRemaining: 4 });

      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many authentication attempts');
      expect(response.headers.get('Retry-After')).toBe('900');
    });

    it('returns 429 when OAuth verification rate limit exceeded', async () => {
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 4 }) // IP check
        .mockResolvedValueOnce({ allowed: false, retryAfter: 300, attemptsRemaining: 0 }); // OAuth verify check

      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many OAuth verification attempts');
    });

    it('returns 429 when email rate limit exceeded', async () => {
      vi.mocked(checkDistributedRateLimit)
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 4 }) // IP check
        .mockResolvedValueOnce({ allowed: true, attemptsRemaining: 9 }) // OAuth verify check
        .mockResolvedValueOnce({ allowed: false, retryAfter: 900, attemptsRemaining: 0 }); // Email check

      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many authentication attempts for this email');
    });

    it('includes X-RateLimit headers on rate limit response', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        retryAfter: 900,
        attemptsRemaining: 0,
      });

      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      const response = await POST(request);

      expect(response.headers.get('X-RateLimit-Limit')).toBe('5');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    });

    it('checks all three rate limits in sequence', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'oauth:exchange:ip:192.168.1.1',
        DISTRIBUTED_RATE_LIMITS.LOGIN
      );
      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'oauth:exchange:verify:192.168.1.1',
        DISTRIBUTED_RATE_LIMITS.OAUTH_VERIFY
      );
      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        `oauth:exchange:email:${mockUserInfo.email.toLowerCase()}`,
        DISTRIBUTED_RATE_LIMITS.LOGIN
      );
    });
  });

  describe('session creation', () => {
    it('creates 90-day session for mobile OAuth', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      expect(sessionService.createSession).toHaveBeenCalledWith({
        userId: mockUser.id,
        type: 'user',
        scopes: ['*'],
        expiresInMs: 90 * 24 * 60 * 60 * 1000,
        createdByService: 'mobile-oauth-google',
        createdByIp: '192.168.1.1',
      });
    });

    it('returns 500 when session validation fails', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(null as never);

      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to generate session');
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected error', async () => {
      vi.mocked(verifyOAuthIdToken).mockRejectedValueOnce(new Error('Network error'));

      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred during authentication.');
    });

    it('tracks failed OAuth on unexpected error', async () => {
      vi.mocked(verifyOAuthIdToken).mockRejectedValueOnce(new Error('Unexpected'));

      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      expect(trackAuthEvent).toHaveBeenCalledWith(
        undefined,
        'failed_oauth',
        {
          provider: 'google',
          error: 'Unexpected',
          platform: 'ios',
        }
      );
    });

    it('handles rate limit reset failures gracefully', async () => {
      vi.mocked(resetDistributedRateLimit).mockRejectedValueOnce(new Error('Redis error'));

      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      const response = await POST(request);

      // Should still succeed even if rate limit reset fails
      expect(response.status).toBe(200);
    });

    it('logs rate limit reset failures', async () => {
      const { loggers } = await import('@pagespace/lib/server');
      vi.mocked(resetDistributedRateLimit).mockRejectedValueOnce(new Error('Reset failed'));

      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Rate limit reset failed after successful OAuth',
        { failureCount: 1, reasons: ['Reset failed'] }
      );
    });
  });

  describe('device token handling', () => {
    it('uses existing device token if provided', async () => {
      const existingDeviceToken = 'dt_existing-token';

      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validExchangePayload,
          deviceToken: existingDeviceToken,
        }),
      });

      await POST(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith({
        providedDeviceToken: existingDeviceToken,
        userId: mockUser.id,
        deviceId: 'ios-device-789',
        platform: 'ios',
        tokenVersion: 0,
        deviceName: 'iPhone 15 Pro Max',
        userAgent: undefined,
        ipAddress: '192.168.1.1',
      });
    });

    it('creates new device token if not provided', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith({
        providedDeviceToken: undefined,
        userId: mockUser.id,
        deviceId: 'ios-device-789',
        platform: 'ios',
        tokenVersion: 0,
        deviceName: 'iPhone 15 Pro Max',
        userAgent: undefined,
        ipAddress: '192.168.1.1',
      });
    });
  });

  describe('response format', () => {
    it('returns user with picture field from OAuth', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(body.user.picture).toBeNull();
    });

    it('returns user role', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(body.user.role).toBe('user');
    });

    it('does not return refresh token (device-token-only pattern)', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(body.refreshToken).toBeUndefined();
    });
  });

  describe('PII scrub in log metadata', () => {
    const findInfoCall = (msg: string) =>
      vi.mocked(loggers.auth.info).mock.calls.find(call => call[0] === msg);

    it('masks email in "Google ID token verified" log', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      const call = findInfoCall('Google ID token verified');
      expect(call).toBeDefined();
      const meta = call?.[1] as { email?: string };
      expect(meta.email).toBe('oa***@example.com');
    });

    it('masks email in "Creating or linking OAuth user" log', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      const call = findInfoCall('Creating or linking OAuth user');
      expect(call).toBeDefined();
      const meta = call?.[1] as { email?: string };
      expect(meta.email).toBe('oa***@example.com');
    });

    it('masks email in "OAuth user created/linked" log', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      const call = findInfoCall('OAuth user created/linked');
      expect(call).toBeDefined();
      const meta = call?.[1] as { email?: string };
      expect(meta.email).toBe('oa***@example.com');
    });
  });
});
