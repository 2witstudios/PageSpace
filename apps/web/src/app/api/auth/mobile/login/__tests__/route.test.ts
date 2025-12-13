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

// Mock bcryptjs
const { mockBcryptCompare } = vi.hoisted(() => ({
  mockBcryptCompare: vi.fn(),
}));

vi.mock('bcryptjs', () => ({
  default: { compare: mockBcryptCompare },
  compare: mockBcryptCompare,
}));

// Mock @pagespace/lib/server
const {
  mockGenerateAccessToken,
  mockCheckRateLimit,
  mockResetRateLimit,
  mockDecodeToken,
  mockValidateOrCreateDeviceToken,
  mockGenerateCSRFToken,
  mockGetSessionIdFromJWT,
  mockLoggerError,
  mockLogAuthEvent,
} = vi.hoisted(() => ({
  mockGenerateAccessToken: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockResetRateLimit: vi.fn(),
  mockDecodeToken: vi.fn(),
  mockValidateOrCreateDeviceToken: vi.fn(),
  mockGenerateCSRFToken: vi.fn(),
  mockGetSessionIdFromJWT: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLogAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  generateAccessToken: mockGenerateAccessToken,
  checkRateLimit: mockCheckRateLimit,
  resetRateLimit: mockResetRateLimit,
  decodeToken: mockDecodeToken,
  validateOrCreateDeviceToken: mockValidateOrCreateDeviceToken,
  generateCSRFToken: mockGenerateCSRFToken,
  getSessionIdFromJWT: mockGetSessionIdFromJWT,
  logAuthEvent: mockLogAuthEvent,
  loggers: {
    auth: {
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
  password: string | null;
  tokenVersion: number;
  role: 'user' | 'admin';
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  email: overrides.email ?? 'test@example.com',
  name: 'name' in overrides ? overrides.name : 'Test User',
  image: 'image' in overrides ? overrides.image : null,
  password: 'password' in overrides ? overrides.password : '$2a$12$hashedpassword',
  tokenVersion: overrides.tokenVersion ?? 0,
  role: overrides.role ?? 'user',
});

// Helper to create request
const createRequest = (body: Record<string, unknown>, headers?: Record<string, string>) => {
  return new Request('https://example.com/api/auth/mobile/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
};

describe('POST /api/auth/mobile/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default rate limit - allowed
    mockCheckRateLimit.mockReturnValue({ allowed: true, attemptsRemaining: 4 });

    // Default user exists with password
    mockDbQueryUsersFindFirst.mockResolvedValue(mockUser());

    // Default password valid
    mockBcryptCompare.mockResolvedValue(true);

    // Default token generation
    mockGenerateAccessToken.mockResolvedValue('mock-access-token');
    mockDecodeToken.mockResolvedValue({
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    });
    mockValidateOrCreateDeviceToken.mockResolvedValue({ deviceToken: 'mock-device-token' });
    mockGetSessionIdFromJWT.mockReturnValue('mock-session-id');
    mockGenerateCSRFToken.mockReturnValue('mock-csrf-token');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Validation', () => {
    it('should return 400 for missing email', async () => {
      const request = createRequest({
        password: 'validPassword123',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors).toBeDefined();
    });

    it('should return 400 for invalid email', async () => {
      const request = createRequest({
        email: 'not-an-email',
        password: 'validPassword123',
        deviceId: 'device_123',
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('should return 400 for missing password', async () => {
      const request = createRequest({
        email: 'test@example.com',
        deviceId: 'device_123',
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('should return 400 for missing deviceId', async () => {
      const request = createRequest({
        email: 'test@example.com',
        password: 'validPassword123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.deviceId).toBeDefined();
    });

    it('should accept valid platform values', async () => {
      for (const platform of ['ios', 'android', 'desktop']) {
        const request = createRequest({
          email: 'test@example.com',
          password: 'validPassword123',
          deviceId: 'device_123',
          platform,
        });
        const response = await POST(request);
        expect(response.status).toBe(200);
      }
    });

    it('should reject invalid platform', async () => {
      const request = createRequest({
        email: 'test@example.com',
        password: 'validPassword123',
        deviceId: 'device_123',
        platform: 'web',
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });
  });

  describe('Rate Limiting', () => {
    it('should return 429 when IP rate limit exceeded', async () => {
      mockCheckRateLimit.mockReturnValueOnce({ allowed: false, retryAfter: 900 });

      const request = createRequest({
        email: 'test@example.com',
        password: 'password',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('IP address');
      expect(response.headers.get('Retry-After')).toBe('900');
    });

    it('should return 429 when email rate limit exceeded', async () => {
      mockCheckRateLimit
        .mockReturnValueOnce({ allowed: true })
        .mockReturnValueOnce({ allowed: false, retryAfter: 600 });

      const request = createRequest({
        email: 'test@example.com',
        password: 'password',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('email');
    });
  });

  describe('Authentication', () => {
    it('should return 401 for non-existent user', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(null);
      mockBcryptCompare.mockResolvedValue(false); // Fake hash check

      const request = createRequest({
        email: 'nonexistent@example.com',
        password: 'password',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid email or password');
    });

    it('should return 401 for user without password (OAuth only)', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser({ password: null }));

      const request = createRequest({
        email: 'oauth@example.com',
        password: 'password',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid email or password');
    });

    it('should return 401 for wrong password', async () => {
      mockBcryptCompare.mockResolvedValue(false);

      const request = createRequest({
        email: 'test@example.com',
        password: 'wrongpassword',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid email or password');
    });

    it('should always perform bcrypt compare (timing attack prevention)', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(null);

      const request = createRequest({
        email: 'nonexistent@example.com',
        password: 'password',
        deviceId: 'device_123',
      });
      await POST(request);

      expect(mockBcryptCompare).toHaveBeenCalled();
    });
  });

  describe('Successful Login', () => {
    it('should return 200 with user and tokens', async () => {
      const request = createRequest({
        email: 'test@example.com',
        password: 'validPassword',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.user).toBeDefined();
      expect(body.user.id).toBe('user_123');
      expect(body.user.email).toBe('test@example.com');
      expect(body.token).toBe('mock-access-token');
      expect(body.csrfToken).toBe('mock-csrf-token');
      expect(body.deviceToken).toBe('mock-device-token');
    });

    it('should generate access token with correct params', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser({
        id: 'user_456',
        tokenVersion: 2,
        role: 'admin',
      }));

      const request = createRequest({
        email: 'test@example.com',
        password: 'password',
        deviceId: 'device_123',
      });
      await POST(request);

      expect(mockGenerateAccessToken).toHaveBeenCalledWith('user_456', 2, 'admin');
    });

    it('should create device token with correct params', async () => {
      const request = createRequest({
        email: 'test@example.com',
        password: 'password',
        deviceId: 'my-device-id',
        platform: 'android',
        deviceName: 'Pixel 7',
        deviceToken: 'existing-token',
      }, { 'user-agent': 'MyApp/1.0' });
      await POST(request);

      expect(mockValidateOrCreateDeviceToken).toHaveBeenCalledWith({
        providedDeviceToken: 'existing-token',
        userId: 'user_123',
        deviceId: 'my-device-id',
        platform: 'android',
        tokenVersion: 0,
        deviceName: 'Pixel 7',
        userAgent: 'MyApp/1.0',
        ipAddress: 'unknown',
      });
    });

    it('should reset rate limits on success', async () => {
      const request = createRequest({
        email: 'test@example.com',
        password: 'password',
        deviceId: 'device_123',
      });
      await POST(request);

      expect(mockResetRateLimit).toHaveBeenCalledWith('unknown');
      expect(mockResetRateLimit).toHaveBeenCalledWith('test@example.com');
    });

    it('should track login event', async () => {
      const request = createRequest({
        email: 'test@example.com',
        password: 'password',
        deviceId: 'device_123',
        platform: 'ios',
        appVersion: '1.0.0',
      }, { 'user-agent': 'MyApp' });
      await POST(request);

      expect(mockTrackAuthEvent).toHaveBeenCalledWith(
        'user_123',
        'login',
        expect.objectContaining({
          platform: 'ios',
          appVersion: '1.0.0',
        })
      );
    });
  });

  describe('CSRF Token Generation', () => {
    it('should return 500 if access token decode fails', async () => {
      mockDecodeToken.mockResolvedValue(null);

      const request = createRequest({
        email: 'test@example.com',
        password: 'password',
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
      mockDbQueryUsersFindFirst.mockRejectedValue(new Error('Database error'));

      const request = createRequest({
        email: 'test@example.com',
        password: 'password',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred.');
    });

    it('should log error on failure', async () => {
      mockDbQueryUsersFindFirst.mockRejectedValue(new Error('Database error'));

      const request = createRequest({
        email: 'test@example.com',
        password: 'password',
        deviceId: 'device_123',
      });
      await POST(request);

      expect(mockLoggerError).toHaveBeenCalled();
    });
  });
});
