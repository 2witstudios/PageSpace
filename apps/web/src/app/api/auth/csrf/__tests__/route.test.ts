import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';

// Mock @pagespace/lib/server
const {
  mockGenerateCSRFToken,
  mockGetSessionIdFromJWT,
  mockDecodeToken,
  mockLoggers,
} = vi.hoisted(() => ({
  mockGenerateCSRFToken: vi.fn(),
  mockGetSessionIdFromJWT: vi.fn(),
  mockDecodeToken: vi.fn(),
  mockLoggers: {
    auth: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/server', () => ({
  generateCSRFToken: mockGenerateCSRFToken,
  getSessionIdFromJWT: mockGetSessionIdFromJWT,
  decodeToken: mockDecodeToken,
  loggers: mockLoggers,
}));

// Mock auth module
const { mockAuthenticateRequestWithOptions, mockIsAuthError } = vi.hoisted(() => ({
  mockAuthenticateRequestWithOptions: vi.fn(),
  mockIsAuthError: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: mockAuthenticateRequestWithOptions,
  isAuthError: mockIsAuthError,
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
}));

// Import after mocks
import { GET } from '../route';

// Helper to create mock auth result
const mockWebAuth = (overrides: Partial<{
  userId: string;
  tokenVersion: number;
  role: 'user' | 'admin';
}> = {}) => ({
  userId: overrides.userId ?? 'user_123',
  tokenVersion: overrides.tokenVersion ?? 0,
  role: overrides.role ?? 'user',
  tokenType: 'jwt' as const,
  source: 'cookie' as const,
});

// Helper to create mock auth error
const mockAuthError = (status = 401) => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create request
const createRequest = (options: {
  cookies?: Record<string, string>;
  bearerToken?: string;
} = {}) => {
  const cookieHeader = options.cookies
    ? Object.entries(options.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    : '';

  const headers: Record<string, string> = {};
  if (cookieHeader) headers.cookie = cookieHeader;
  if (options.bearerToken) headers.authorization = `Bearer ${options.bearerToken}`;

  return new Request('https://example.com/api/auth/csrf', {
    method: 'GET',
    headers,
  });
};

describe('GET /api/auth/csrf', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default auth success
    mockAuthenticateRequestWithOptions.mockResolvedValue(mockWebAuth());
    mockIsAuthError.mockReturnValue(false);

    // Default token decoding
    mockDecodeToken.mockResolvedValue({
      userId: 'user_123',
      tokenVersion: 0,
      role: 'user',
      iat: 1234567890,
    });

    // Default CSRF generation
    mockGetSessionIdFromJWT.mockReturnValue('session_123');
    mockGenerateCSRFToken.mockReturnValue('csrf-token-abc');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication', () => {
    it('should return 401 when not authenticated', async () => {
      mockIsAuthError.mockReturnValue(true);
      mockAuthenticateRequestWithOptions.mockResolvedValue(mockAuthError(401));

      const request = createRequest();
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should authenticate with JWT only, no CSRF required', async () => {
      const request = createRequest({ cookies: { accessToken: 'valid-token' } });
      await GET(request);

      expect(mockAuthenticateRequestWithOptions).toHaveBeenCalledWith(
        expect.any(Request),
        { allow: ['jwt'], requireCSRF: false }
      );
    });

    it('should support Bearer token authentication', async () => {
      const request = createRequest({ bearerToken: 'bearer-token-123' });
      await GET(request);

      expect(mockAuthenticateRequestWithOptions).toHaveBeenCalled();
    });
  });

  describe('Token Retrieval', () => {
    it('should return 401 when no JWT token found', async () => {
      // Auth passes but no token in request
      const request = createRequest();
      mockDecodeToken.mockResolvedValue(null);

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('No JWT token found');
    });

    it('should use Bearer token when provided', async () => {
      const request = createRequest({ bearerToken: 'bearer-token-123' });
      await GET(request);

      expect(mockDecodeToken).toHaveBeenCalledWith('bearer-token-123');
    });

    it('should use cookie token when Bearer not provided', async () => {
      const request = createRequest({ cookies: { accessToken: 'cookie-token-456' } });
      await GET(request);

      expect(mockDecodeToken).toHaveBeenCalledWith('cookie-token-456');
    });

    it('should prefer Bearer token over cookie', async () => {
      const request = createRequest({
        cookies: { accessToken: 'cookie-token' },
        bearerToken: 'bearer-token',
      });

      await GET(request);

      expect(mockDecodeToken).toHaveBeenCalledWith('bearer-token');
    });
  });

  describe('JWT Validation', () => {
    it('should return 401 when JWT has no iat claim', async () => {
      mockDecodeToken.mockResolvedValue({
        userId: 'user_123',
        tokenVersion: 0,
        role: 'user',
        // Missing iat
      });

      const request = createRequest({ cookies: { accessToken: 'token' } });
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid JWT token');
    });

    it('should return 401 when JWT decode fails', async () => {
      mockDecodeToken.mockResolvedValue(null);

      const request = createRequest({ cookies: { accessToken: 'invalid-token' } });
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid JWT token');
    });
  });

  describe('CSRF Token Generation', () => {
    it('should generate session ID from JWT claims', async () => {
      mockDecodeToken.mockResolvedValue({
        userId: 'user_456',
        tokenVersion: 2,
        role: 'admin',
        iat: 1700000000,
      });
      mockAuthenticateRequestWithOptions.mockResolvedValue(mockWebAuth({
        userId: 'user_456',
        tokenVersion: 2,
        role: 'admin',
      }));

      const request = createRequest({ cookies: { accessToken: 'token' } });
      await GET(request);

      expect(mockGetSessionIdFromJWT).toHaveBeenCalledWith({
        userId: 'user_456',
        tokenVersion: 2,
        iat: 1700000000,
      });
    });

    it('should generate CSRF token from session ID', async () => {
      mockGetSessionIdFromJWT.mockReturnValue('session_xyz');

      const request = createRequest({ cookies: { accessToken: 'token' } });
      await GET(request);

      expect(mockGenerateCSRFToken).toHaveBeenCalledWith('session_xyz');
    });

    it('should return CSRF token in response', async () => {
      mockGenerateCSRFToken.mockReturnValue('generated-csrf-token');

      const request = createRequest({ cookies: { accessToken: 'token' } });
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.csrfToken).toBe('generated-csrf-token');
    });
  });

  describe('Error Handling', () => {
    it('should return 500 when CSRF generation fails', async () => {
      mockGenerateCSRFToken.mockImplementation(() => {
        throw new Error('CSRF generation failed');
      });

      const request = createRequest({ cookies: { accessToken: 'token' } });
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to generate CSRF token');
    });

    it('should log errors', async () => {
      const testError = new Error('Test error');
      mockGenerateCSRFToken.mockImplementation(() => {
        throw testError;
      });

      const request = createRequest({ cookies: { accessToken: 'token' } });
      await GET(request);

      expect(mockLoggers.auth.error).toHaveBeenCalledWith(
        'CSRF token generation error:',
        testError
      );
    });

    it('should return 500 when session ID generation fails', async () => {
      mockGetSessionIdFromJWT.mockImplementation(() => {
        throw new Error('Session ID failed');
      });

      const request = createRequest({ cookies: { accessToken: 'token' } });
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to generate CSRF token');
    });
  });
});
