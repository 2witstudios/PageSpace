import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @pagespace/lib/server
const {
  mockDecodeToken,
  mockGenerateAccessToken,
  mockGenerateRefreshToken,
  mockGetRefreshTokenMaxAge,
  mockCheckRateLimit,
} = vi.hoisted(() => ({
  mockDecodeToken: vi.fn(),
  mockGenerateAccessToken: vi.fn(),
  mockGenerateRefreshToken: vi.fn(),
  mockGetRefreshTokenMaxAge: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  decodeToken: mockDecodeToken,
  generateAccessToken: mockGenerateAccessToken,
  generateRefreshToken: mockGenerateRefreshToken,
  getRefreshTokenMaxAge: mockGetRefreshTokenMaxAge,
  checkRateLimit: mockCheckRateLimit,
  RATE_LIMIT_CONFIGS: {
    REFRESH: {
      maxAttempts: 10,
      windowMs: 5 * 60 * 1000,
      blockDurationMs: 5 * 60 * 1000,
      progressiveDelay: false,
    },
  },
}));

// Mock @pagespace/lib/device-auth-utils
const { mockValidateDeviceToken } = vi.hoisted(() => ({
  mockValidateDeviceToken: vi.fn(),
}));

vi.mock('@pagespace/lib/device-auth-utils', () => ({
  validateDeviceToken: mockValidateDeviceToken,
}));

// Mock database
const {
  mockDbTransactionCallback,
  mockDbInsertValues,
  mockTrxQueryFindFirst,
  mockTrxDelete,
  mockTrxUpdate,
} = vi.hoisted(() => ({
  mockDbTransactionCallback: vi.fn(),
  mockDbInsertValues: vi.fn(),
  mockTrxQueryFindFirst: vi.fn(),
  mockTrxDelete: vi.fn(),
  mockTrxUpdate: vi.fn(),
}));

vi.mock('@pagespace/db', () => {
  const mockTrx = {
    query: {
      refreshTokens: { findFirst: mockTrxQueryFindFirst },
    },
    delete: vi.fn(() => ({ where: mockTrxDelete })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: mockTrxUpdate })),
    })),
  };

  // sql is a tagged template literal function
  const sqlFn = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
      sql: strings.join('?'),
      values,
    })),
    { raw: vi.fn() }
  );

  return {
    db: {
      transaction: vi.fn(async (callback: (tx: typeof mockTrx) => Promise<unknown>) => {
        return callback(mockTrx);
      }),
      insert: vi.fn(() => ({ values: mockDbInsertValues })),
    },
    users: { tokenVersion: 'users.tokenVersion' },
    refreshTokens: {},
    deviceTokens: {},
    eq: vi.fn(),
    sql: sqlFn,
    and: vi.fn(),
    isNull: vi.fn(),
  };
});

// Mock @paralleldrive/cuid2
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-cuid'),
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

// Helper to create mock refresh token record
const mockRefreshTokenRecord = (overrides: Partial<{
  id: string;
  token: string;
  userId: string;
  user: ReturnType<typeof mockUser>;
}> = {}) => ({
  id: overrides.id ?? 'token_123',
  token: overrides.token ?? 'valid-refresh-token',
  userId: overrides.userId ?? 'user_123',
  user: overrides.user ?? mockUser(),
});

// Helper to create request
const createRequest = (options: {
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
} = {}) => {
  const cookieHeader = options.cookies
    ? Object.entries(options.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    : '';

  return new Request('https://example.com/api/auth/refresh', {
    method: 'POST',
    headers: {
      ...(cookieHeader && { cookie: cookieHeader }),
      ...options.headers,
    },
  });
};

describe('POST /api/auth/refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default rate limit - allowed
    mockCheckRateLimit.mockReturnValue({ allowed: true, attemptsRemaining: 9 });

    // Default token validation
    mockDecodeToken.mockResolvedValue({
      userId: 'user_123',
      tokenVersion: 0,
      role: 'user',
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    });

    // Default token generation
    mockGenerateAccessToken.mockResolvedValue('new-access-token');
    mockGenerateRefreshToken.mockResolvedValue('new-refresh-token');
    mockGetRefreshTokenMaxAge.mockReturnValue(30 * 24 * 60 * 60);

    // Default database - token exists
    mockTrxQueryFindFirst.mockResolvedValue(mockRefreshTokenRecord());
    mockTrxDelete.mockResolvedValue(undefined);
    mockDbInsertValues.mockResolvedValue(undefined);

    // Default device token validation
    mockValidateDeviceToken.mockResolvedValue({ id: 'device_123' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Missing Refresh Token', () => {
    it('should return 401 when refresh token cookie is missing', async () => {
      const request = createRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Refresh token not found.');
    });
  });

  describe('Rate Limiting', () => {
    it('should return 429 when rate limit exceeded', async () => {
      mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfter: 300 });

      const request = createRequest({
        cookies: { refreshToken: 'valid-token' },
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many refresh attempts');
      expect(body.retryAfter).toBe(300);
    });

    it('should include Retry-After header', async () => {
      mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfter: 300 });

      const request = createRequest({
        cookies: { refreshToken: 'valid-token' },
        headers: { 'x-forwarded-for': '192.168.1.1' },
      });

      const response = await POST(request);

      expect(response.headers.get('Retry-After')).toBe('300');
    });
  });

  describe('Device Token Validation', () => {
    it('should reject when device token is invalid', async () => {
      mockValidateDeviceToken.mockResolvedValue(null);

      const request = createRequest({
        cookies: { refreshToken: 'valid-token' },
        headers: { 'x-device-token': 'invalid-device-token' },
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Device token is invalid or has been revoked.');
    });

    it('should proceed when device token is valid', async () => {
      mockValidateDeviceToken.mockResolvedValue({ id: 'device_123' });

      const request = createRequest({
        cookies: { refreshToken: 'valid-token' },
        headers: { 'x-device-token': 'valid-device-token' },
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it('should proceed when no device token provided', async () => {
      const request = createRequest({
        cookies: { refreshToken: 'valid-token' },
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockValidateDeviceToken).not.toHaveBeenCalled();
    });
  });

  describe('Invalid Refresh Token', () => {
    it('should return 401 when token not found in database', async () => {
      mockTrxQueryFindFirst.mockResolvedValue(null);
      mockDecodeToken.mockResolvedValue({
        userId: 'user_123',
        tokenVersion: 0,
        role: 'user',
      });

      const request = createRequest({
        cookies: { refreshToken: 'stolen-token' },
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid refresh token.');
    });

    it('should invalidate all sessions when reused token detected', async () => {
      mockTrxQueryFindFirst.mockResolvedValue(null);
      mockDecodeToken.mockResolvedValue({
        userId: 'user_123',
        tokenVersion: 0,
        role: 'user',
      });
      mockTrxUpdate.mockResolvedValue(undefined);

      const request = createRequest({
        cookies: { refreshToken: 'reused-token' },
      });

      await POST(request);

      // Should update user's tokenVersion and revoke device tokens
      expect(mockTrxUpdate).toHaveBeenCalled();
    });

    it('should return 401 when token version mismatch', async () => {
      // Token in DB has version 0, but decoded token has version 1
      mockTrxQueryFindFirst.mockResolvedValue(mockRefreshTokenRecord({
        user: mockUser({ tokenVersion: 0 }),
      }));
      mockDecodeToken.mockResolvedValue({
        userId: 'user_123',
        tokenVersion: 1, // Different version
        role: 'user',
      });

      const request = createRequest({
        cookies: { refreshToken: 'outdated-token' },
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid refresh token version.');
    });
  });

  describe('Successful Token Refresh', () => {
    it('should return 200 with success message', async () => {
      const request = createRequest({
        cookies: { refreshToken: 'valid-token' },
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Token refreshed successfully');
    });

    it('should delete old refresh token', async () => {
      const request = createRequest({
        cookies: { refreshToken: 'valid-token' },
      });

      await POST(request);

      expect(mockTrxDelete).toHaveBeenCalled();
    });

    it('should generate new access and refresh tokens', async () => {
      mockTrxQueryFindFirst.mockResolvedValue(mockRefreshTokenRecord({
        user: mockUser({ id: 'user_456', tokenVersion: 2, role: 'admin' }),
      }));
      mockDecodeToken.mockResolvedValue({
        userId: 'user_456',
        tokenVersion: 2,
        role: 'admin',
      });

      const request = createRequest({
        cookies: { refreshToken: 'valid-token' },
      });

      await POST(request);

      expect(mockGenerateAccessToken).toHaveBeenCalledWith('user_456', 2, 'admin');
      expect(mockGenerateRefreshToken).toHaveBeenCalledWith('user_456', 2, 'admin');
    });

    it('should store new refresh token in database', async () => {
      const request = createRequest({
        cookies: { refreshToken: 'valid-token' },
        headers: { 'user-agent': 'Test Agent', 'x-forwarded-for': '10.0.0.1' },
      });

      await POST(request);

      expect(mockDbInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'mock-cuid',
          token: 'new-refresh-token',
          userId: 'user_123',
          userAgent: 'Test Agent',
          ip: '10.0.0.1',
          platform: 'web',
        })
      );
    });

    it('should set new token cookies', async () => {
      const request = createRequest({
        cookies: { refreshToken: 'valid-token' },
      });

      const response = await POST(request);
      const cookies = response.headers.getSetCookie();

      expect(cookies.some(c => c.includes('accessToken'))).toBe(true);
      expect(cookies.some(c => c.includes('refreshToken'))).toBe(true);
    });

    it('should link refresh token to validated device token', async () => {
      mockValidateDeviceToken.mockResolvedValue({ id: 'device_789' });

      const request = createRequest({
        cookies: { refreshToken: 'valid-token' },
        headers: { 'x-device-token': 'valid-device-token' },
      });

      await POST(request);

      expect(mockDbInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceTokenId: 'device_789',
        })
      );
    });
  });

  describe('IP Address Extraction', () => {
    it('should extract IP from x-forwarded-for', async () => {
      const request = createRequest({
        cookies: { refreshToken: 'valid-token' },
        headers: { 'x-forwarded-for': '203.0.113.1, 198.51.100.178' },
      });

      await POST(request);

      expect(mockDbInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ ip: '203.0.113.1' })
      );
    });

    it('should use "unknown" when no IP headers', async () => {
      const request = createRequest({
        cookies: { refreshToken: 'valid-token' },
      });

      await POST(request);

      expect(mockDbInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ ip: 'unknown' })
      );
    });
  });
});
