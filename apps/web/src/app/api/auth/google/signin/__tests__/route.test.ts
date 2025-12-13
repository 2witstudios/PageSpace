import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @pagespace/lib/server
const { mockCheckRateLimit, mockLoggerError } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  checkRateLimit: mockCheckRateLimit,
  RATE_LIMIT_CONFIGS: {
    LOGIN: {
      maxAttempts: 5,
      windowMs: 15 * 60 * 1000,
      blockDurationMs: 15 * 60 * 1000,
      progressiveDelay: true,
    },
  },
  loggers: {
    auth: {
      error: mockLoggerError,
    },
  },
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

// Import after mocks
import { POST, GET } from '../route';

// Helper to create POST request
const createPostRequest = (body: Record<string, unknown>, headers?: Record<string, string>) => {
  return new Request('https://example.com/api/auth/google/signin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
};

// Helper to create GET request
const createGetRequest = () => {
  return new Request('https://example.com/api/auth/google/signin', {
    method: 'GET',
  });
};

describe('Google OAuth Signin Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default rate limit - allowed
    mockCheckRateLimit.mockReturnValue({ allowed: true, attemptsRemaining: 4 });

    // Mock HMAC chain
    mockCreateHmac.mockReturnValue({ update: mockUpdate });
    mockUpdate.mockReturnValue({ digest: mockDigest });
    mockDigest.mockReturnValue('mock-signature');

    // Set up required environment variables
    process.env.OAUTH_STATE_SECRET = 'test-oauth-secret';
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://example.com/api/auth/google/callback';
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.OAUTH_STATE_SECRET;
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
  });

  describe('POST /api/auth/google/signin', () => {
    describe('Validation', () => {
      it('should accept request with empty body', async () => {
        const request = createPostRequest({});
        const response = await POST(request);

        expect(response.status).toBe(200);
      });

      it('should accept request with valid returnUrl', async () => {
        const request = createPostRequest({ returnUrl: '/dashboard/settings' });
        const response = await POST(request);

        expect(response.status).toBe(200);
      });

      it('should accept web platform', async () => {
        const request = createPostRequest({ platform: 'web' });
        const response = await POST(request);

        expect(response.status).toBe(200);
      });

      it('should accept desktop platform', async () => {
        const request = createPostRequest({ platform: 'desktop', deviceId: 'device_123' });
        const response = await POST(request);

        expect(response.status).toBe(200);
      });

      it('should return 400 for invalid platform', async () => {
        const request = createPostRequest({ platform: 'mobile' });
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.errors).toBeDefined();
      });
    });

    describe('Rate Limiting', () => {
      it('should return 429 when rate limit exceeded', async () => {
        mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfter: 900 });

        const request = createPostRequest({});
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(429);
        expect(body.error).toContain('Too many login attempts');
        expect(body.retryAfter).toBe(900);
      });

      it('should include Retry-After header', async () => {
        mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfter: 600 });

        const request = createPostRequest({});
        const response = await POST(request);

        expect(response.headers.get('Retry-After')).toBe('600');
      });

      it('should use x-forwarded-for for IP', async () => {
        const request = createPostRequest({}, { 'x-forwarded-for': '10.0.0.1, 10.0.0.2' });
        await POST(request);

        expect(mockCheckRateLimit).toHaveBeenCalledWith('10.0.0.1', expect.anything());
      });

      it('should fallback to x-real-ip', async () => {
        const request = createPostRequest({}, { 'x-real-ip': '192.168.1.1' });
        await POST(request);

        expect(mockCheckRateLimit).toHaveBeenCalledWith('192.168.1.1', expect.anything());
      });

      it('should use unknown when no IP headers', async () => {
        const request = createPostRequest({});
        await POST(request);

        expect(mockCheckRateLimit).toHaveBeenCalledWith('unknown', expect.anything());
      });
    });

    describe('OAuth URL Generation', () => {
      it('should return OAuth URL on success', async () => {
        const request = createPostRequest({});
        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
        expect(body.url).toContain('client_id=test-client-id');
      });

      it('should include required OAuth parameters', async () => {
        const request = createPostRequest({});
        const response = await POST(request);
        const body = await response.json();
        const url = new URL(body.url);

        expect(url.searchParams.get('client_id')).toBe('test-client-id');
        expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/api/auth/google/callback');
        expect(url.searchParams.get('response_type')).toBe('code');
        expect(url.searchParams.get('scope')).toBe('openid email profile');
        expect(url.searchParams.get('access_type')).toBe('offline');
        expect(url.searchParams.get('prompt')).toBe('consent');
      });

      it('should include state parameter', async () => {
        const request = createPostRequest({});
        const response = await POST(request);
        const body = await response.json();
        const url = new URL(body.url);

        expect(url.searchParams.get('state')).toBeDefined();
        expect(url.searchParams.get('state')!.length).toBeGreaterThan(0);
      });

      it('should encode state with platform and returnUrl', async () => {
        const request = createPostRequest({
          returnUrl: '/custom/path',
          platform: 'desktop',
          deviceId: 'device_123',
        });
        const response = await POST(request);
        const body = await response.json();
        const url = new URL(body.url);
        const state = url.searchParams.get('state')!;

        // Decode and verify state
        const stateJson = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
        expect(stateJson.data.returnUrl).toBe('/custom/path');
        expect(stateJson.data.platform).toBe('desktop');
        expect(stateJson.data.deviceId).toBe('device_123');
        expect(stateJson.sig).toBe('mock-signature');
      });

      it('should sign state with HMAC-SHA256', async () => {
        const request = createPostRequest({ returnUrl: '/test' });
        await POST(request);

        expect(mockCreateHmac).toHaveBeenCalledWith('sha256', 'test-oauth-secret');
      });

      it('should default returnUrl to /dashboard', async () => {
        const request = createPostRequest({});
        const response = await POST(request);
        const body = await response.json();
        const url = new URL(body.url);
        const state = url.searchParams.get('state')!;

        const stateJson = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
        expect(stateJson.data.returnUrl).toBe('/dashboard');
      });

      it('should default platform to web', async () => {
        const request = createPostRequest({});
        const response = await POST(request);
        const body = await response.json();
        const url = new URL(body.url);
        const state = url.searchParams.get('state')!;

        const stateJson = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
        expect(stateJson.data.platform).toBe('web');
      });
    });

    describe('Error Handling', () => {
      it('should return 500 on unexpected error', async () => {
        // Make JSON parsing fail
        const request = new Request('https://example.com/api/auth/google/signin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid json',
        });

        const response = await POST(request);
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.error).toBe('An unexpected error occurred.');
      });

      it('should log error on failure', async () => {
        const request = new Request('https://example.com/api/auth/google/signin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'invalid json',
        });

        await POST(request);

        expect(mockLoggerError).toHaveBeenCalled();
      });
    });
  });

  describe('GET /api/auth/google/signin', () => {
    it('should redirect to Google OAuth', async () => {
      const request = createGetRequest();
      const response = await GET();

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    });

    it('should include required OAuth parameters', async () => {
      const response = await GET();
      const location = response.headers.get('location')!;
      const url = new URL(location);

      expect(url.searchParams.get('client_id')).toBe('test-client-id');
      expect(url.searchParams.get('redirect_uri')).toBe('https://example.com/api/auth/google/callback');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('scope')).toBe('openid email profile');
    });

    it('should not include state parameter (direct access)', async () => {
      const response = await GET();
      const location = response.headers.get('location')!;
      const url = new URL(location);

      expect(url.searchParams.has('state')).toBe(false);
    });
  });
});
