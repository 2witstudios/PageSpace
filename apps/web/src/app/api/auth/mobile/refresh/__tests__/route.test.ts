import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @pagespace/db
const { mockDbQueryUsersFindFirst } = vi.hoisted(() => ({
  mockDbQueryUsersFindFirst: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: { users: { findFirst: mockDbQueryUsersFindFirst } },
  },
  users: {},
  eq: vi.fn(),
}));

// Mock @pagespace/lib/server
const {
  mockDecodeToken,
  mockGenerateAccessToken,
  mockValidateDeviceToken,
  mockRotateDeviceToken,
  mockUpdateDeviceTokenActivity,
  mockCheckRateLimit,
  mockGenerateCSRFToken,
  mockGetSessionIdFromJWT,
  mockLoggerWarn,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockDecodeToken: vi.fn(),
  mockGenerateAccessToken: vi.fn(),
  mockValidateDeviceToken: vi.fn(),
  mockRotateDeviceToken: vi.fn(),
  mockUpdateDeviceTokenActivity: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockGenerateCSRFToken: vi.fn(),
  mockGetSessionIdFromJWT: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  decodeToken: mockDecodeToken,
  generateAccessToken: mockGenerateAccessToken,
  validateDeviceToken: mockValidateDeviceToken,
  rotateDeviceToken: mockRotateDeviceToken,
  updateDeviceTokenActivity: mockUpdateDeviceTokenActivity,
  checkRateLimit: mockCheckRateLimit,
  generateCSRFToken: mockGenerateCSRFToken,
  getSessionIdFromJWT: mockGetSessionIdFromJWT,
  loggers: {
    auth: {
      warn: mockLoggerWarn,
      error: mockLoggerError,
    },
  },
  RATE_LIMIT_CONFIGS: {
    REFRESH: { maxAttempts: 10, windowMs: 300000, blockDurationMs: 300000 },
  },
}));

// Import after mocks
import { POST } from '../route';

// Helper to create mock user
const mockUser = (overrides: Partial<{
  id: string;
  tokenVersion: number;
  role: 'user' | 'admin';
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  tokenVersion: overrides.tokenVersion ?? 0,
  role: overrides.role ?? 'user',
});

// Helper to create mock device token record
const mockDeviceRecord = (overrides: Partial<{
  id: string;
  deviceId: string;
  userId: string;
  expiresAt: Date;
}> = {}) => ({
  id: overrides.id ?? 'device_record_123',
  deviceId: overrides.deviceId ?? 'device_123',
  userId: overrides.userId ?? 'user_123',
  expiresAt: overrides.expiresAt ?? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
});

// Helper to create request
const createRequest = (body: Record<string, unknown>, headers?: Record<string, string>) => {
  return new Request('https://example.com/api/auth/mobile/refresh', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
};

describe('POST /api/auth/mobile/refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default rate limit - allowed
    mockCheckRateLimit.mockReturnValue({ allowed: true });

    // Default device token valid
    mockValidateDeviceToken.mockResolvedValue(mockDeviceRecord());

    // Default user exists
    mockDbQueryUsersFindFirst.mockResolvedValue(mockUser());

    // Default token generation
    mockGenerateAccessToken.mockResolvedValue('new-access-token');
    mockDecodeToken.mockResolvedValue({
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    });
    mockGetSessionIdFromJWT.mockReturnValue('mock-session-id');
    mockGenerateCSRFToken.mockReturnValue('mock-csrf-token');
    mockUpdateDeviceTokenActivity.mockResolvedValue(undefined);
    mockRotateDeviceToken.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.clearAllMocks();
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

    it('should accept valid platform values', async () => {
      for (const platform of ['ios', 'android', 'desktop']) {
        const request = createRequest({
          deviceToken: 'valid-token',
          deviceId: 'device_123',
          platform,
        });
        const response = await POST(request);
        expect(response.status).toBe(200);
      }
    });
  });

  describe('Rate Limiting', () => {
    it('should return 429 when rate limit exceeded', async () => {
      mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfter: 300 });

      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many refresh attempts');
      expect(response.headers.get('Retry-After')).toBe('300');
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
        'Device token mismatch detected',
        expect.objectContaining({
          tokenDeviceId: 'other-device',
          providedDeviceId: 'device_123',
        })
      );
    });
  });

  describe('User Validation', () => {
    it('should return 401 when user not found', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(null);

      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid or expired device token.');
    });
  });

  describe('Device Token Rotation', () => {
    it('should rotate token when within 7 days of expiration', async () => {
      const nearExpiry = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5 days from now
      mockValidateDeviceToken.mockResolvedValue(mockDeviceRecord({ expiresAt: nearExpiry }));
      mockRotateDeviceToken.mockResolvedValue({
        token: 'rotated-token',
        deviceToken: { id: 'new-device-record' },
      });

      const request = createRequest({
        deviceToken: 'old-token',
        deviceId: 'device_123',
      }, { 'user-agent': 'TestApp' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.deviceToken).toBe('rotated-token');
      expect(mockRotateDeviceToken).toHaveBeenCalled();
    });

    it('should not rotate token when not near expiration', async () => {
      const farExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days from now
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

  describe('Successful Refresh', () => {
    it('should return 200 with tokens', async () => {
      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.token).toBe('new-access-token');
      expect(body.csrfToken).toBe('mock-csrf-token');
      expect(body.deviceToken).toBe('valid-token');
    });

    it('should update device token activity', async () => {
      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'device_123',
      }, { 'x-forwarded-for': '10.0.0.1' });
      await POST(request);

      expect(mockUpdateDeviceTokenActivity).toHaveBeenCalledWith('device_record_123', '10.0.0.1');
    });

    it('should normalize unknown IP to undefined', async () => {
      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'device_123',
      });
      await POST(request);

      expect(mockUpdateDeviceTokenActivity).toHaveBeenCalledWith('device_record_123', undefined);
    });

    it('should generate access token with correct params', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser({
        id: 'user_456',
        tokenVersion: 3,
        role: 'admin',
      }));

      const request = createRequest({
        deviceToken: 'valid-token',
        deviceId: 'device_123',
      });
      await POST(request);

      expect(mockGenerateAccessToken).toHaveBeenCalledWith('user_456', 3, 'admin');
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
  });
});
