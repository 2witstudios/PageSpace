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

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { POST } from '../mobile/oauth/google/exchange/route';

// Mock dependencies
vi.mock('@pagespace/lib/server', () => ({
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
  },
  logAuthEvent: vi.fn(),
}));

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

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn().mockReturnValue('192.168.1.1'),
}));

import {
  verifyOAuthIdToken,
  createOrLinkOAuthUser,
  validateOrCreateDeviceToken,
  logAuthEvent,
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
    (checkDistributedRateLimit as Mock).mockResolvedValue({
      allowed: true,
      attemptsRemaining: 4,
      retryAfter: undefined,
    });
    (resetDistributedRateLimit as Mock).mockResolvedValue(undefined);
    (verifyOAuthIdToken as Mock).mockResolvedValue({
      success: true,
      userInfo: mockUserInfo,
    });
    (createOrLinkOAuthUser as Mock).mockResolvedValue(mockUser);
    (validateOrCreateDeviceToken as Mock).mockResolvedValue({
      deviceToken: 'mock-device-token',
    });
    (sessionService.createSession as Mock).mockResolvedValue('ps_sess_oauth-token');
    (sessionService.validateSession as Mock).mockResolvedValue({
      sessionId: 'sfh0haxfpzowht3oi213oas1',
      userId: 'ofh0haxfpzowht3oi213oau1',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });
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

      expect(createOrLinkOAuthUser).toHaveBeenCalledWith(mockUserInfo);
    });

    it('creates device token for mobile platform', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockUser.id,
          deviceId: 'ios-device-789',
          platform: 'ios',
          deviceName: 'iPhone 15 Pro Max',
        })
      );
    });

    it('logs OAuth login event', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      expect(logAuthEvent).toHaveBeenCalledWith(
        'login',
        mockUser.id,
        mockUser.email,
        '192.168.1.1',
        'Google OAuth Mobile'
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
        expect.objectContaining({
          provider: 'google',
          platform: 'ios',
          appVersion: '1.0.0',
        })
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

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: 'ios',
        })
      );
    });
  });

  describe('ID token verification', () => {
    it('returns 401 for invalid ID token', async () => {
      (verifyOAuthIdToken as Mock).mockResolvedValue({
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
      (verifyOAuthIdToken as Mock).mockResolvedValue({
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
      (verifyOAuthIdToken as Mock).mockResolvedValue({
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
      (verifyOAuthIdToken as Mock).mockResolvedValue({
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
        expect.objectContaining({
          provider: 'google',
          reason: 'Verification failed',
        })
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
      expect(body.errors.idToken).toBeDefined();
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
      expect(body.errors.deviceId).toBeDefined();
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
      expect(body.errors.platform).toBeDefined();
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
      expect(body.errors.idToken).toBeDefined();
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when IP rate limit exceeded', async () => {
      (checkDistributedRateLimit as Mock)
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
      (checkDistributedRateLimit as Mock)
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
      (checkDistributedRateLimit as Mock)
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
      (checkDistributedRateLimit as Mock).mockResolvedValue({
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

      expect(response.headers.get('X-RateLimit-Limit')).toBeDefined();
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

      expect(sessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockUser.id,
          expiresInMs: 90 * 24 * 60 * 60 * 1000,
          createdByService: 'mobile-oauth-google',
        })
      );
    });

    it('returns 500 when session validation fails', async () => {
      (sessionService.validateSession as Mock).mockResolvedValue(null);

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
      (verifyOAuthIdToken as Mock).mockRejectedValue(new Error('Network error'));

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
      (verifyOAuthIdToken as Mock).mockRejectedValue(new Error('Unexpected'));

      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      expect(trackAuthEvent).toHaveBeenCalledWith(
        undefined,
        'failed_oauth',
        expect.objectContaining({
          provider: 'google',
          error: 'Unexpected',
        })
      );
    });

    it('handles rate limit reset failures gracefully', async () => {
      (resetDistributedRateLimit as Mock).mockRejectedValue(new Error('Redis error'));

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
      (resetDistributedRateLimit as Mock).mockRejectedValue(new Error('Reset failed'));

      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Rate limit reset failed after successful OAuth',
        expect.any(Object)
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

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          providedDeviceToken: existingDeviceToken,
        })
      );
    });

    it('creates new device token if not provided', async () => {
      const request = new Request('http://localhost/api/auth/mobile/oauth/google/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validExchangePayload),
      });

      await POST(request);

      expect(validateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          providedDeviceToken: undefined,
        })
      );
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

      expect(body.user.picture).toBe(mockUser.image);
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
});
