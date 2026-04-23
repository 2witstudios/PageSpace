/**
 * Contract tests for POST /api/auth/device/refresh
 *
 * Tests the device token refresh endpoint.
 * Verifies the Request -> Response contract and boundary obligations.
 *
 * Coverage:
 * - Input validation (deviceToken, deviceId)
 * - Rate limiting
 * - Device token validation (invalid/expired)
 * - Device ID mismatch (strict mismatch vs legacy 'unknown' migration)
 * - Legacy migration failure (updatedDevice is null, db error)
 * - User not found
 * - Token rotation (within 60 days of expiration)
 * - Token rotation failure
 * - Rate limit reset (success and failure)
 * - Web platform session creation + cookie
 * - Desktop/iOS platform session + cookie
 * - Mobile platform session (no cookie)
 * - Session validation failure (web and mobile)
 * - IP normalization (unknown IP)
 * - Error handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/repositories/auth-repository', () => ({
  authRepository: {
    findUserById: vi.fn(),
  },
}));

vi.mock('@/lib/repositories/session-repository', () => ({
  sessionRepository: {
    updateDeviceTokenDeviceId: vi.fn(),
  },
}));

vi.mock('@pagespace/db/transactions/auth-transactions', () => ({
  atomicDeviceTokenRotation: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  validateDeviceToken: vi.fn(),
  updateDeviceTokenActivity: vi.fn().mockResolvedValue(undefined),
  generateDeviceToken: vi.fn(),
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
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
}));

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn(),
  resetDistributedRateLimit: vi.fn().mockResolvedValue(undefined),
  DISTRIBUTED_RATE_LIMITS: {
    REFRESH: {
      maxAttempts: 10,
      windowMs: 300000,
    },
  },
}));

vi.mock('@pagespace/lib/auth', () => ({
  hashToken: vi.fn(),
  getTokenPrefix: vi.fn(),
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock_session_token'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'mock-session-id',
      userId: 'user-123',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
    }),
  },
}));

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
  appendSessionCookie: vi.fn(),
}));

import { POST } from '../route';
import { authRepository } from '@/lib/repositories/auth-repository';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { atomicDeviceTokenRotation } from '@pagespace/db/transactions/auth-transactions';
import { validateDeviceToken, updateDeviceTokenActivity } from '@pagespace/lib/auth/device-auth-utils'
import { generateCSRFToken } from '@pagespace/lib/auth/csrf-utils'
import { loggers } from '@pagespace/lib/logging/logger-config';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { checkDistributedRateLimit, resetDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { trackAuthEvent } from '@pagespace/lib/monitoring/activity-tracker';
import { getClientIP, appendSessionCookie } from '@/lib/auth';

const mockUser = {
  id: 'user-123',
  name: 'Test User',
  email: 'test@example.com',
  tokenVersion: 0,
  role: 'user',
};

const mockDeviceRecord = {
  id: 'device-token-record-id',
  userId: 'user-123',
  deviceId: 'device-123',
  platform: 'desktop',
  expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days from now
};

const createRefreshRequest = (
  payload: Record<string, unknown>,
  additionalHeaders: Record<string, string> = {}
) => {
  return new Request('http://localhost/api/auth/device/refresh', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'PageSpace-Desktop/1.0',
      ...additionalHeaders,
    },
    body: JSON.stringify(payload),
  });
};

const validRefreshPayload = {
  deviceToken: 'ps_dev_valid_token',
  deviceId: 'device-123',
};

describe('POST /api/auth/device/refresh', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true, attemptsRemaining: 10 });
    vi.mocked(resetDistributedRateLimit).mockResolvedValue(undefined);
    vi.mocked(getClientIP).mockReturnValue('127.0.0.1');

    vi.mocked(validateDeviceToken).mockResolvedValue(mockDeviceRecord as never);
    vi.mocked(authRepository.findUserById).mockResolvedValue(mockUser as never);
    vi.mocked(updateDeviceTokenActivity).mockResolvedValue(undefined as never);
    vi.mocked(generateCSRFToken).mockReturnValue('mock-csrf-token');

    vi.mocked(sessionService.createSession).mockResolvedValue('ps_sess_mock_session_token');
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      sessionId: 'mock-session-id',
      userId: 'user-123',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
    } as never);

  });

  describe('input validation', () => {
    it('returns 400 for missing deviceToken', async () => {
      const request = createRefreshRequest({ deviceId: 'device-123' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.deviceToken).toEqual(['Invalid input: expected string, received undefined']);
    });

    it('returns 400 for empty deviceToken', async () => {
      const request = createRefreshRequest({ deviceToken: '', deviceId: 'device-123' });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('returns 400 for missing deviceId', async () => {
      const request = createRefreshRequest({ deviceToken: 'valid-token' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.deviceId).toEqual(['Invalid input: expected string, received undefined']);
    });

    it('returns 400 for empty deviceId', async () => {
      const request = createRefreshRequest({ deviceToken: 'valid-token', deviceId: '' });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });
  });

  describe('rate limiting', () => {
    it('returns 429 when rate limit exceeded', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: 300,
      });

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many refresh attempts');
      expect(body.retryAfter).toBe(300);
      expect(response.headers.get('Retry-After')).toBe('300');
    });

    it('uses default retryAfter when not provided', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        attemptsRemaining: 0,
        retryAfter: undefined,
      });

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);

      expect(response.headers.get('Retry-After')).toBe('300');
    });
  });

  describe('device token validation', () => {
    it('returns 401 when device token is invalid', async () => {
      vi.mocked(validateDeviceToken).mockResolvedValue(null as never);

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toContain('Invalid or expired device token');
    });
  });

  describe('device ID mismatch', () => {
    it('returns 401 for strict device ID mismatch', async () => {
      vi.mocked(validateDeviceToken).mockResolvedValue({
        ...mockDeviceRecord,
        deviceId: 'different-device',
      } as never);

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toContain('does not match');
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Device token mismatch detected - possible stolen token',
        expect.objectContaining({
          tokenDeviceId: 'different-device',
          providedDeviceId: 'device-123',
        })
      );
    });

    it('corrects legacy unknown deviceId', async () => {
      vi.mocked(validateDeviceToken).mockResolvedValue({
        ...mockDeviceRecord,
        deviceId: 'unknown',
      } as never);

      vi.mocked(sessionRepository.updateDeviceTokenDeviceId).mockResolvedValue({ id: 'device-token-record-id', deviceId: 'device-123' } as never);

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Correcting device token deviceId from OAuth migration',
        {
          deviceTokenId: 'device-token-record-id',
          oldDeviceId: 'unknown',
          newDeviceId: 'device-123',
          userId: 'user-123',
        }
      );
    });

    it('corrects legacy null/empty deviceId', async () => {
      vi.mocked(validateDeviceToken).mockResolvedValue({
        ...mockDeviceRecord,
        deviceId: null,
      } as never);

      vi.mocked(sessionRepository.updateDeviceTokenDeviceId).mockResolvedValue({ id: 'device-token-record-id', deviceId: 'device-123' } as never);

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it('returns 500 when legacy device update returns no result', async () => {
      vi.mocked(validateDeviceToken).mockResolvedValue({
        ...mockDeviceRecord,
        deviceId: 'unknown',
      } as never);

      vi.mocked(sessionRepository.updateDeviceTokenDeviceId).mockResolvedValue(null);

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Failed to update device');
    });

    it('returns 500 when legacy device update throws', async () => {
      vi.mocked(validateDeviceToken).mockResolvedValue({
        ...mockDeviceRecord,
        deviceId: 'unknown',
      } as never);

      vi.mocked(sessionRepository.updateDeviceTokenDeviceId).mockRejectedValueOnce(new Error('DB error'));

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Failed to update device');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Error correcting device token deviceId',
        expect.objectContaining({ error: expect.objectContaining({ message: 'DB error' }) })
      );
    });
  });

  describe('user not found', () => {
    it('returns 404 when user is not found', async () => {
      vi.mocked(authRepository.findUserById).mockResolvedValue(null as never);

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toContain('User not found');
    });
  });

  describe('token rotation', () => {
    it('rotates token when within 60 days of expiration', async () => {
      const nearExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
      vi.mocked(validateDeviceToken).mockResolvedValue({
        ...mockDeviceRecord,
        expiresAt: nearExpiry,
      } as never);

      vi.mocked(atomicDeviceTokenRotation).mockResolvedValue({
        success: true,
        newToken: 'ps_dev_rotated_token',
        deviceTokenId: 'new-device-token-id',
      });

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.deviceToken).toBe('ps_dev_rotated_token');
      const { hashToken, getTokenPrefix } = await import('@pagespace/lib/auth');
      const { generateDeviceToken } = await import('@pagespace/lib/server');
      expect(atomicDeviceTokenRotation).toHaveBeenCalledWith(
        'ps_dev_valid_token',
        expect.objectContaining({
          ipAddress: '127.0.0.1',
        }),
        hashToken,
        getTokenPrefix,
        generateDeviceToken,
      );
    });

    it('returns 401 when rotation fails', async () => {
      const nearExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      vi.mocked(validateDeviceToken).mockResolvedValue({
        ...mockDeviceRecord,
        expiresAt: nearExpiry,
      } as never);

      vi.mocked(atomicDeviceTokenRotation).mockResolvedValue({
        success: false,
        error: 'Token already rotated',
      });

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Token already rotated');
    });

    it('returns generic message when rotation fails without error message', async () => {
      const nearExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      vi.mocked(validateDeviceToken).mockResolvedValue({
        ...mockDeviceRecord,
        expiresAt: nearExpiry,
      } as never);

      vi.mocked(atomicDeviceTokenRotation).mockResolvedValue({
        success: false,
      });

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toContain('Device token rotation failed');
    });

    it('does not rotate when token is far from expiration', async () => {
      // Default mockDeviceRecord has expiresAt 90 days from now, > 60 days
      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(atomicDeviceTokenRotation).not.toHaveBeenCalled();
    });

    it('does not rotate when expiresAt is null', async () => {
      vi.mocked(validateDeviceToken).mockResolvedValue({
        ...mockDeviceRecord,
        expiresAt: null,
      } as never);

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(atomicDeviceTokenRotation).not.toHaveBeenCalled();
    });

    it('keeps original token when rotation succeeds without new token', async () => {
      const nearExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      vi.mocked(validateDeviceToken).mockResolvedValue({
        ...mockDeviceRecord,
        expiresAt: nearExpiry,
      } as never);

      vi.mocked(atomicDeviceTokenRotation).mockResolvedValue({
        success: true,
        // @ts-expect-error - partial mock data
        newToken: null,
        // @ts-expect-error - partial mock data
        deviceTokenId: null,
      });

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.deviceToken).toBe('ps_dev_valid_token');
    });
  });

  describe('rate limit reset', () => {
    it('resets rate limit on successful refresh', async () => {
      const request = createRefreshRequest(validRefreshPayload);
      await POST(request);

      expect(resetDistributedRateLimit).toHaveBeenCalledWith('refresh:device:ip:127.0.0.1');
    });

    it('logs warning when rate limit reset fails', async () => {
      vi.mocked(resetDistributedRateLimit).mockRejectedValueOnce(new Error('Redis error'));

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Rate limit reset failed after successful device refresh',
        expect.objectContaining({ error: 'Redis error' })
      );
    });

    it('handles non-Error rate limit reset failure', async () => {
      vi.mocked(resetDistributedRateLimit).mockRejectedValueOnce('string-error');

      const request = createRefreshRequest(validRefreshPayload);
      await POST(request);

      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Rate limit reset failed after successful device refresh',
        expect.objectContaining({ error: 'string-error' })
      );
    });
  });

  describe('web platform', () => {
    it('returns csrf and device token with session cookie for web', async () => {
      vi.mocked(validateDeviceToken).mockResolvedValue({
        ...mockDeviceRecord,
        platform: 'web',
      } as never);

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.csrfToken).toBe('mock-csrf-token');
      expect(body.deviceToken).toBe('ps_dev_valid_token');
      expect(body.sessionToken).toBeUndefined();
      expect(appendSessionCookie).toHaveBeenCalledTimes(1);
      const [headers, token] = vi.mocked(appendSessionCookie).mock.calls[0];
      expect(headers).toBeInstanceOf(Headers);
      expect(token).toBe('ps_sess_mock_session_token');
    });

    it('returns 500 when web session validation fails', async () => {
      vi.mocked(validateDeviceToken).mockResolvedValue({
        ...mockDeviceRecord,
        platform: 'web',
      } as never);
      vi.mocked(sessionService.validateSession).mockResolvedValue(null as never);

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Failed to generate session');
    });
  });

  describe('desktop platform', () => {
    it('returns session token, csrf, and device token for desktop', async () => {
      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionToken).toBe('ps_sess_mock_session_token');
      expect(body.csrfToken).toBe('mock-csrf-token');
      expect(body.deviceToken).toBe('ps_dev_valid_token');
    });

    it('sets session cookie for desktop platform', async () => {
      const request = createRefreshRequest(validRefreshPayload);
      await POST(request);

      expect(appendSessionCookie).toHaveBeenCalledTimes(1);
      const [headers, token] = vi.mocked(appendSessionCookie).mock.calls[0];
      expect(headers).toBeInstanceOf(Headers);
      expect(token).toBe('ps_sess_mock_session_token');
    });

    it('returns 500 when desktop session validation fails', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(null as never);

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Failed to generate session');
    });
  });

  describe('iOS platform', () => {
    it('sets session cookie for iOS platform', async () => {
      vi.mocked(validateDeviceToken).mockResolvedValue({
        ...mockDeviceRecord,
        platform: 'ios',
      } as never);

      const request = createRefreshRequest(validRefreshPayload);
      await POST(request);

      expect(appendSessionCookie).toHaveBeenCalledTimes(1);
      const [iosHeaders, iosToken] = vi.mocked(appendSessionCookie).mock.calls[0];
      expect(iosHeaders).toBeInstanceOf(Headers);
      expect(iosToken).toBe('ps_sess_mock_session_token');
    });
  });

  describe('mobile platform (no cookie)', () => {
    it('does not set session cookie for mobile platform', async () => {
      vi.mocked(validateDeviceToken).mockResolvedValue({
        ...mockDeviceRecord,
        platform: 'android',
      } as never);

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessionToken).toBe('ps_sess_mock_session_token');
      expect(appendSessionCookie).not.toHaveBeenCalled();
    });
  });

  describe('IP normalization', () => {
    it('normalizes unknown IP to undefined for session creation', async () => {
      vi.mocked(getClientIP).mockReturnValue('unknown');

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(sessionService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          createdByIp: undefined,
        })
      );
    });
  });

  describe('auth event logging', () => {
    it('logs auth events on successful refresh', async () => {
      const request = createRefreshRequest({
        ...validRefreshPayload,
        userAgent: 'Custom Agent',
        appVersion: '2.0.0',
      });
      await POST(request);

      expect(trackAuthEvent).toHaveBeenCalledWith(
        mockUser.id,
        'refresh',
        expect.objectContaining({
          platform: 'desktop',
          appVersion: '2.0.0',
        })
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected exception', async () => {
      vi.mocked(validateDeviceToken).mockRejectedValueOnce(new Error('DB error'));

      const request = createRefreshRequest(validRefreshPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('unexpected error');
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Device token refresh error',
        new Error('DB error')
      );
    });
  });
});
