import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Login Route Tests
 *
 * Tests are organized by behavior, not implementation.
 * We only mock at system boundaries: database, bcrypt (external library)
 *
 * Coverage:
 * - Input validation (email format, required fields)
 * - Rate limiting behavior
 * - Authentication success/failure
 * - Security behaviors (timing attack prevention, error message safety)
 * - Response format
 */

// === MOCKS AT SYSTEM BOUNDARIES ONLY ===

// Mock bcryptjs - external cryptography library
const { mockBcryptCompare } = vi.hoisted(() => ({
  mockBcryptCompare: vi.fn(),
}));

vi.mock('bcryptjs', () => ({
  default: { compare: mockBcryptCompare },
  compare: mockBcryptCompare,
}));

// Mock database - external system boundary
const { mockDbQueryUsersFindFirst, mockDbInsertValues } = vi.hoisted(() => ({
  mockDbQueryUsersFindFirst: vi.fn(),
  mockDbInsertValues: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      users: { findFirst: mockDbQueryUsersFindFirst },
    },
    insert: vi.fn(() => ({ values: mockDbInsertValues })),
  },
  users: {},
  refreshTokens: {},
  eq: vi.fn(),
}));

// Mock rate limiting - internal service but controls request flow
const { mockCheckRateLimit, mockResetRateLimit } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockResetRateLimit: vi.fn(),
}));

// Mock token generation - security boundary
const {
  mockGenerateAccessToken,
  mockGenerateRefreshToken,
  mockGetRefreshTokenMaxAge,
  mockDecodeToken,
  mockValidateOrCreateDeviceToken,
} = vi.hoisted(() => ({
  mockGenerateAccessToken: vi.fn(),
  mockGenerateRefreshToken: vi.fn(),
  mockGetRefreshTokenMaxAge: vi.fn(),
  mockDecodeToken: vi.fn(),
  mockValidateOrCreateDeviceToken: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  checkRateLimit: mockCheckRateLimit,
  resetRateLimit: mockResetRateLimit,
  generateAccessToken: mockGenerateAccessToken,
  generateRefreshToken: mockGenerateRefreshToken,
  getRefreshTokenMaxAge: mockGetRefreshTokenMaxAge,
  decodeToken: mockDecodeToken,
  validateOrCreateDeviceToken: mockValidateOrCreateDeviceToken,
  logAuthEvent: vi.fn(),
  loggers: { auth: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
  RATE_LIMIT_CONFIGS: {
    LOGIN: { maxAttempts: 5, windowMs: 900000, blockDurationMs: 900000, progressiveDelay: true },
  },
}));

// Mock activity tracking - analytics boundary (don't need to verify calls)
vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'test-cuid'),
}));

vi.mock('cookie', () => ({
  serialize: vi.fn((name: string, value: string) => `${name}=${value}`),
}));

import { POST } from '../route';

// === TEST FIXTURES ===

const createUser = (overrides: Partial<{
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

const createRequest = (body: object, headers: Record<string, string> = {}) => {
  return new Request('https://example.com/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
};

// === TESTS ===

describe('LoginRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: rate limiting allows requests
    mockCheckRateLimit.mockReturnValue({ allowed: true, attemptsRemaining: 4 });

    // Default: token generation succeeds
    mockGenerateAccessToken.mockResolvedValue('access-token-value');
    mockGenerateRefreshToken.mockResolvedValue('refresh-token-value');
    mockGetRefreshTokenMaxAge.mockReturnValue(2592000); // 30 days
    mockDecodeToken.mockResolvedValue({ exp: Date.now() / 1000 + 2592000 });
    mockDbInsertValues.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // === INPUT VALIDATION ===

  describe('input_validation', () => {
    it('rejects_request_when_email_missing', async () => {
      const request = createRequest({ password: 'anypassword' });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.email).toBeDefined();
    });

    it('rejects_request_when_email_format_invalid', async () => {
      const request = createRequest({ email: 'not-valid-email', password: 'anypassword' });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.email).toBeDefined();
    });

    it('rejects_request_when_password_missing', async () => {
      const request = createRequest({ email: 'user@example.com' });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });

    it('rejects_request_when_password_empty', async () => {
      const request = createRequest({ email: 'user@example.com', password: '' });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });

    it('rejects_request_when_body_is_invalid_json', async () => {
      const request = new Request('https://example.com/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json',
      });

      const response = await POST(request);

      expect(response.status).toBe(500);
    });
  });

  // === RATE LIMITING BEHAVIOR ===

  describe('rate_limiting', () => {
    it('blocks_login_when_ip_rate_limit_exceeded', async () => {
      mockCheckRateLimit.mockReturnValueOnce({ allowed: false, retryAfter: 900 });

      const request = createRequest({ email: 'user@example.com', password: 'password' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toMatch(/too many.*ip/i);
      expect(body.retryAfter).toBe(900);
      expect(response.headers.get('Retry-After')).toBe('900');
    });

    it('blocks_login_when_email_rate_limit_exceeded', async () => {
      // IP check passes, email check fails
      mockCheckRateLimit
        .mockReturnValueOnce({ allowed: true })
        .mockReturnValueOnce({ allowed: false, retryAfter: 600 });

      const request = createRequest({ email: 'user@example.com', password: 'password' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toMatch(/too many.*email/i);
    });

    // TODO: REVIEW - Should rate limit key be case-normalized? Current behavior: yes
    it('normalizes_email_to_lowercase_for_rate_limit_tracking', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(createUser());
      mockBcryptCompare.mockResolvedValue(true);

      const request = createRequest({ email: 'USER@EXAMPLE.COM', password: 'password' });
      await POST(request);

      // Rate limit check should use lowercase email
      expect(mockCheckRateLimit).toHaveBeenNthCalledWith(2, 'user@example.com', expect.any(Object));
    });
  });

  // === AUTHENTICATION BEHAVIOR ===

  describe('authentication', () => {
    it('authenticates_user_with_valid_credentials', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(createUser({
        email: 'valid@example.com',
        name: 'Valid User',
      }));
      mockBcryptCompare.mockResolvedValue(true);

      const request = createRequest({ email: 'valid@example.com', password: 'correctpassword' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.email).toBe('valid@example.com');
      expect(body.name).toBe('Valid User');
    });

    it('sets_session_cookies_on_successful_login', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(createUser());
      mockBcryptCompare.mockResolvedValue(true);

      const request = createRequest({ email: 'user@example.com', password: 'password' });
      const response = await POST(request);

      const cookies = response.headers.getSetCookie();
      expect(cookies.length).toBe(2);
      expect(cookies.some(c => c.includes('accessToken'))).toBe(true);
      expect(cookies.some(c => c.includes('refreshToken'))).toBe(true);
    });

    it('rejects_login_with_incorrect_password', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(createUser());
      mockBcryptCompare.mockResolvedValue(false);

      const request = createRequest({ email: 'user@example.com', password: 'wrongpassword' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid email or password');
    });

    it('rejects_login_for_nonexistent_user', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(null);
      mockBcryptCompare.mockResolvedValue(false);

      const request = createRequest({ email: 'nobody@example.com', password: 'password' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid email or password');
    });

    it('rejects_login_for_oauth_only_account_without_password', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(createUser({ password: null }));

      const request = createRequest({ email: 'oauth@example.com', password: 'anypassword' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid email or password');
    });
  });

  // === SECURITY BEHAVIORS ===

  describe('security', () => {
    it('returns_generic_error_that_does_not_reveal_if_email_exists', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(null);
      mockBcryptCompare.mockResolvedValue(false);

      const request = createRequest({ email: 'unknown@example.com', password: 'password' });
      const response = await POST(request);
      const body = await response.json();

      // Error message should not indicate whether email exists
      expect(body.error).toBe('Invalid email or password');
      expect(body.error).not.toMatch(/not found/i);
      expect(body.error).not.toMatch(/does not exist/i);
      expect(body.error).not.toMatch(/no user/i);
    });

    // IMPORTANT: Timing attack prevention - bcrypt compare runs even for non-existent users
    it('performs_password_comparison_even_for_nonexistent_user_to_prevent_timing_attacks', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(null);
      mockBcryptCompare.mockResolvedValue(false);

      const request = createRequest({ email: 'unknown@example.com', password: 'password' });
      await POST(request);

      // bcrypt.compare should be called even when user doesn't exist
      // This prevents timing attacks that could enumerate valid emails
      expect(mockBcryptCompare).toHaveBeenCalledTimes(1);
      expect(mockBcryptCompare).toHaveBeenCalledWith('password', expect.stringMatching(/^\$2a\$/));
    });

    it('does_not_expose_internal_errors_to_client', async () => {
      mockDbQueryUsersFindFirst.mockRejectedValue(new Error('PostgreSQL connection refused'));

      const request = createRequest({ email: 'user@example.com', password: 'password' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred.');
      expect(body.error).not.toMatch(/postgresql/i);
      expect(body.error).not.toMatch(/database/i);
    });
  });

  // === DEVICE TOKEN BEHAVIOR ===

  describe('device_tokens', () => {
    beforeEach(() => {
      mockDbQueryUsersFindFirst.mockResolvedValue(createUser());
      mockBcryptCompare.mockResolvedValue(true);
    });

    it('returns_device_token_when_device_id_provided', async () => {
      mockValidateOrCreateDeviceToken.mockResolvedValue({
        deviceToken: 'new-device-token',
        deviceTokenRecordId: 'record-123',
      });

      const request = createRequest({
        email: 'user@example.com',
        password: 'password',
        deviceId: 'my-device-uuid',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.deviceToken).toBe('new-device-token');
    });

    it('does_not_return_device_token_when_device_id_not_provided', async () => {
      const request = createRequest({ email: 'user@example.com', password: 'password' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.deviceToken).toBeUndefined();
    });

    // TODO: REVIEW - Should existing deviceToken be revalidated or always create new?
    it('accepts_existing_device_token_for_revalidation', async () => {
      mockValidateOrCreateDeviceToken.mockResolvedValue({
        deviceToken: 'validated-token',
        deviceTokenRecordId: 'record-456',
      });

      const request = createRequest({
        email: 'user@example.com',
        password: 'password',
        deviceId: 'device-id',
        deviceToken: 'existing-token',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.deviceToken).toBe('validated-token');
    });
  });

  // === IP ADDRESS EXTRACTION ===

  describe('ip_extraction', () => {
    beforeEach(() => {
      mockDbQueryUsersFindFirst.mockResolvedValue(createUser());
      mockBcryptCompare.mockResolvedValue(true);
    });

    it('extracts_client_ip_from_x_forwarded_for_header', async () => {
      const request = createRequest(
        { email: 'user@example.com', password: 'password' },
        { 'x-forwarded-for': '203.0.113.1, 198.51.100.1' }
      );
      await POST(request);

      // Should use first IP from comma-separated list
      expect(mockCheckRateLimit).toHaveBeenNthCalledWith(1, '203.0.113.1', expect.any(Object));
    });

    it('falls_back_to_x_real_ip_when_x_forwarded_for_missing', async () => {
      const request = createRequest(
        { email: 'user@example.com', password: 'password' },
        { 'x-real-ip': '10.0.0.50' }
      );
      await POST(request);

      expect(mockCheckRateLimit).toHaveBeenNthCalledWith(1, '10.0.0.50', expect.any(Object));
    });

    // TODO: REVIEW - Is 'unknown' the right fallback, or should we reject?
    it('uses_unknown_when_no_ip_headers_present', async () => {
      const request = createRequest({ email: 'user@example.com', password: 'password' });
      await POST(request);

      expect(mockCheckRateLimit).toHaveBeenNthCalledWith(1, 'unknown', expect.any(Object));
    });
  });

  // === ERROR HANDLING ===

  describe('error_handling', () => {
    it('returns_500_when_database_query_fails', async () => {
      mockDbQueryUsersFindFirst.mockRejectedValue(new Error('Connection timeout'));

      const request = createRequest({ email: 'user@example.com', password: 'password' });
      const response = await POST(request);

      expect(response.status).toBe(500);
    });

    it('returns_500_when_token_generation_fails', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(createUser());
      mockBcryptCompare.mockResolvedValue(true);
      mockGenerateAccessToken.mockRejectedValue(new Error('JWT signing failed'));

      const request = createRequest({ email: 'user@example.com', password: 'password' });
      const response = await POST(request);

      expect(response.status).toBe(500);
    });

    it('returns_500_when_refresh_token_storage_fails', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(createUser());
      mockBcryptCompare.mockResolvedValue(true);
      mockDbInsertValues.mockRejectedValue(new Error('Insert failed'));

      const request = createRequest({ email: 'user@example.com', password: 'password' });
      const response = await POST(request);

      expect(response.status).toBe(500);
    });
  });
});
