/**
 * Mobile Refresh Route Tests
 *
 * Comprehensive test coverage for /api/auth/mobile/refresh:
 * - Device token validation
 * - Session token renewal
 * - Device token rotation
 * - Rate limiting
 * - Error handling
 * - Device ID verification
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { POST } from '../mobile/refresh/route';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  users: { id: 'id' },
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
  },
  eq: vi.fn((field: string, value: string) => ({ field, value })),
}));

vi.mock('@pagespace/db/transactions/auth-transactions', () => ({
  atomicDeviceTokenRotation: vi.fn().mockResolvedValue({
    success: true,
    newToken: 'new-device-token',
    deviceTokenId: 'dfh0haxfpzowht3oi213dtk1',
  }),
}));

vi.mock('@pagespace/lib/server', () => ({
  validateDeviceToken: vi.fn(),
  updateDeviceTokenActivity: vi.fn().mockResolvedValue(undefined),
  generateDeviceToken: vi.fn().mockReturnValue('new-device-token'),
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/lib/auth', () => ({
  hashToken: vi.fn((token) => `hashed-${token}`),
  getTokenPrefix: vi.fn((token) => token.substring(0, 8)),
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_refreshed-token'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'nfh0haxfpzowht3oi213ses2',
      userId: 'rfh0haxfpzowht3oi213ref1',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    }),
  },
}));

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    attemptsRemaining: 9,
    retryAfter: undefined,
  }),
  resetDistributedRateLimit: vi.fn().mockResolvedValue(undefined),
  DISTRIBUTED_RATE_LIMITS: {
    LOGIN: { maxAttempts: 5, windowMs: 900000, progressiveDelay: true },
    SIGNUP: { maxAttempts: 3, windowMs: 3600000, progressiveDelay: false },
    REFRESH: { maxAttempts: 10, windowMs: 300000, progressiveDelay: false },
  },
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn().mockReturnValue('192.168.1.1'),
}));

import { db } from '@pagespace/db';
import { atomicDeviceTokenRotation } from '@pagespace/db/transactions/auth-transactions';
import {
  validateDeviceToken,
  updateDeviceTokenActivity,
} from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { sessionService } from '@pagespace/lib/auth';
import { getClientIP } from '@/lib/auth';

describe('/api/auth/mobile/refresh', () => {
  const mockUser = {
    id: 'rfh0haxfpzowht3oi213ref1',
    tokenVersion: 0,
    role: 'user' as const,
  };

  const mockDeviceRecord = {
    id: 'dfh0haxfpzowht3oi213dtk1',
    userId: 'rfh0haxfpzowht3oi213ref1',
    deviceId: 'ios-device-123',
    platform: 'ios',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
  };

  const validRefreshPayload = {
    deviceToken: 'dt_valid-device-token',
    deviceId: 'ios-device-123',
    platform: 'ios' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset all mocks to their default implementations
    (checkDistributedRateLimit as Mock).mockResolvedValue({
      allowed: true,
      attemptsRemaining: 9,
      retryAfter: undefined,
    });
    (resetDistributedRateLimit as Mock).mockResolvedValue(undefined);
    (validateDeviceToken as Mock).mockResolvedValue(mockDeviceRecord);
    (db.query.users.findFirst as Mock).mockResolvedValue(mockUser);
    (updateDeviceTokenActivity as Mock).mockResolvedValue(undefined);
    (sessionService.createSession as Mock).mockResolvedValue('ps_sess_refreshed-token');
    (sessionService.validateSession as Mock).mockResolvedValue({
      sessionId: 'nfh0haxfpzowht3oi213ses2',
      userId: 'rfh0haxfpzowht3oi213ref1',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });
    (atomicDeviceTokenRotation as Mock).mockResolvedValue({
      success: true,
      newToken: 'new-device-token',
      deviceTokenId: 'dfh0haxfpzowht3oi213dtk1',
    });
    (getClientIP as Mock).mockReturnValue('192.168.1.1');
  });

  describe('successful mobile refresh', () => {
    it('returns 200 with new tokens', async () => {
      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validRefreshPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionToken).toBe('ps_sess_refreshed-token');
      expect(body.csrfToken).toBe('mock-csrf-token');
      expect(body.deviceToken).toBeDefined();
    });

    it('updates device token activity', async () => {
      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validRefreshPayload),
      });

      await POST(request);

      expect(updateDeviceTokenActivity).toHaveBeenCalledWith(
        mockDeviceRecord.id,
        '192.168.1.1'
      );
    });

    it('resets rate limit on successful refresh', async () => {
      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '192.168.1.1',
        },
        body: JSON.stringify(validRefreshPayload),
      });

      await POST(request);

      expect(resetDistributedRateLimit).toHaveBeenCalledWith(
        'refresh:device:ip:192.168.1.1'
      );
    });

    it('includes X-RateLimit headers on success', async () => {
      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validRefreshPayload),
      });

      const response = await POST(request);

      expect(response.headers.get('X-RateLimit-Limit')).toBe('10');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('10');
    });
  });

  describe('device token rotation', () => {
    it('rotates device token when within 7 days of expiration', async () => {
      const expiringDeviceRecord = {
        ...mockDeviceRecord,
        expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // 5 days from now
      };
      (validateDeviceToken as Mock).mockResolvedValue(expiringDeviceRecord);

      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validRefreshPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(atomicDeviceTokenRotation).toHaveBeenCalled();
      expect(body.deviceToken).toBe('new-device-token');
    });

    it('does not rotate device token when not near expiration', async () => {
      const freshDeviceRecord = {
        ...mockDeviceRecord,
        expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 days from now
      };
      (validateDeviceToken as Mock).mockResolvedValue(freshDeviceRecord);

      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validRefreshPayload),
      });

      await POST(request);

      expect(atomicDeviceTokenRotation).not.toHaveBeenCalled();
    });

    it('returns 401 when rotation fails', async () => {
      const expiringDeviceRecord = {
        ...mockDeviceRecord,
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days from now
      };
      (validateDeviceToken as Mock).mockResolvedValue(expiringDeviceRecord);
      (atomicDeviceTokenRotation as Mock).mockResolvedValue({
        success: false,
        error: 'Token already rotated',
      });

      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validRefreshPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toContain('Token already rotated');
    });

    it('handles grace period retry correctly', async () => {
      const expiringDeviceRecord = {
        ...mockDeviceRecord,
        expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), // 2 days from now
      };
      (validateDeviceToken as Mock).mockResolvedValue(expiringDeviceRecord);
      (atomicDeviceTokenRotation as Mock).mockResolvedValue({
        success: true,
        gracePeriodRetry: true,
        deviceTokenId: 'replacement-token-id',
      });

      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validRefreshPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      // Should return original token during grace period
      expect(body.deviceToken).toBe(validRefreshPayload.deviceToken);
    });
  });

  describe('device token validation', () => {
    it('returns 401 for invalid device token', async () => {
      (validateDeviceToken as Mock).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validRefreshPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid or expired device token.');
    });

    it('returns 401 for device ID mismatch', async () => {
      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validRefreshPayload,
          deviceId: 'different-device-456',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Device token does not match this device.');
    });

    it('returns 401 when user not found', async () => {
      (db.query.users.findFirst as Mock).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validRefreshPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid or expired device token.');
    });
  });

  describe('input validation', () => {
    it('returns 400 for missing deviceToken', async () => {
      const request = new Request('http://localhost/api/auth/mobile/refresh', {
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
      expect(body.errors.deviceToken).toBeDefined();
    });

    it('returns 400 for missing deviceId', async () => {
      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceToken: 'dt_some-token',
          platform: 'ios',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.deviceId).toBeDefined();
    });

    it('returns 400 for invalid platform', async () => {
      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validRefreshPayload,
          platform: 'windows',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.platform).toBeDefined();
    });

    it('accepts empty deviceToken string with validation error', async () => {
      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceToken: '',
          deviceId: 'device-123',
          platform: 'ios',
        }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.deviceToken).toBeDefined();
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when rate limit exceeded', async () => {
      (checkDistributedRateLimit as Mock).mockResolvedValue({
        allowed: false,
        retryAfter: 300,
        attemptsRemaining: 0,
      });

      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validRefreshPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many refresh attempts');
      expect(response.headers.get('Retry-After')).toBe('300');
    });

    it('includes X-RateLimit headers on 429 response', async () => {
      (checkDistributedRateLimit as Mock).mockResolvedValue({
        allowed: false,
        retryAfter: 300,
        attemptsRemaining: 0,
      });

      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validRefreshPayload),
      });

      const response = await POST(request);

      expect(response.headers.get('X-RateLimit-Limit')).toBe('10');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    });

    it('uses refresh:device:ip rate limit key', async () => {
      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validRefreshPayload),
      });

      await POST(request);

      // IP is resolved by getClientIP mock (returns '192.168.1.1')
      expect(checkDistributedRateLimit).toHaveBeenCalledWith(
        'refresh:device:ip:192.168.1.1',
        DISTRIBUTED_RATE_LIMITS.REFRESH
      );
    });
  });

  describe('session creation', () => {
    it('creates 90-day session for mobile refresh', async () => {
      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validRefreshPayload),
      });

      await POST(request);

      expect(sessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockUser.id,
          expiresInMs: 90 * 24 * 60 * 60 * 1000,
          createdByService: 'mobile-refresh',
        })
      );
    });

    it('returns 500 when session validation fails', async () => {
      (sessionService.validateSession as Mock).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validRefreshPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to generate session.');
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected error', async () => {
      (validateDeviceToken as Mock).mockRejectedValue(new Error('Database error'));

      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validRefreshPayload),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred.');
    });

    it('logs device ID mismatch warning', async () => {
      const { loggers } = await import('@pagespace/lib/server');

      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validRefreshPayload,
          deviceId: 'mismatched-device',
        }),
      });

      await POST(request);

      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Device token mismatch detected',
        expect.objectContaining({
          tokenDeviceId: mockDeviceRecord.deviceId,
          providedDeviceId: 'mismatched-device',
        })
      );
    });

    it('handles rate limit reset failure gracefully', async () => {
      (resetDistributedRateLimit as Mock).mockRejectedValue(
        new Error('Redis error')
      );

      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validRefreshPayload),
      });

      const response = await POST(request);

      // Should still succeed even if rate limit reset fails
      expect(response.status).toBe(200);
    });
  });

  describe('platform support', () => {
    it('supports iOS platform', async () => {
      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validRefreshPayload, platform: 'ios' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
    });

    it('supports Android platform', async () => {
      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validRefreshPayload, platform: 'android' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
    });

    it('supports desktop platform', async () => {
      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validRefreshPayload, platform: 'desktop' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
    });

    it('defaults platform to ios', async () => {
      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceToken: validRefreshPayload.deviceToken,
          deviceId: validRefreshPayload.deviceId,
        }),
      });

      const response = await POST(request);
      expect(response.status).toBe(200);
    });
  });

  describe('IP address handling', () => {
    it('normalizes unknown IP to undefined for activity tracking', async () => {
      const { getClientIP } = await import('@/lib/auth');
      (getClientIP as Mock).mockReturnValue('unknown');

      const request = new Request('http://localhost/api/auth/mobile/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validRefreshPayload),
      });

      await POST(request);

      expect(updateDeviceTokenActivity).toHaveBeenCalledWith(
        expect.any(String),
        undefined
      );
    });
  });
});
