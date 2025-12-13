import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock bcryptjs - use vi.hoisted to ensure mocks are available before vi.mock
const { mockBcryptCompare } = vi.hoisted(() => {
  return {
    mockBcryptCompare: vi.fn(),
  };
});

vi.mock('bcryptjs', () => ({
  default: {
    compare: mockBcryptCompare,
  },
  compare: mockBcryptCompare,
}));

// Mock @pagespace/lib/server - rate limiting, token generation, logging
const {
  mockCheckRateLimit,
  mockResetRateLimit,
  mockGenerateAccessToken,
  mockGenerateRefreshToken,
  mockGetRefreshTokenMaxAge,
  mockDecodeToken,
  mockValidateOrCreateDeviceToken,
  mockLogAuthEvent,
  mockLoggers,
} = vi.hoisted(() => {
  return {
    mockCheckRateLimit: vi.fn(),
    mockResetRateLimit: vi.fn(),
    mockGenerateAccessToken: vi.fn(),
    mockGenerateRefreshToken: vi.fn(),
    mockGetRefreshTokenMaxAge: vi.fn(),
    mockDecodeToken: vi.fn(),
    mockValidateOrCreateDeviceToken: vi.fn(),
    mockLogAuthEvent: vi.fn(),
    mockLoggers: {
      auth: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
    },
  };
});

vi.mock('@pagespace/lib/server', () => ({
  checkRateLimit: mockCheckRateLimit,
  resetRateLimit: mockResetRateLimit,
  generateAccessToken: mockGenerateAccessToken,
  generateRefreshToken: mockGenerateRefreshToken,
  getRefreshTokenMaxAge: mockGetRefreshTokenMaxAge,
  decodeToken: mockDecodeToken,
  validateOrCreateDeviceToken: mockValidateOrCreateDeviceToken,
  logAuthEvent: mockLogAuthEvent,
  loggers: mockLoggers,
  RATE_LIMIT_CONFIGS: {
    LOGIN: {
      maxAttempts: 5,
      windowMs: 15 * 60 * 1000,
      blockDurationMs: 15 * 60 * 1000,
      progressiveDelay: true,
    },
  },
}));

// Mock @pagespace/lib/activity-tracker
const { mockTrackAuthEvent } = vi.hoisted(() => {
  return {
    mockTrackAuthEvent: vi.fn(),
  };
});

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: mockTrackAuthEvent,
}));

// Mock database - use vi.hoisted for all mock functions
const { mockDbQueryUsersFindFirst, mockDbInsertValues } = vi.hoisted(() => {
  return {
    mockDbQueryUsersFindFirst: vi.fn(),
    mockDbInsertValues: vi.fn(),
  };
});

vi.mock('@pagespace/db', () => {
  return {
    db: {
      query: {
        users: {
          findFirst: mockDbQueryUsersFindFirst,
        },
      },
      insert: vi.fn(() => ({
        values: mockDbInsertValues,
      })),
    },
    users: {},
    refreshTokens: {},
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  };
});

// Mock @paralleldrive/cuid2
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-cuid'),
}));

// Mock cookie serialize
vi.mock('cookie', () => ({
  serialize: vi.fn((name: string, value: string) => `${name}=${value}`),
}));

// Import after mocks
import { POST } from '../route';

// Helper to create mock user
const mockUser = (overrides: Partial<{
  id: string;
  email: string;
  password: string | null;
  name: string;
  tokenVersion: number;
  role: 'user' | 'admin';
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  email: overrides.email ?? 'test@example.com',
  password: overrides.password ?? '$2a$12$hashedpassword',
  name: overrides.name ?? 'Test User',
  tokenVersion: overrides.tokenVersion ?? 0,
  role: overrides.role ?? 'user',
});

// Helper to create request
const createRequest = (body: object, headers: Record<string, string> = {}) => {
  return new Request('https://example.com/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
};

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default rate limit - allowed
    mockCheckRateLimit.mockReturnValue({ allowed: true, attemptsRemaining: 4 });

    // Default token generation
    mockGenerateAccessToken.mockResolvedValue('mock-access-token');
    mockGenerateRefreshToken.mockResolvedValue('mock-refresh-token');
    mockGetRefreshTokenMaxAge.mockReturnValue(30 * 24 * 60 * 60); // 30 days
    mockDecodeToken.mockResolvedValue({
      userId: 'user_123',
      tokenVersion: 0,
      role: 'user',
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    });

    // Default database insert success
    mockDbInsertValues.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Use clearAllMocks instead of resetAllMocks to preserve mock implementations
    vi.clearAllMocks();
  });

  describe('Input Validation', () => {
    it('should return 400 when email is missing', async () => {
      const request = createRequest({ password: 'password123' });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors).toBeDefined();
      expect(body.errors.email).toBeDefined();
    });

    it('should return 400 when email format is invalid', async () => {
      const request = createRequest({
        email: 'not-an-email',
        password: 'password123',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors).toBeDefined();
      expect(body.errors.email).toBeDefined();
    });

    it('should return 400 when password is missing', async () => {
      const request = createRequest({ email: 'test@example.com' });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors).toBeDefined();
      expect(body.errors.password).toBeDefined();
    });

    it('should return 400 when password is empty string', async () => {
      const request = createRequest({
        email: 'test@example.com',
        password: '',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors).toBeDefined();
      expect(body.errors.password).toBeDefined();
    });

    it('should return 400 when request body is invalid JSON', async () => {
      const request = new Request('https://example.com/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred.');
    });
  });

  describe('Rate Limiting', () => {
    it('should return 429 when IP rate limit is exceeded', async () => {
      mockCheckRateLimit.mockReturnValueOnce({
        allowed: false,
        retryAfter: 900,
      });

      const request = createRequest({
        email: 'test@example.com',
        password: 'password123',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many login attempts from this IP');
      expect(body.retryAfter).toBe(900);
      expect(response.headers.get('Retry-After')).toBe('900');
    });

    it('should return 429 when email rate limit is exceeded', async () => {
      // First call (IP check) passes, second call (email check) fails
      mockCheckRateLimit
        .mockReturnValueOnce({ allowed: true, attemptsRemaining: 4 })
        .mockReturnValueOnce({ allowed: false, retryAfter: 900 });

      const request = createRequest({
        email: 'test@example.com',
        password: 'password123',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many login attempts for this email');
      expect(body.retryAfter).toBe(900);
    });

    it('should check rate limit with correct identifiers', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser());
      mockBcryptCompare.mockResolvedValue(true);

      const request = createRequest(
        { email: 'Test@Example.COM', password: 'password123' },
        { 'x-forwarded-for': '192.168.1.1' }
      );

      await POST(request);

      // Should check IP first, then lowercase email
      expect(mockCheckRateLimit).toHaveBeenCalledTimes(2);
      expect(mockCheckRateLimit).toHaveBeenNthCalledWith(
        1,
        '192.168.1.1',
        expect.any(Object)
      );
      expect(mockCheckRateLimit).toHaveBeenNthCalledWith(
        2,
        'test@example.com',
        expect.any(Object)
      );
    });

    it('should reset rate limits on successful login', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser());
      mockBcryptCompare.mockResolvedValue(true);

      const request = createRequest(
        { email: 'test@example.com', password: 'password123' },
        { 'x-forwarded-for': '192.168.1.1' }
      );

      await POST(request);

      expect(mockResetRateLimit).toHaveBeenCalledWith('192.168.1.1');
      expect(mockResetRateLimit).toHaveBeenCalledWith('test@example.com');
    });
  });

  describe('Authentication - Timing Attack Prevention', () => {
    it('should always compare password even when user not found to prevent timing attacks', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(null);
      mockBcryptCompare.mockResolvedValue(false);

      const request = createRequest({
        email: 'nonexistent@example.com',
        password: 'password123',
      });

      await POST(request);

      // bcrypt.compare should still be called with a fake hash
      expect(mockBcryptCompare).toHaveBeenCalledTimes(1);
      expect(mockBcryptCompare).toHaveBeenCalledWith(
        'password123',
        expect.stringContaining('$2a$12$') // Should be called with a bcrypt hash
      );
    });

    it('should return 401 with generic error for non-existent user', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(null);
      mockBcryptCompare.mockResolvedValue(false);

      const request = createRequest({
        email: 'nonexistent@example.com',
        password: 'password123',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      // Generic error that doesn't reveal whether email exists
      expect(body.error).toBe('Invalid email or password');
      // Should NOT reveal specific details like "not found" or "does not exist"
      expect(body.error).not.toContain('not found');
      expect(body.error).not.toContain('does not exist');
    });
  });

  describe('Authentication - Invalid Credentials', () => {
    it('should return 401 when password is incorrect', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser());
      mockBcryptCompare.mockResolvedValue(false);

      const request = createRequest({
        email: 'test@example.com',
        password: 'wrongpassword',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid email or password');
    });

    it('should return 401 when user has no password (OAuth-only account)', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser({ password: null }));
      mockBcryptCompare.mockResolvedValue(false);

      const request = createRequest({
        email: 'oauth@example.com',
        password: 'anypassword',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid email or password');
    });

    it('should log failed login attempt with reason', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(null);
      mockBcryptCompare.mockResolvedValue(false);

      const request = createRequest(
        { email: 'nonexistent@example.com', password: 'password123' },
        { 'x-forwarded-for': '192.168.1.1' }
      );

      await POST(request);

      expect(mockLogAuthEvent).toHaveBeenCalledWith(
        'failed',
        undefined,
        'nonexistent@example.com',
        '192.168.1.1',
        'Invalid email'
      );
    });

    it('should track failed login attempt', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser());
      mockBcryptCompare.mockResolvedValue(false);

      const request = createRequest(
        { email: 'test@example.com', password: 'wrongpassword' },
        { 'x-forwarded-for': '192.168.1.1' }
      );

      await POST(request);

      expect(mockTrackAuthEvent).toHaveBeenCalledWith(
        'user_123',
        'failed_login',
        expect.objectContaining({
          reason: 'invalid_password',
          email: 'test@example.com',
          ip: '192.168.1.1',
        })
      );
    });
  });

  describe('Successful Authentication', () => {
    beforeEach(() => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser());
      mockBcryptCompare.mockResolvedValue(true);
    });

    it('should return 200 with user data on successful login', async () => {
      const request = createRequest({
        email: 'test@example.com',
        password: 'correctpassword',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.id).toBe('user_123');
      expect(body.name).toBe('Test User');
      expect(body.email).toBe('test@example.com');
    });

    it('should set access token and refresh token cookies', async () => {
      const request = createRequest({
        email: 'test@example.com',
        password: 'correctpassword',
      });

      const response = await POST(request);

      const cookies = response.headers.getSetCookie();
      expect(cookies).toHaveLength(2);
      expect(cookies.some(c => c.includes('accessToken'))).toBe(true);
      expect(cookies.some(c => c.includes('refreshToken'))).toBe(true);
    });

    it('should generate tokens with correct user data', async () => {
      const user = mockUser({ id: 'user_456', tokenVersion: 2, role: 'admin' });
      mockDbQueryUsersFindFirst.mockResolvedValue(user);

      const request = createRequest({
        email: 'admin@example.com',
        password: 'correctpassword',
      });

      await POST(request);

      expect(mockGenerateAccessToken).toHaveBeenCalledWith('user_456', 2, 'admin');
      expect(mockGenerateRefreshToken).toHaveBeenCalledWith('user_456', 2, 'admin');
    });

    it('should store refresh token in database', async () => {
      const request = createRequest(
        { email: 'test@example.com', password: 'correctpassword' },
        { 'user-agent': 'Mozilla/5.0 Test', 'x-forwarded-for': '10.0.0.1' }
      );

      await POST(request);

      expect(mockDbInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'mock-cuid',
          token: 'mock-refresh-token',
          userId: 'user_123',
          device: 'Mozilla/5.0 Test',
          userAgent: 'Mozilla/5.0 Test',
          ip: '10.0.0.1',
          platform: 'web',
        })
      );
    });

    it('should log successful login', async () => {
      const request = createRequest(
        { email: 'test@example.com', password: 'correctpassword' },
        { 'x-forwarded-for': '192.168.1.1' }
      );

      await POST(request);

      expect(mockLogAuthEvent).toHaveBeenCalledWith(
        'login',
        'user_123',
        'test@example.com',
        '192.168.1.1'
      );
    });

    it('should track successful login event', async () => {
      const request = createRequest(
        { email: 'test@example.com', password: 'correctpassword' },
        { 'x-forwarded-for': '192.168.1.1', 'user-agent': 'Test Agent' }
      );

      await POST(request);

      expect(mockTrackAuthEvent).toHaveBeenCalledWith(
        'user_123',
        'login',
        expect.objectContaining({
          email: 'test@example.com',
          ip: '192.168.1.1',
          userAgent: 'Test Agent',
        })
      );
    });
  });

  describe('Device Token Handling', () => {
    beforeEach(() => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser());
      mockBcryptCompare.mockResolvedValue(true);
    });

    it('should create device token when deviceId is provided', async () => {
      mockValidateOrCreateDeviceToken.mockResolvedValue({
        deviceToken: 'new-device-token',
        deviceTokenRecordId: 'device-record-123',
      });

      const request = createRequest(
        {
          email: 'test@example.com',
          password: 'correctpassword',
          deviceId: 'device-abc',
          deviceName: 'My Browser',
        },
        { 'user-agent': 'Test Agent', 'x-forwarded-for': '192.168.1.1' }
      );

      const response = await POST(request);
      const body = await response.json();

      expect(mockValidateOrCreateDeviceToken).toHaveBeenCalledWith({
        providedDeviceToken: undefined,
        userId: 'user_123',
        deviceId: 'device-abc',
        platform: 'web',
        tokenVersion: 0,
        deviceName: 'My Browser',
        userAgent: 'Test Agent',
        ipAddress: '192.168.1.1',
      });

      expect(body.deviceToken).toBe('new-device-token');
    });

    it('should validate existing device token when provided', async () => {
      mockValidateOrCreateDeviceToken.mockResolvedValue({
        deviceToken: 'validated-token',
        deviceTokenRecordId: 'device-record-456',
      });

      const request = createRequest({
        email: 'test@example.com',
        password: 'correctpassword',
        deviceId: 'device-abc',
        deviceToken: 'existing-device-token',
      });

      await POST(request);

      expect(mockValidateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          providedDeviceToken: 'existing-device-token',
        })
      );
    });

    it('should link refresh token to device token', async () => {
      mockValidateOrCreateDeviceToken.mockResolvedValue({
        deviceToken: 'device-token',
        deviceTokenRecordId: 'device-record-789',
      });

      const request = createRequest({
        email: 'test@example.com',
        password: 'correctpassword',
        deviceId: 'device-abc',
      });

      await POST(request);

      expect(mockDbInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceTokenId: 'device-record-789',
        })
      );
    });

    it('should not include deviceToken in response when deviceId not provided', async () => {
      const request = createRequest({
        email: 'test@example.com',
        password: 'correctpassword',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(body.deviceToken).toBeUndefined();
      expect(mockValidateOrCreateDeviceToken).not.toHaveBeenCalled();
    });
  });

  describe('IP Address Extraction', () => {
    beforeEach(() => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser());
      mockBcryptCompare.mockResolvedValue(true);
    });

    it('should extract IP from x-forwarded-for header (first IP)', async () => {
      const request = createRequest(
        { email: 'test@example.com', password: 'password' },
        { 'x-forwarded-for': '203.0.113.1, 198.51.100.178' }
      );

      await POST(request);

      expect(mockCheckRateLimit).toHaveBeenNthCalledWith(
        1,
        '203.0.113.1',
        expect.any(Object)
      );
    });

    it('should extract IP from x-real-ip header when x-forwarded-for not present', async () => {
      const request = createRequest(
        { email: 'test@example.com', password: 'password' },
        { 'x-real-ip': '10.0.0.50' }
      );

      await POST(request);

      expect(mockCheckRateLimit).toHaveBeenNthCalledWith(
        1,
        '10.0.0.50',
        expect.any(Object)
      );
    });

    it('should use "unknown" when no IP headers present', async () => {
      const request = createRequest({ email: 'test@example.com', password: 'password' });

      await POST(request);

      expect(mockCheckRateLimit).toHaveBeenNthCalledWith(
        1,
        'unknown',
        expect.any(Object)
      );
    });
  });

  describe('Error Handling', () => {
    it('should return 500 when database query fails', async () => {
      mockDbQueryUsersFindFirst.mockRejectedValue(new Error('Database connection failed'));

      const request = createRequest({
        email: 'test@example.com',
        password: 'password123',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred.');
    });

    it('should return 500 when token generation fails', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser());
      mockBcryptCompare.mockResolvedValue(true);
      mockGenerateAccessToken.mockRejectedValue(new Error('Token generation failed'));

      const request = createRequest({
        email: 'test@example.com',
        password: 'password123',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred.');
    });

    it('should return 500 when refresh token storage fails', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser());
      mockBcryptCompare.mockResolvedValue(true);
      mockDbInsertValues.mockRejectedValue(new Error('Insert failed'));

      const request = createRequest({
        email: 'test@example.com',
        password: 'password123',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred.');
    });

    it('should log errors with proper context', async () => {
      const testError = new Error('Test database error');
      mockDbQueryUsersFindFirst.mockRejectedValue(testError);

      const request = createRequest({
        email: 'test@example.com',
        password: 'password123',
      });

      await POST(request);

      expect(mockLoggers.auth.error).toHaveBeenCalledWith('Login error', testError);
    });
  });

  describe('Email Case Insensitivity', () => {
    beforeEach(() => {
      mockBcryptCompare.mockResolvedValue(true);
    });

    it('should query database with email as provided', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser({ email: 'Test@Example.COM' }));

      const request = createRequest({
        email: 'Test@Example.COM',
        password: 'password123',
      });

      await POST(request);

      // The route queries with the email as provided
      // Database handles case sensitivity
      expect(mockDbQueryUsersFindFirst).toHaveBeenCalled();
    });

    it('should normalize email to lowercase for rate limiting', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser());

      const request = createRequest({
        email: 'TEST@EXAMPLE.COM',
        password: 'password123',
      });

      await POST(request);

      expect(mockCheckRateLimit).toHaveBeenNthCalledWith(
        2,
        'test@example.com',
        expect.any(Object)
      );
    });
  });
});
