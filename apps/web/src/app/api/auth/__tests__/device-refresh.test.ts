import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { POST } from '../device/refresh/route';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  users: { id: 'id' },
  refreshTokens: {},
  deviceTokens: { id: 'id', deviceId: 'deviceId' },
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'device-token-id', deviceId: 'device-123' }]),
        }),
      }),
    }),
  },
  eq: vi.fn((field, value) => ({ field, value })),
}));

vi.mock('@pagespace/lib/server', () => ({
  validateDeviceToken: vi.fn(),
  rotateDeviceToken: vi.fn(),
  updateDeviceTokenActivity: vi.fn().mockResolvedValue(undefined),
  generateAccessToken: vi.fn().mockResolvedValue('new-access-token'),
  generateRefreshToken: vi.fn().mockResolvedValue('new-refresh-token'),
  decodeToken: vi.fn().mockResolvedValue({
    userId: 'test-user-id',
    exp: Math.floor(Date.now() / 1000) + 2592000,
    iat: Math.floor(Date.now() / 1000),
  }),
  getRefreshTokenMaxAge: vi.fn().mockReturnValue(2592000),
  generateCSRFToken: vi.fn().mockReturnValue('mock-csrf-token'),
  getSessionIdFromJWT: vi.fn().mockReturnValue('session-id-123'),
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

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('mock-cuid'),
}));

vi.mock('cookie', () => ({
  serialize: vi.fn().mockReturnValue('mock-cookie'),
}));

import { db } from '@pagespace/db';
import {
  validateDeviceToken,
  rotateDeviceToken,
  updateDeviceTokenActivity,
  generateAccessToken,
  generateRefreshToken,
  logAuthEvent,
  loggers,
} from '@pagespace/lib/server';
import { trackAuthEvent } from '@pagespace/lib/activity-tracker';

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
    (validateDeviceToken as Mock).mockResolvedValue(mockDeviceRecord);
    (db.query.users.findFirst as Mock).mockResolvedValue(mockUser);
    (rotateDeviceToken as Mock).mockResolvedValue(null); // No rotation needed
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

      // Assert
      expect(response.status).toBe(200);
      expect(body.token).toBe('new-access-token');
      expect(body.refreshToken).toBe('new-refresh-token');
      expect(body.csrfToken).toBe('mock-csrf-token');
      expect(body.deviceToken).toBe('valid-device-token');
    });

    it('returns cookies for web platform', async () => {
      // Arrange
      const webDeviceRecord = { ...mockDeviceRecord, platform: 'web' };
      (validateDeviceToken as Mock).mockResolvedValue(webDeviceRecord);

      const request = new Request('http://localhost/api/auth/device/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(200);
      expect(body.message).toBe('Session refreshed successfully');
      expect(body.csrfToken).toBe('mock-csrf-token');
      const setCookieHeaders = response.headers.getSetCookie();
      expect(setCookieHeaders.length).toBe(2);
    });

    it('generates new access and refresh tokens', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/device/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(generateAccessToken).toHaveBeenCalledWith(
        mockUser.id,
        mockUser.tokenVersion,
        mockUser.role
      );
      expect(generateRefreshToken).toHaveBeenCalledWith(
        mockUser.id,
        mockUser.tokenVersion,
        mockUser.role
      );
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
      expect(logAuthEvent).toHaveBeenCalledWith(
        'login',
        mockUser.id,
        mockUser.email,
        '192.168.1.1',
        'Device token refresh'
      );
      expect(trackAuthEvent).toHaveBeenCalledWith(
        mockUser.id,
        'refresh',
        expect.objectContaining({
          platform: 'desktop',
          appVersion: '1.0.0',
        })
      );
    });
  });

  describe('device token rotation', () => {
    it('rotates device token when nearing expiration', async () => {
      // Arrange - token expires in 30 days (within 60-day rotation window)
      const nearExpiryRecord = {
        ...mockDeviceRecord,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      };
      (validateDeviceToken as Mock).mockResolvedValue(nearExpiryRecord);
      (rotateDeviceToken as Mock).mockResolvedValue({
        token: 'rotated-device-token',
        deviceToken: { id: 'new-device-token-record-id' },
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
      expect(rotateDeviceToken).toHaveBeenCalled();
      expect(body.deviceToken).toBe('rotated-device-token');
    });

    it('does not rotate device token when far from expiration', async () => {
      // Arrange - token expires in 80 days (outside 60-day rotation window)
      const farExpiryRecord = {
        ...mockDeviceRecord,
        expiresAt: new Date(Date.now() + 80 * 24 * 60 * 60 * 1000),
      };
      (validateDeviceToken as Mock).mockResolvedValue(farExpiryRecord);

      const request = new Request('http://localhost/api/auth/device/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validPayload),
      });

      // Act
      await POST(request);

      // Assert
      expect(rotateDeviceToken).not.toHaveBeenCalled();
    });
  });

  describe('invalid device token', () => {
    it('returns 401 for invalid or expired device token', async () => {
      // Arrange
      (validateDeviceToken as Mock).mockResolvedValue(null);

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
      (validateDeviceToken as Mock).mockResolvedValue(legacyDeviceRecord);

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
        expect.any(Object)
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
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Device token mismatch detected - possible stolen token',
        expect.objectContaining({
          tokenDeviceId: 'device-123',
          providedDeviceId: 'stolen-device-999',
        })
      );
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
      expect(body.errors.deviceToken).toBeDefined();
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
      expect(body.errors.deviceId).toBeDefined();
    });
  });

  describe('user not found', () => {
    it('returns 404 when user is deleted but device token exists', async () => {
      // Arrange
      (db.query.users.findFirst as Mock).mockResolvedValue(null);

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
      (validateDeviceToken as Mock).mockRejectedValue(new Error('Database error'));

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
