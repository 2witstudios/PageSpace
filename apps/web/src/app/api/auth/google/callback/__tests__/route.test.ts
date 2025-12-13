import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @pagespace/db
const {
  mockDbQueryUsersFindFirst,
  mockDbUpdate,
  mockDbInsert,
  mockDbSelect,
} = vi.hoisted(() => ({
  mockDbQueryUsersFindFirst: vi.fn(),
  mockDbUpdate: vi.fn(),
  mockDbInsert: vi.fn(),
  mockDbSelect: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: { users: { findFirst: mockDbQueryUsersFindFirst } },
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: mockDbUpdate })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: mockDbInsert })) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: mockDbSelect })) })),
  },
  users: {},
  refreshTokens: {},
  drives: {},
  eq: vi.fn(),
  or: vi.fn(),
  count: vi.fn(),
}));

// Mock @pagespace/lib/server
const {
  mockGenerateAccessToken,
  mockGenerateRefreshToken,
  mockGetRefreshTokenMaxAge,
  mockCheckRateLimit,
  mockResetRateLimit,
  mockSlugify,
  mockDecodeToken,
  mockGenerateCSRFToken,
  mockGetSessionIdFromJWT,
  mockValidateOrCreateDeviceToken,
  mockLoggerWarn,
  mockLoggerError,
  mockLogAuthEvent,
} = vi.hoisted(() => ({
  mockGenerateAccessToken: vi.fn(),
  mockGenerateRefreshToken: vi.fn(),
  mockGetRefreshTokenMaxAge: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockResetRateLimit: vi.fn(),
  mockSlugify: vi.fn(),
  mockDecodeToken: vi.fn(),
  mockGenerateCSRFToken: vi.fn(),
  mockGetSessionIdFromJWT: vi.fn(),
  mockValidateOrCreateDeviceToken: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLogAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  generateAccessToken: mockGenerateAccessToken,
  generateRefreshToken: mockGenerateRefreshToken,
  getRefreshTokenMaxAge: mockGetRefreshTokenMaxAge,
  checkRateLimit: mockCheckRateLimit,
  resetRateLimit: mockResetRateLimit,
  slugify: mockSlugify,
  decodeToken: mockDecodeToken,
  generateCSRFToken: mockGenerateCSRFToken,
  getSessionIdFromJWT: mockGetSessionIdFromJWT,
  validateOrCreateDeviceToken: mockValidateOrCreateDeviceToken,
  logAuthEvent: mockLogAuthEvent,
  loggers: {
    auth: {
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

// Mock @paralleldrive/cuid2
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-cuid'),
}));

// Mock cookie
vi.mock('cookie', () => ({
  serialize: vi.fn((name: string, value: string, _opts: unknown) => `${name}=${value}`),
}));

// Mock crypto
const { mockCreateHmac, mockUpdate, mockDigest } = vi.hoisted(() => ({
  mockCreateHmac: vi.fn(),
  mockUpdate: vi.fn(),
  mockDigest: vi.fn(),
}));

vi.mock('crypto', () => ({
  default: {
    createHmac: mockCreateHmac,
  },
  createHmac: mockCreateHmac,
}));

// Mock Google OAuth client
const { mockGetToken, mockVerifyIdToken } = vi.hoisted(() => ({
  mockGetToken: vi.fn(),
  mockVerifyIdToken: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    getToken: mockGetToken,
    verifyIdToken: mockVerifyIdToken,
  })),
}));

// Import after mocks
import { GET } from '../route';

// Helper to create mock user
const mockUser = (overrides: Partial<{
  id: string;
  email: string;
  name: string | null;
  googleId: string | null;
  image: string | null;
  password: string | null;
  tokenVersion: number;
  role: 'user' | 'admin';
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  email: overrides.email ?? 'test@example.com',
  name: 'name' in overrides ? overrides.name : 'Test User',
  googleId: 'googleId' in overrides ? overrides.googleId : 'google_123',
  image: 'image' in overrides ? overrides.image : null,
  password: 'password' in overrides ? overrides.password : null,
  tokenVersion: overrides.tokenVersion ?? 0,
  role: overrides.role ?? 'user',
});

// Helper to create request with OAuth callback params
const createCallbackRequest = (params: {
  code?: string;
  state?: string;
  error?: string;
}, headers?: Record<string, string>) => {
  const url = new URL('https://example.com/api/auth/google/callback');
  if (params.code) url.searchParams.set('code', params.code);
  if (params.state) url.searchParams.set('state', params.state);
  if (params.error) url.searchParams.set('error', params.error);

  return new Request(url.toString(), {
    method: 'GET',
    headers: {
      ...headers,
    },
  });
};

// Helper to create signed state parameter
const createState = (data: {
  returnUrl?: string;
  platform?: 'web' | 'desktop';
  deviceId?: string;
}) => {
  const stateData = {
    returnUrl: data.returnUrl ?? '/dashboard',
    platform: data.platform ?? 'web',
    ...(data.deviceId && { deviceId: data.deviceId }),
  };

  const stateWithSig = {
    data: stateData,
    sig: 'valid-signature',
  };

  return Buffer.from(JSON.stringify(stateWithSig)).toString('base64');
};

describe('GET /api/auth/google/callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set up environment
    process.env.OAUTH_STATE_SECRET = 'test-secret';
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
    process.env.NEXTAUTH_URL = 'https://pagespace.app';
    process.env.NODE_ENV = 'production';

    // Default rate limit - allowed
    mockCheckRateLimit.mockReturnValue({ allowed: true });

    // Mock HMAC verification
    mockCreateHmac.mockReturnValue({ update: mockUpdate });
    mockUpdate.mockReturnValue({ digest: mockDigest });
    mockDigest.mockReturnValue('valid-signature');

    // Default Google token exchange
    mockGetToken.mockResolvedValue({
      tokens: { id_token: 'mock-id-token' },
    });

    // Default Google ID token verification
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: 'google_123',
        email: 'test@example.com',
        name: 'Test User',
        picture: 'https://example.com/pic.jpg',
        email_verified: true,
      }),
    });

    // Default database mocks
    mockDbQueryUsersFindFirst.mockResolvedValue(mockUser());
    mockDbUpdate.mockResolvedValue(undefined);
    mockDbInsert.mockResolvedValue([mockUser()]);
    mockDbSelect.mockResolvedValue([{ count: 1 }]); // User has a drive

    // Default token generation
    mockGenerateAccessToken.mockResolvedValue('mock-access-token');
    mockGenerateRefreshToken.mockResolvedValue('mock-refresh-token');
    mockGetRefreshTokenMaxAge.mockReturnValue(30 * 24 * 60 * 60);
    mockDecodeToken.mockResolvedValue({
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      iat: Math.floor(Date.now() / 1000),
    });
    mockSlugify.mockImplementation((s: string) => s.toLowerCase().replace(/\s+/g, '-'));
    mockGenerateCSRFToken.mockReturnValue('mock-csrf-token');
    mockGetSessionIdFromJWT.mockReturnValue('mock-session-id');
    mockValidateOrCreateDeviceToken.mockResolvedValue({ deviceToken: 'mock-device-token' });
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.OAUTH_STATE_SECRET;
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.NEXTAUTH_URL;
    delete process.env.WEB_APP_URL;
    delete process.env.NODE_ENV;
  });

  describe('OAuth Errors', () => {
    it('should redirect with error when OAuth returns error', async () => {
      const request = createCallbackRequest({ error: 'access_denied' });
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/auth/signin?error=access_denied');
    });

    it('should use generic oauth_error for non-access_denied errors', async () => {
      const request = createCallbackRequest({ error: 'server_error' });
      const response = await GET(request);

      expect(response.headers.get('location')).toContain('/auth/signin?error=oauth_error');
    });

    it('should log OAuth errors', async () => {
      const request = createCallbackRequest({ error: 'access_denied' });
      await GET(request);

      expect(mockLoggerWarn).toHaveBeenCalledWith('OAuth error', { error: 'access_denied' });
    });
  });

  describe('Validation', () => {
    it('should redirect with error when code is missing', async () => {
      const request = createCallbackRequest({});
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/auth/signin?error=invalid_request');
    });

    it('should redirect with error when code is empty', async () => {
      const request = createCallbackRequest({ code: '' });
      const response = await GET(request);

      expect(response.headers.get('location')).toContain('/auth/signin?error=invalid_request');
    });
  });

  describe('State Parameter Verification', () => {
    it('should redirect with error when state signature is invalid', async () => {
      mockDigest.mockReturnValue('different-signature');

      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({}),
      });
      const response = await GET(request);

      expect(response.headers.get('location')).toContain('/auth/signin?error=invalid_request');
    });

    it('should accept valid signed state', async () => {
      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({ returnUrl: '/custom' }),
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('/custom');
    });

    it('should use default returnUrl when not in state', async () => {
      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({}),
      });
      const response = await GET(request);

      expect(response.headers.get('location')).toContain('/dashboard');
    });

    it('should handle legacy unsigned state', async () => {
      // Legacy format without signature
      const legacyState = Buffer.from(JSON.stringify({
        platform: 'web',
        returnUrl: '/legacy-path',
      })).toString('base64');

      const request = createCallbackRequest({
        code: 'valid-code',
        state: legacyState,
      });
      const response = await GET(request);

      // Should work with legacy state
      expect(response.status).toBe(307);
    });

    it('should handle state as plain return URL string', async () => {
      const request = createCallbackRequest({
        code: 'valid-code',
        state: '/simple-return-url',
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
    });
  });

  describe('Rate Limiting', () => {
    it('should redirect with error when rate limited', async () => {
      mockCheckRateLimit.mockReturnValue({ allowed: false });

      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({}),
      });
      const response = await GET(request);

      expect(response.headers.get('location')).toContain('/auth/signin?error=rate_limit');
    });
  });

  describe('Google Token Exchange', () => {
    it('should exchange authorization code for tokens', async () => {
      const request = createCallbackRequest({
        code: 'auth-code-123',
        state: createState({}),
      });
      await GET(request);

      expect(mockGetToken).toHaveBeenCalledWith('auth-code-123');
    });

    it('should redirect with error when no ID token received', async () => {
      mockGetToken.mockResolvedValue({ tokens: {} });

      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({}),
      });
      const response = await GET(request);

      expect(response.headers.get('location')).toContain('/auth/signin?error=oauth_error');
      expect(mockLoggerError).toHaveBeenCalledWith('No ID token received from Google');
    });

    it('should redirect with error when payload is empty', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => null,
      });

      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({}),
      });
      const response = await GET(request);

      expect(response.headers.get('location')).toContain('/auth/signin?error=oauth_error');
    });

    it('should redirect with error when email is missing', async () => {
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google_123',
          name: 'Test User',
        }),
      });

      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({}),
      });
      const response = await GET(request);

      expect(response.headers.get('location')).toContain('/auth/signin?error=oauth_error');
    });
  });

  describe('User Management', () => {
    it('should create new user when not found', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(null);

      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({}),
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should use email prefix as name when name not provided', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(null);
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          sub: 'google_123',
          email: 'john.doe@example.com',
          email_verified: true,
        }),
      });

      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({}),
      });
      await GET(request);

      // User creation should use email prefix
      expect(mockDbInsert).toHaveBeenCalled();
    });

    it('should update existing user with Google ID', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser({ googleId: null }));

      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({}),
      });
      await GET(request);

      expect(mockDbUpdate).toHaveBeenCalled();
    });

    it('should create drive for new user without drives', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(null);
      mockDbSelect.mockResolvedValue([{ count: 0 }]); // No drives

      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({}),
      });
      await GET(request);

      expect(mockSlugify).toHaveBeenCalled();
    });
  });

  describe('Token Generation', () => {
    it('should generate access and refresh tokens', async () => {
      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({}),
      });
      await GET(request);

      expect(mockGenerateAccessToken).toHaveBeenCalledWith('user_123', 0, 'user');
      expect(mockGenerateRefreshToken).toHaveBeenCalledWith('user_123', 0, 'user');
    });

    it('should reset rate limits on success', async () => {
      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({}),
      }, { 'x-forwarded-for': '10.0.0.1' });
      await GET(request);

      expect(mockResetRateLimit).toHaveBeenCalledWith('10.0.0.1');
      expect(mockResetRateLimit).toHaveBeenCalledWith('test@example.com');
    });

    it('should track login event', async () => {
      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({}),
      });
      await GET(request);

      expect(mockTrackAuthEvent).toHaveBeenCalledWith(
        'user_123',
        'login',
        expect.objectContaining({
          provider: 'google',
          email: 'test@example.com',
        })
      );
    });
  });

  describe('Web Platform Response', () => {
    it('should redirect to returnUrl with auth=success', async () => {
      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({ returnUrl: '/dashboard/settings' }),
      });
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location')!;
      expect(location).toContain('/dashboard/settings');
      expect(location).toContain('auth=success');
    });

    it('should set access and refresh token cookies', async () => {
      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({}),
      });
      const response = await GET(request);

      const cookies = response.headers.getSetCookie();
      expect(cookies.some(c => c.includes('accessToken'))).toBe(true);
      expect(cookies.some(c => c.includes('refreshToken'))).toBe(true);
    });
  });

  describe('Desktop Platform Response', () => {
    it('should redirect with tokens in URL for desktop', async () => {
      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({ platform: 'desktop', deviceId: 'device_123' }),
      });
      const response = await GET(request);

      const location = response.headers.get('location')!;
      expect(location).toContain('desktop=true');
      expect(location).toContain('tokens=');
    });

    it('should redirect with error when desktop has no deviceId', async () => {
      const state = Buffer.from(JSON.stringify({
        data: { platform: 'desktop', returnUrl: '/dashboard' },
        sig: 'valid-signature',
      })).toString('base64');

      const request = createCallbackRequest({
        code: 'valid-code',
        state,
      });
      const response = await GET(request);

      expect(response.headers.get('location')).toContain('/auth/signin?error=invalid_device');
    });

    it('should generate device token for desktop', async () => {
      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({ platform: 'desktop', deviceId: 'device_123' }),
      });
      await GET(request);

      expect(mockValidateOrCreateDeviceToken).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: 'device_123',
          platform: 'desktop',
        })
      );
    });
  });

  describe('Error Handling', () => {
    it('should redirect on token exchange error', async () => {
      mockGetToken.mockRejectedValue(new Error('Token exchange failed'));

      const request = createCallbackRequest({
        code: 'invalid-code',
        state: createState({}),
      });
      const response = await GET(request);

      expect(response.headers.get('location')).toContain('/auth/signin?error=oauth_error');
    });

    it('should log errors', async () => {
      const error = new Error('Unexpected error');
      mockGetToken.mockRejectedValue(error);

      const request = createCallbackRequest({
        code: 'valid-code',
        state: createState({}),
      });
      await GET(request);

      expect(mockLoggerError).toHaveBeenCalled();
    });
  });
});
