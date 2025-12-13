import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @pagespace/db
const {
  mockDbQueryUsersFindFirst,
  mockDbUpdateReturning,
  mockDbInsertValues,
} = vi.hoisted(() => ({
  mockDbQueryUsersFindFirst: vi.fn(),
  mockDbUpdateReturning: vi.fn(),
  mockDbInsertValues: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: { users: { findFirst: mockDbQueryUsersFindFirst } },
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: mockDbUpdateReturning,
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: mockDbInsertValues })),
  },
  users: {},
  refreshTokens: {},
  deviceTokens: {},
  eq: vi.fn(),
}));

// Mock @pagespace/lib/server
const {
  mockValidateDeviceToken,
  mockRotateDeviceToken,
  mockUpdateDeviceTokenActivity,
  mockGenerateAccessToken,
  mockGenerateRefreshToken,
  mockDecodeToken,
  mockGetRefreshTokenMaxAge,
  mockGenerateCSRFToken,
  mockGetSessionIdFromJWT,
  mockLoggerWarn,
  mockLoggerError,
  mockLogAuthEvent,
} = vi.hoisted(() => ({
  mockValidateDeviceToken: vi.fn(),
  mockRotateDeviceToken: vi.fn(),
  mockUpdateDeviceTokenActivity: vi.fn(),
  mockGenerateAccessToken: vi.fn(),
  mockGenerateRefreshToken: vi.fn(),
  mockDecodeToken: vi.fn(),
  mockGetRefreshTokenMaxAge: vi.fn(),
  mockGenerateCSRFToken: vi.fn(),
  mockGetSessionIdFromJWT: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLogAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  validateDeviceToken: mockValidateDeviceToken,
  rotateDeviceToken: mockRotateDeviceToken,
  updateDeviceTokenActivity: mockUpdateDeviceTokenActivity,
  generateAccessToken: mockGenerateAccessToken,
  generateRefreshToken: mockGenerateRefreshToken,
  decodeToken: mockDecodeToken,
  getRefreshTokenMaxAge: mockGetRefreshTokenMaxAge,
  generateCSRFToken: mockGenerateCSRFToken,
  getSessionIdFromJWT: mockGetSessionIdFromJWT,
  logAuthEvent: mockLogAuthEvent,
  loggers: {
    auth: {
      warn: mockLoggerWarn,
      error: mockLoggerError,
    },
  },
}));

// Mock @pagespace/lib/activity-tracker
const { mockTrackAuthEvent } = vi.hoisted(() => ({
  mockTrackAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: mockTrackAuthEvent,
}));

// Mock @paralleldrive/cuid2
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-cuid'),
}));

// Mock cookie
vi.mock('cookie', () => ({
  serialize: vi.fn((name: string, value: string, _opts: unknown) => `${name}=${value}`),
}));

// Import after mocks
import { POST } from '../route';

// Helper to create mock user
const mockUser = (overrides: Partial<{
  id: string;
  email: string;
  tokenVersion: number;
  role: 'user' | 'admin';
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  email: overrides.email ?? 'test@example.com',
  tokenVersion: overrides.tokenVersion ?? 0,
  role: overrides.role ?? 'user',
});

// Helper to create mock device record
const mockDeviceRecord = (overrides: Partial<{
  id: string;
  deviceId: string;
  userId: string;
  platform: 'ios' | 'android' | 'desktop' | 'web';
  deviceName: string | null;
  userAgent: string | null;
  expiresAt: Date;
}> = {}) => ({
  id: overrides.id ?? 'device_record_123',
  deviceId: overrides.deviceId ?? 'device_123',
  userId: overrides.userId ?? 'user_123',
  platform: overrides.platform ?? 'ios',
  deviceName: 'deviceName' in overrides ? overrides.deviceName : 'iPhone 15',
  userAgent: 'userAgent' in overrides ? overrides.userAgent : 'TestApp/1.0',
  expiresAt: overrides.expiresAt ?? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
});

// Helper to create request
const createRequest = (body: Record<string, unknown>, headers?: Record<string, string>) => {
  return new Request('https://example.com/api/auth/device/refresh', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
};

describe('POST /api/auth/device/refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default device token valid
    mockValidateDeviceToken.mockResolvedValue(mockDeviceRecord());

    // Default user exists
    mockDbQueryUsersFindFirst.mockResolvedValue(mockUser());

    // Default token generation
    mockGenerateAccessToken.mockResolvedValue('mock-access-token');
    mockGenerateRefreshToken.mockResolvedValue('mock-refresh-token');
    mockGetRefreshTokenMaxAge.mockReturnValue(30 * 24 * 60 * 60);
    mockDecodeToken.mockResolvedValue({
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    });
    mockGetSessionIdFromJWT.mockReturnValue('mock-session-id');
    mockGenerateCSRFToken.mockReturnValue('mock-csrf-token');
    mockUpdateDeviceTokenActivity.mockResolvedValue(undefined);
    mockRotateDeviceToken.mockResolvedValue(null);
    mockDbInsertValues.mockResolvedValue(undefined);
    mockDbUpdateReturning.mockResolvedValue([{ id: 'device_123' }]);

    // Set env
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.NODE_ENV;
  });

  describe('Validation', () => {
    it('should return 400 for missing deviceToken', async () => {
      const request = createRequest({
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.deviceToken).toBeDefined();
    });

    it('should return 400 for missing deviceId', async () => {
      const request = createRequest({
        deviceToken: 'valid-token',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.deviceId).toBeDefined();
    });
  });

  describe('Device Token Validation', () => {
    it('should return 401 for invalid device token', async () => {
      mockValidateDeviceToken.mockResolvedValue(null);

      const request = createRequest({
        deviceToken: 'invalid-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid or expired device token.');
    });

    it('should return 401 for device ID mismatch', async () => {
      mockValidateDeviceToken.mockResolvedValue(mockDeviceRecord({ deviceId: 'other-device' }));

      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Device token does not match this device.');
    });

    it('should log warning on device ID mismatch', async () => {
      mockValidateDeviceToken.mockResolvedValue(mockDeviceRecord({ deviceId: 'other-device' }));

      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'device_123',
      });
      await POST(request);

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'Device token mismatch detected - possible stolen token',
        expect.objectContaining({
          tokenDeviceId: 'other-device',
          providedDeviceId: 'device_123',
        })
      );
    });
  });

  describe('Legacy OAuth Device Migration', () => {
    it('should correct deviceId when legacy OAuth has unknown deviceId', async () => {
      mockValidateDeviceToken.mockResolvedValue(mockDeviceRecord({ deviceId: 'unknown' }));

      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'new-device-id',
      });
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'Correcting device token deviceId from OAuth migration',
        expect.anything()
      );
    });

    it('should return 500 if deviceId update fails', async () => {
      mockValidateDeviceToken.mockResolvedValue(mockDeviceRecord({ deviceId: 'unknown' }));
      mockDbUpdateReturning.mockResolvedValue([]);

      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'new-device-id',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update device.');
    });
  });

  describe('User Validation', () => {
    it('should return 404 when user not found', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(null);

      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found for device token.');
    });
  });

  describe('Device Token Rotation', () => {
    it('should rotate token when within 60 days of expiration', async () => {
      const nearExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days from now
      mockValidateDeviceToken.mockResolvedValue(mockDeviceRecord({ expiresAt: nearExpiry }));
      mockRotateDeviceToken.mockResolvedValue({
        token: 'rotated-token',
        deviceToken: { id: 'new-device-record' },
      });

      const request = createRequest({
        deviceToken: 'old-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.deviceToken).toBe('rotated-token');
      expect(mockRotateDeviceToken).toHaveBeenCalled();
    });

    it('should not rotate token when far from expiration', async () => {
      const farExpiry = new Date(Date.now() + 80 * 24 * 60 * 60 * 1000); // 80 days from now
      mockValidateDeviceToken.mockResolvedValue(mockDeviceRecord({ expiresAt: farExpiry }));

      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.deviceToken).toBe('valid-token');
      expect(mockRotateDeviceToken).not.toHaveBeenCalled();
    });
  });

  describe('Mobile/Desktop Response', () => {
    it('should return tokens in JSON for mobile platform', async () => {
      mockValidateDeviceToken.mockResolvedValue(mockDeviceRecord({ platform: 'ios' }));

      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.token).toBe('mock-access-token');
      expect(body.refreshToken).toBe('mock-refresh-token');
      expect(body.csrfToken).toBe('mock-csrf-token');
      expect(body.deviceToken).toBe('valid-token');
    });
  });

  describe('Web Platform Response', () => {
    it('should set cookies for web platform', async () => {
      mockValidateDeviceToken.mockResolvedValue(mockDeviceRecord({ platform: 'web' }));

      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Session refreshed successfully');
      expect(body.csrfToken).toBe('mock-csrf-token');
      expect(body).not.toHaveProperty('token'); // Token in cookie, not body

      const cookies = response.headers.getSetCookie();
      expect(cookies.some(c => c.includes('accessToken'))).toBe(true);
      expect(cookies.some(c => c.includes('refreshToken'))).toBe(true);
    });
  });

  describe('Activity Tracking', () => {
    it('should update device token activity', async () => {
      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'device_123',
      }, { 'x-forwarded-for': '10.0.0.1' });
      await POST(request);

      expect(mockUpdateDeviceTokenActivity).toHaveBeenCalledWith('device_record_123', '10.0.0.1');
    });

    it('should track refresh event', async () => {
      mockValidateDeviceToken.mockResolvedValue(mockDeviceRecord({ platform: 'android' }));

      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'device_123',
        appVersion: '2.0.0',
      });
      await POST(request);

      expect(mockTrackAuthEvent).toHaveBeenCalledWith(
        'user_123',
        'refresh',
        expect.objectContaining({
          platform: 'android',
          appVersion: '2.0.0',
        })
      );
    });
  });

  describe('CSRF Token Generation', () => {
    it('should return 500 if access token decode fails', async () => {
      mockDecodeToken.mockResolvedValue(null);

      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to generate session.');
    });
  });

  describe('Error Handling', () => {
    it('should return 500 on unexpected error', async () => {
      mockValidateDeviceToken.mockRejectedValue(new Error('Database error'));

      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred.');
    });

    it('should log error on failure', async () => {
      mockValidateDeviceToken.mockRejectedValue(new Error('Database error'));

      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'device_123',
      });
      await POST(request);

      expect(mockLoggerError).toHaveBeenCalled();
    });
  });
});
