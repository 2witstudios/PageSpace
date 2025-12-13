import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

// Mock auth module
const { mockAuthenticateRequestWithOptions, mockIsAuthError } = vi.hoisted(() => ({
  mockAuthenticateRequestWithOptions: vi.fn(),
  mockIsAuthError: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: mockAuthenticateRequestWithOptions,
  isAuthError: mockIsAuthError,
}));

// Mock @pagespace/lib/device-auth-utils
const { mockRevokeDeviceTokenByValue, mockRevokeDeviceTokensByDevice } = vi.hoisted(() => ({
  mockRevokeDeviceTokenByValue: vi.fn(),
  mockRevokeDeviceTokensByDevice: vi.fn(),
}));

vi.mock('@pagespace/lib/device-auth-utils', () => ({
  revokeDeviceTokenByValue: mockRevokeDeviceTokenByValue,
  revokeDeviceTokensByDevice: mockRevokeDeviceTokensByDevice,
}));

// Mock @pagespace/lib/server
const { mockLogAuthEvent, mockLoggers } = vi.hoisted(() => ({
  mockLogAuthEvent: vi.fn(),
  mockLoggers: {
    auth: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/server', () => ({
  logAuthEvent: mockLogAuthEvent,
  loggers: mockLoggers,
}));

// Mock @pagespace/lib/activity-tracker
const { mockTrackAuthEvent } = vi.hoisted(() => ({
  mockTrackAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: mockTrackAuthEvent,
}));

// Mock database
const { mockDbDeleteWhere } = vi.hoisted(() => ({
  mockDbDeleteWhere: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    delete: vi.fn(() => ({
      where: mockDbDeleteWhere,
    })),
  },
  refreshTokens: {},
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
}));

// Mock cookie
vi.mock('cookie', () => ({
  parse: vi.fn((cookieStr: string) => {
    const cookies: Record<string, string> = {};
    if (cookieStr) {
      cookieStr.split(';').forEach(pair => {
        const [key, value] = pair.trim().split('=');
        if (key && value) cookies[key] = value;
      });
    }
    return cookies;
  }),
  serialize: vi.fn((name: string, value: string) => `${name}=${value}`),
}));

// Import after mocks
import { POST } from '../route';

// Helper to create mock auth result
const mockWebAuth = (userId: string) => ({
  userId,
  tokenVersion: 0,
  tokenType: 'jwt' as const,
  source: 'cookie' as const,
  role: 'user' as const,
});

// Helper to create mock auth error
const mockAuthError = (status = 401) => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create request
const createRequest = (options: {
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
  body?: object;
} = {}) => {
  const cookieHeader = options.cookies
    ? Object.entries(options.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    : '';

  return new Request('https://example.com/api/auth/logout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader && { cookie: cookieHeader }),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
};

describe('POST /api/auth/logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default auth success
    mockAuthenticateRequestWithOptions.mockResolvedValue(mockWebAuth('user_123'));
    mockIsAuthError.mockReturnValue(false);

    // Default DB operations
    mockDbDeleteWhere.mockResolvedValue(undefined);

    // Default device token operations
    mockRevokeDeviceTokenByValue.mockResolvedValue(true);
    mockRevokeDeviceTokensByDevice.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication', () => {
    it('should return 401 when not authenticated', async () => {
      mockIsAuthError.mockReturnValue(true);
      mockAuthenticateRequestWithOptions.mockResolvedValue(mockAuthError(401));

      const request = createRequest();
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should require JWT authentication with CSRF', async () => {
      const request = createRequest();
      await POST(request);

      expect(mockAuthenticateRequestWithOptions).toHaveBeenCalledWith(
        expect.any(Request),
        { allow: ['jwt'], requireCSRF: true }
      );
    });
  });

  describe('Refresh Token Revocation', () => {
    it('should delete refresh token from database', async () => {
      const request = createRequest({
        cookies: { refreshToken: 'valid-refresh-token' },
      });

      await POST(request);

      expect(mockDbDeleteWhere).toHaveBeenCalled();
    });

    it('should handle missing refresh token gracefully', async () => {
      const request = createRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Logged out successfully');
    });

    it('should handle database error when deleting refresh token', async () => {
      mockDbDeleteWhere.mockRejectedValue(new Error('Token not found'));

      const request = createRequest({
        cookies: { refreshToken: 'invalid-token' },
      });

      const response = await POST(request);
      const body = await response.json();

      // Should still succeed - logout continues
      expect(response.status).toBe(200);
      expect(body.message).toBe('Logged out successfully');

      expect(mockLoggers.auth.debug).toHaveBeenCalledWith(
        'Refresh token not found in DB during logout',
        expect.any(Object)
      );
    });
  });

  describe('Device Token Revocation - Web (Header)', () => {
    it('should revoke device token from header', async () => {
      const request = createRequest({
        headers: { 'X-Device-Token': 'device-token-123' },
      });

      await POST(request);

      expect(mockRevokeDeviceTokenByValue).toHaveBeenCalledWith(
        'device-token-123',
        'logout'
      );
    });

    it('should log success when device token revoked', async () => {
      mockRevokeDeviceTokenByValue.mockResolvedValue(true);

      const request = createRequest({
        headers: { 'X-Device-Token': 'device-token-123' },
      });

      await POST(request);

      expect(mockLoggers.auth.debug).toHaveBeenCalledWith(
        'Device token revoked on logout',
        { userId: 'user_123', source: 'header' }
      );
    });

    it('should handle device token revocation failure gracefully', async () => {
      mockRevokeDeviceTokenByValue.mockRejectedValue(new Error('Revocation failed'));

      const request = createRequest({
        headers: { 'X-Device-Token': 'device-token-123' },
      });

      const response = await POST(request);
      const body = await response.json();

      // Should still succeed
      expect(response.status).toBe(200);
      expect(body.message).toBe('Logged out successfully');

      expect(mockLoggers.auth.error).toHaveBeenCalledWith(
        'Failed to revoke device token on logout',
        expect.objectContaining({
          error: 'Revocation failed',
          userId: 'user_123',
        })
      );
    });
  });

  describe('Device Token Revocation - Desktop (Body)', () => {
    it('should revoke device token by deviceId and platform from body', async () => {
      const request = createRequest({
        body: { deviceId: 'desktop-device-123', platform: 'desktop' },
      });

      await POST(request);

      expect(mockRevokeDeviceTokensByDevice).toHaveBeenCalledWith(
        'user_123',
        'desktop-device-123',
        'desktop',
        'logout'
      );
    });

    it('should log count of revoked device tokens', async () => {
      mockRevokeDeviceTokensByDevice.mockResolvedValue(2);

      const request = createRequest({
        body: { deviceId: 'desktop-device-123', platform: 'desktop' },
      });

      await POST(request);

      expect(mockLoggers.auth.debug).toHaveBeenCalledWith(
        'Device tokens revoked on logout',
        {
          userId: 'user_123',
          deviceId: 'desktop-device-123',
          platform: 'desktop',
          count: 2,
        }
      );
    });

    it('should not log when no device tokens revoked', async () => {
      mockRevokeDeviceTokensByDevice.mockResolvedValue(0);

      const request = createRequest({
        body: { deviceId: 'desktop-device-123', platform: 'desktop' },
      });

      await POST(request);

      expect(mockLoggers.auth.debug).not.toHaveBeenCalledWith(
        'Device tokens revoked on logout',
        expect.anything()
      );
    });

    it('should handle body parsing error gracefully', async () => {
      // No body provided - should not error
      const request = createRequest();
      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it('should handle desktop device token revocation failure', async () => {
      mockRevokeDeviceTokensByDevice.mockRejectedValue(new Error('Revocation failed'));

      const request = createRequest({
        body: { deviceId: 'desktop-device-123', platform: 'desktop' },
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Logged out successfully');

      expect(mockLoggers.auth.error).toHaveBeenCalledWith(
        'Failed to revoke device tokens on logout',
        expect.objectContaining({
          error: 'Revocation failed',
          deviceId: 'desktop-device-123',
        })
      );
    });
  });

  describe('Device Token Priority', () => {
    it('should prefer header device token over body', async () => {
      const request = createRequest({
        headers: { 'X-Device-Token': 'header-token' },
        body: { deviceId: 'body-device', platform: 'web' },
      });

      await POST(request);

      // Header takes priority
      expect(mockRevokeDeviceTokenByValue).toHaveBeenCalledWith('header-token', 'logout');
      expect(mockRevokeDeviceTokensByDevice).not.toHaveBeenCalled();
    });
  });

  describe('Logging and Tracking', () => {
    it('should log logout event', async () => {
      const request = createRequest({
        headers: { 'x-forwarded-for': '192.168.1.1' },
      });

      await POST(request);

      expect(mockLogAuthEvent).toHaveBeenCalledWith(
        'logout',
        'user_123',
        undefined,
        '192.168.1.1'
      );
    });

    it('should track logout event', async () => {
      const request = createRequest({
        headers: {
          'x-forwarded-for': '192.168.1.1',
          'user-agent': 'Test Agent',
        },
      });

      await POST(request);

      expect(mockTrackAuthEvent).toHaveBeenCalledWith(
        'user_123',
        'logout',
        {
          ip: '192.168.1.1',
          userAgent: 'Test Agent',
        }
      );
    });
  });

  describe('Cookie Clearing', () => {
    it('should clear access and refresh token cookies', async () => {
      const request = createRequest({
        cookies: {
          accessToken: 'old-access-token',
          refreshToken: 'old-refresh-token',
        },
      });

      const response = await POST(request);

      const cookies = response.headers.getSetCookie();
      expect(cookies.some(c => c.includes('accessToken'))).toBe(true);
      expect(cookies.some(c => c.includes('refreshToken'))).toBe(true);
    });

    it('should return success message', async () => {
      const request = createRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Logged out successfully');
    });
  });

  describe('IP Address Extraction', () => {
    it('should extract IP from x-forwarded-for', async () => {
      const request = createRequest({
        headers: { 'x-forwarded-for': '203.0.113.1, 198.51.100.178' },
      });

      await POST(request);

      expect(mockLogAuthEvent).toHaveBeenCalledWith(
        'logout',
        'user_123',
        undefined,
        '203.0.113.1'
      );
    });

    it('should extract IP from x-real-ip', async () => {
      const request = createRequest({
        headers: { 'x-real-ip': '10.0.0.50' },
      });

      await POST(request);

      expect(mockLogAuthEvent).toHaveBeenCalledWith(
        'logout',
        'user_123',
        undefined,
        '10.0.0.50'
      );
    });

    it('should use "unknown" when no IP headers', async () => {
      const request = createRequest();
      await POST(request);

      expect(mockLogAuthEvent).toHaveBeenCalledWith(
        'logout',
        'user_123',
        undefined,
        'unknown'
      );
    });
  });
});
