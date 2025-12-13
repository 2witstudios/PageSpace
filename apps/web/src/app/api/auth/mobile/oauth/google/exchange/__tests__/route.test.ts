import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @pagespace/lib/server
const {
  mockGenerateAccessToken,
  mockGenerateRefreshToken,
  mockGetRefreshTokenMaxAge,
  mockCheckRateLimit,
  mockResetRateLimit,
  mockDecodeToken,
  mockGenerateCSRFToken,
  mockGetSessionIdFromJWT,
  mockValidateOrCreateDeviceToken,
  mockLoggerInfo,
  mockLoggerWarn,
  mockLoggerError,
  mockLogAuthEvent,
  mockVerifyOAuthIdToken,
  mockCreateOrLinkOAuthUser,
  mockSaveRefreshToken,
} = vi.hoisted(() => ({
  mockGenerateAccessToken: vi.fn(),
  mockGenerateRefreshToken: vi.fn(),
  mockGetRefreshTokenMaxAge: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockResetRateLimit: vi.fn(),
  mockDecodeToken: vi.fn(),
  mockGenerateCSRFToken: vi.fn(),
  mockGetSessionIdFromJWT: vi.fn(),
  mockValidateOrCreateDeviceToken: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLogAuthEvent: vi.fn(),
  mockVerifyOAuthIdToken: vi.fn(),
  mockCreateOrLinkOAuthUser: vi.fn(),
  mockSaveRefreshToken: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  generateAccessToken: mockGenerateAccessToken,
  generateRefreshToken: mockGenerateRefreshToken,
  getRefreshTokenMaxAge: mockGetRefreshTokenMaxAge,
  checkRateLimit: mockCheckRateLimit,
  resetRateLimit: mockResetRateLimit,
  decodeToken: mockDecodeToken,
  generateCSRFToken: mockGenerateCSRFToken,
  getSessionIdFromJWT: mockGetSessionIdFromJWT,
  validateOrCreateDeviceToken: mockValidateOrCreateDeviceToken,
  logAuthEvent: mockLogAuthEvent,
  verifyOAuthIdToken: mockVerifyOAuthIdToken,
  createOrLinkOAuthUser: mockCreateOrLinkOAuthUser,
  saveRefreshToken: mockSaveRefreshToken,
  OAuthProvider: { GOOGLE: 'google' },
  loggers: {
    auth: {
      info: mockLoggerInfo,
      warn: mockLoggerWarn,
      error: mockLoggerError,
    },
  },
  RATE_LIMIT_CONFIGS: {
    LOGIN: { maxAttempts: 5, windowMs: 900000, blockDurationMs: 900000 },
  },
}));

// Mock @pagespace/lib/activity-tracker
const { mockTrackAuthEvent } = vi.hoisted(() => ({
  mockTrackAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: mockTrackAuthEvent,
}));

// Import after mocks
import { POST } from '../route';

// Helper to create mock user
const mockUser = (overrides: Partial<{
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  provider: string;
  tokenVersion: number;
  role: 'user' | 'admin';
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  email: overrides.email ?? 'test@example.com',
  name: 'name' in overrides ? overrides.name : 'Test User',
  image: 'image' in overrides ? overrides.image : 'https://example.com/pic.jpg',
  provider: overrides.provider ?? 'google',
  tokenVersion: overrides.tokenVersion ?? 0,
  role: overrides.role ?? 'user',
});

// Helper to create request
const createRequest = (body: Record<string, unknown>, headers?: Record<string, string>) => {
  return new Request('https://example.com/api/auth/mobile/oauth/google/exchange', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
};

describe('POST /api/auth/mobile/oauth/google/exchange', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default rate limits - allowed
    mockCheckRateLimit.mockReturnValue({ allowed: true });

    // Default OAuth verification success
    mockVerifyOAuthIdToken.mockResolvedValue({
      success: true,
      userInfo: {
        email: 'test@example.com',
        name: 'Test User',
        picture: 'https://example.com/pic.jpg',
        provider: 'google',
        providerId: 'google_123',
        emailVerified: true,
      },
    });

    // Default user creation/linking
    mockCreateOrLinkOAuthUser.mockResolvedValue(mockUser());

    // Default token generation
    mockGenerateAccessToken.mockResolvedValue('mock-access-token');
    mockGenerateRefreshToken.mockResolvedValue('mock-refresh-token');
    mockGetRefreshTokenMaxAge.mockReturnValue(30 * 24 * 60 * 60);
    mockDecodeToken.mockResolvedValue({
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    });
    mockValidateOrCreateDeviceToken.mockResolvedValue({
      deviceToken: 'mock-device-token',
      deviceTokenRecordId: 'device_record_123',
    });
    mockGetSessionIdFromJWT.mockReturnValue('mock-session-id');
    mockGenerateCSRFToken.mockReturnValue('mock-csrf-token');
    mockSaveRefreshToken.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Validation', () => {
    it('should return 400 for missing idToken', async () => {
      const request = createRequest({
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.idToken).toBeDefined();
    });

    it('should return 400 for missing deviceId', async () => {
      const request = createRequest({
        idToken: 'google-id-token',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.deviceId).toBeDefined();
    });

    it('should accept valid platform values', async () => {
      for (const platform of ['ios', 'android', 'desktop']) {
        const request = createRequest({
          idToken: 'google-id-token',
          deviceId: 'device_123',
          platform,
        });
        const response = await POST(request);
        expect(response.status).toBe(200);
      }
    });
  });

  describe('Rate Limiting', () => {
    it('should return 429 when IP rate limit exceeded', async () => {
      mockCheckRateLimit.mockReturnValueOnce({ allowed: false, retryAfter: 900 });

      const request = createRequest({
        idToken: 'google-id-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many authentication attempts');
    });

    it('should return 429 when OAuth verification rate limit exceeded', async () => {
      mockCheckRateLimit
        .mockReturnValueOnce({ allowed: true })
        .mockReturnValueOnce({ allowed: false, retryAfter: 300 });

      const request = createRequest({
        idToken: 'google-id-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('OAuth verification');
    });

    it('should return 429 when email rate limit exceeded', async () => {
      mockCheckRateLimit
        .mockReturnValueOnce({ allowed: true })
        .mockReturnValueOnce({ allowed: true })
        .mockReturnValueOnce({ allowed: false, retryAfter: 900 });

      const request = createRequest({
        idToken: 'google-id-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('email');
    });
  });

  describe('ID Token Verification', () => {
    it('should return 401 for invalid ID token', async () => {
      mockVerifyOAuthIdToken.mockResolvedValue({
        success: false,
        error: 'Invalid token',
      });

      const request = createRequest({
        idToken: 'invalid-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid token');
    });

    it('should return 401 when userInfo is missing', async () => {
      mockVerifyOAuthIdToken.mockResolvedValue({
        success: true,
        userInfo: null,
      });

      const request = createRequest({
        idToken: 'invalid-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should call verifyOAuthIdToken with Google provider', async () => {
      const request = createRequest({
        idToken: 'google-id-token',
        deviceId: 'device_123',
      });
      await POST(request);

      expect(mockVerifyOAuthIdToken).toHaveBeenCalledWith('google', 'google-id-token');
    });

    it('should track failed OAuth attempt', async () => {
      mockVerifyOAuthIdToken.mockResolvedValue({
        success: false,
        error: 'Token expired',
      });

      const request = createRequest({
        idToken: 'expired-token',
        deviceId: 'device_123',
        platform: 'ios',
      });
      await POST(request);

      expect(mockTrackAuthEvent).toHaveBeenCalledWith(
        undefined,
        'failed_oauth',
        expect.objectContaining({
          provider: 'google',
          reason: 'Token expired',
        })
      );
    });
  });

  describe('Successful OAuth Exchange', () => {
    it('should return 200 with user and tokens', async () => {
      const request = createRequest({
        idToken: 'valid-google-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.user).toBeDefined();
      expect(body.user.id).toBe('user_123');
      expect(body.user.email).toBe('test@example.com');
      expect(body.token).toBe('mock-access-token');
      expect(body.refreshToken).toBe('mock-refresh-token');
      expect(body.csrfToken).toBe('mock-csrf-token');
      expect(body.deviceToken).toBe('mock-device-token');
    });

    it('should create or link OAuth user', async () => {
      const request = createRequest({
        idToken: 'valid-token',
        deviceId: 'device_123',
      });
      await POST(request);

      expect(mockCreateOrLinkOAuthUser).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'test@example.com',
          provider: 'google',
        })
      );
    });

    it('should save refresh token to database', async () => {
      const request = createRequest({
        idToken: 'valid-token',
        deviceId: 'device_123',
        platform: 'android',
      }, { 'user-agent': 'TestApp/1.0' });
      await POST(request);

      expect(mockSaveRefreshToken).toHaveBeenCalledWith(
        'mock-refresh-token',
        'user_123',
        expect.objectContaining({
          platform: 'android',
          deviceTokenId: 'device_record_123',
        })
      );
    });

    it('should reset all rate limits on success', async () => {
      const request = createRequest({
        idToken: 'valid-token',
        deviceId: 'device_123',
      }, { 'x-forwarded-for': '10.0.0.1' });
      await POST(request);

      expect(mockResetRateLimit).toHaveBeenCalledWith('10.0.0.1');
      expect(mockResetRateLimit).toHaveBeenCalledWith('oauth:10.0.0.1');
      expect(mockResetRateLimit).toHaveBeenCalledWith('test@example.com');
    });

    it('should track successful login', async () => {
      const request = createRequest({
        idToken: 'valid-token',
        deviceId: 'device_123',
        platform: 'ios',
        appVersion: '2.0.0',
      });
      await POST(request);

      expect(mockTrackAuthEvent).toHaveBeenCalledWith(
        'user_123',
        'login',
        expect.objectContaining({
          provider: 'google',
          platform: 'ios',
          appVersion: '2.0.0',
        })
      );
    });

    it('should log successful OAuth', async () => {
      const request = createRequest({
        idToken: 'valid-token',
        deviceId: 'device_123',
      });
      await POST(request);

      expect(mockLoggerInfo).toHaveBeenCalledWith(
        'Mobile OAuth successful',
        expect.objectContaining({ provider: 'google' })
      );
    });
  });

  describe('Device Token Handling', () => {
    it('should create device token with correct params', async () => {
      const request = createRequest({
        idToken: 'valid-token',
        deviceId: 'my-device',
        platform: 'android',
        deviceName: 'Pixel 7',
        deviceToken: 'existing-token',
      }, { 'user-agent': 'TestApp', 'x-forwarded-for': '10.0.0.1' });
      await POST(request);

      expect(mockValidateOrCreateDeviceToken).toHaveBeenCalledWith({
        providedDeviceToken: 'existing-token',
        userId: 'user_123',
        deviceId: 'my-device',
        platform: 'android',
        tokenVersion: 0,
        deviceName: 'Pixel 7',
        userAgent: 'TestApp',
        ipAddress: '10.0.0.1',
      });
    });
  });

  describe('CSRF Token Generation', () => {
    it('should return 500 if access token decode fails', async () => {
      mockDecodeToken.mockResolvedValue(null);

      const request = createRequest({
        idToken: 'valid-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to generate session');
    });
  });

  describe('Error Handling', () => {
    it('should return 500 on unexpected error', async () => {
      mockVerifyOAuthIdToken.mockRejectedValue(new Error('Network error'));

      const request = createRequest({
        idToken: 'valid-token',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred during authentication.');
    });

    it('should track failed OAuth on error', async () => {
      mockCreateOrLinkOAuthUser.mockRejectedValue(new Error('Database error'));

      const request = createRequest({
        idToken: 'valid-token',
        deviceId: 'device_123',
        platform: 'ios',
      });
      await POST(request);

      expect(mockTrackAuthEvent).toHaveBeenCalledWith(
        undefined,
        'failed_oauth',
        expect.objectContaining({
          provider: 'google',
          platform: 'ios',
        })
      );
    });
  });
});
