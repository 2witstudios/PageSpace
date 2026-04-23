import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '../device/refresh/route';

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
  // Opaque token generator - now synchronous with no parameters
  generateDeviceToken: vi.fn().mockReturnValue('ps_dev_mock_token'),
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

vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('mock-cuid'),
}));

vi.mock('cookie', () => ({
  serialize: vi.fn().mockReturnValue('mock-cookie'),
}));

vi.mock('@pagespace/lib/auth', () => ({
  hashToken: vi.fn().mockReturnValue('mock-token-hash'),
  getTokenPrefix: vi.fn().mockReturnValue('mock-prefix'),
  sessionService: {
    createSession: vi.fn().mockResolvedValue('ps_sess_mock-session-token'),
    validateSession: vi.fn().mockResolvedValue({
      sessionId: 'session-123',
      userId: 'test-user-id',
      userRole: 'user',
      tokenVersion: 0,
      type: 'user',
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    }),
  },
}));

vi.mock('@/lib/auth', () => ({
  getClientIP: vi.fn().mockReturnValue('192.168.1.1'),
  appendSessionCookie: vi.fn(),
}));

import { authRepository } from '@/lib/repositories/auth-repository';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { atomicDeviceTokenRotation } from '@pagespace/db/transactions/auth-transactions';
import { validateDeviceToken, updateDeviceTokenActivity } from '@pagespace/lib/auth/device-auth-utils'
import { auditRequest } from '@pagespace/lib/audit/audit-log'
import { loggers } from '@pagespace/lib/logging/logger-config';
import { trackAuthEvent } from '@pagespace/lib/monitoring/activity-tracker';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { appendSessionCookie } from '@/lib/auth';

describe('/api/auth/device/refresh', () => {
  const mockUser = {
    id: 'test-user-id',
    email: 'test@example.com',
    name: 'Test User',
    tokenVersion: 0,
    role: 'user' as const,
  };

  const mockDeviceRecord = {
    id: 'device-token-record-id',
    userId: 'test-user-id',
    deviceId: 'device-123',
    platform: 'desktop',
    deviceName: 'Test Device',
    userAgent: 'TestApp/1.0',
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
  };

  const validPayload = {
    deviceToken: 'valid-device-token',
    deviceId: 'device-123',
    userAgent: 'TestApp/1.0',
    appVersion: '1.0.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: valid device token flow
    vi.mocked(validateDeviceToken).mockResolvedValue(mockDeviceRecord as never);
    vi.mocked(authRepository.findUserById).mockResolvedValue(mockUser as never);
    vi.mocked(sessionRepository.updateDeviceTokenDeviceId).mockResolvedValue({ id: 'device-token-record-id', deviceId: 'device-123' } as never);
    // Default: no rotation (token not near expiration)
    vi.mocked(atomicDeviceTokenRotation).mockResolvedValue({ success: false });
  });

  describe('successful device refresh', () => {
    it('returns 200 with new tokens for mobile/desktop', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/device/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert - mobile/desktop get session token in response (no refreshToken - devices use device tokens)
      expect(response.status).toBe(200);
      expect(body.sessionToken).toBe('ps_sess_mock-session-token');
      expect(body.refreshToken).toBeUndefined(); // No refresh token - devices use device tokens
      expect(body.csrfToken).toBe('mock-csrf-token');
      expect(body.deviceToken).toBe('valid-device-token');
    });

    it('returns session cookie for web platform (not JSON tokens)', async () => {
      // Web platform now uses sessions, sets cookie instead of returning JWT
      const webDeviceRecord = { ...mockDeviceRecord, platform: 'web' };
      vi.mocked(validateDeviceToken).mockResolvedValue(webDeviceRecord as never);

      const request = new Request('http://localhost/api/auth/device/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert - web gets session cookie set, no JWT token in response
      expect(response.status).toBe(200);
      expect(body.token).toBeUndefined(); // No JWT for web - uses session cookie
      expect(body.csrfToken).toBe('mock-csrf-token');
      expect(body.deviceToken).toBe('valid-device-token');
      expect(appendSessionCookie).toHaveBeenCalledTimes(1);
      const [webHeaders, webToken] = vi.mocked(appendSessionCookie).mock.calls[0];
      expect(webHeaders).toBeInstanceOf(Headers);
      expect(webToken).toBe('ps_sess_mock-session-token');
    });

    it('creates new session for mobile/desktop', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/device/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      // Act
      await POST(request);

      // Assert - creates session token (no refresh token - devices use device tokens)
      const sessionArg = vi.mocked(sessionService.createSession).mock.calls[0][0];
      expect(sessionArg.userId).toBe(mockUser.id);
      expect(sessionArg.type).toBe('user');
      expect(sessionArg.scopes).toEqual(['*']);
    });

    it('updates device token activity', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/device/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '192.168.1.1',
        },
        body: JSON.stringify(validPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(updateDeviceTokenActivity).toHaveBeenCalledWith(
        mockDeviceRecord.id,
        '192.168.1.1'
      );
    });

    it('logs refresh event', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/device/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '192.168.1.1',
        },
        body: JSON.stringify(validPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'auth.token.refreshed',
          userId: mockUser.id,
          details: { method: 'Device token refresh' },
        })
      );
      const trackArgs = vi.mocked(trackAuthEvent).mock.calls[0];
      expect(trackArgs[0]).toBe(mockUser.id);
      expect(trackArgs[1]).toBe('refresh');
      const trackData = trackArgs[2] as Record<string, unknown>;
      expect(trackData.platform).toBe('desktop');
      expect(trackData.appVersion).toBe('1.0.0');
    });
  });

  describe('device token rotation', () => {
    it('rotates device token when nearing expiration', async () => {
      // Arrange - token expires in 30 days (within 60-day rotation window)
      const nearExpiryRecord = {
        ...mockDeviceRecord,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      };
      vi.mocked(validateDeviceToken).mockResolvedValue(nearExpiryRecord as never);
      vi.mocked(atomicDeviceTokenRotation).mockResolvedValue({
        success: true,
        newToken: 'ps_dev_rotated_token', // Opaque format
        deviceTokenId: 'new-device-token-record-id',
      });

      const request = new Request('http://localhost/api/auth/device/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      const { hashToken, getTokenPrefix } = await import('@pagespace/lib/auth');
      const { generateDeviceToken } = await import('@pagespace/lib/server');
      expect(atomicDeviceTokenRotation).toHaveBeenCalledWith(
        'valid-device-token',
        {
          userAgent: 'TestApp/1.0',
          ipAddress: '192.168.1.1',
        },
        hashToken,
        getTokenPrefix,
        generateDeviceToken,
      );
      expect(body.deviceToken).toBe('ps_dev_rotated_token');
    });

    it('does not rotate device token when far from expiration', async () => {
      // Arrange - token expires in 80 days (outside 60-day rotation window)
      const farExpiryRecord = {
        ...mockDeviceRecord,
        expiresAt: new Date(Date.now() + 80 * 24 * 60 * 60 * 1000),
      };
      vi.mocked(validateDeviceToken).mockResolvedValue(farExpiryRecord as never);

      const request = new Request('http://localhost/api/auth/device/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(atomicDeviceTokenRotation).not.toHaveBeenCalled();
    });
  });

  describe('invalid device token', () => {
    it('returns 401 for invalid or expired device token', async () => {
      // Arrange
      vi.mocked(validateDeviceToken).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/device/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid or expired device token.');
    });

    it('returns 401 when device ID mismatch (possible stolen token)', async () => {
      // Arrange - different device trying to use the token
      const request = new Request('http://localhost/api/auth/device/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validPayload,
          deviceId: 'different-device-456',
        }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(401);
      expect(body.error).toBe('Device token does not match this device.');
    });

    it('allows deviceId correction for legacy OAuth devices with "unknown" deviceId', async () => {
      // Arrange - legacy device from OAuth migration
      const legacyDeviceRecord = { ...mockDeviceRecord, deviceId: 'unknown' };
      vi.mocked(validateDeviceToken).mockResolvedValue(legacyDeviceRecord as never);

      const request = new Request('http://localhost/api/auth/device/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validPayload,
          deviceId: 'new-device-id',
        }),
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(200);
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Correcting device token deviceId from OAuth migration',
        {
          deviceTokenId: 'device-token-record-id',
          oldDeviceId: 'unknown',
          newDeviceId: 'new-device-id',
          userId: 'test-user-id',
        }
      );
    });

    it('logs security warning for device mismatch', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/device/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validPayload,
          deviceId: 'stolen-device-999',
        }),
      });

      // Act
      await POST(request);

      // Assert
      const warnArgs = vi.mocked(loggers.auth.warn).mock.calls[0];
      expect(warnArgs[0]).toBe('Device token mismatch detected - possible stolen token');
      const warnData = warnArgs[1] as Record<string, unknown>;
      expect(warnData.tokenDeviceId).toBe('device-123');
      expect(warnData.providedDeviceId).toBe('stolen-device-999');
    });
  });

  describe('input validation', () => {
    it('returns 400 for missing deviceToken', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/device/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'device-123' }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.errors.deviceToken).toEqual(['Invalid input: expected string, received undefined']);
    });

    it('returns 400 for missing deviceId', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/device/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceToken: 'valid-token' }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body.errors.deviceId).toEqual(['Invalid input: expected string, received undefined']);
    });
  });

  describe('user not found', () => {
    it('returns 404 when user is deleted but device token exists', async () => {
      // Arrange
      vi.mocked(authRepository.findUserById).mockResolvedValue(null as never);

      const request = new Request('http://localhost/api/auth/device/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found for device token.');
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected errors', async () => {
      // Arrange
      vi.mocked(validateDeviceToken).mockRejectedValueOnce(new Error('Database error'));

      const request = new Request('http://localhost/api/auth/device/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
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
