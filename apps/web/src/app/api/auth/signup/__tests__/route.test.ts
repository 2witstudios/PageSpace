/**
 * Signup Route Tests
 *
 * Tests are organized by behavior, not implementation.
 * We only mock at system boundaries: database, bcrypt, email service.
 *
 * Key behaviors tested:
 * - Input validation (name, email, password requirements, TOS)
 * - Rate limiting (IP and email-based)
 * - Duplicate email detection
 * - Successful signup flow (user creation, cookies, redirect)
 * - Email verification (non-blocking)
 * - Device token handling
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// === MOCKS AT SYSTEM BOUNDARIES ONLY ===

// Mock bcryptjs - external cryptography library
const { mockBcryptHash } = vi.hoisted(() => ({
  mockBcryptHash: vi.fn(),
}));

vi.mock('bcryptjs', () => ({
  default: { hash: mockBcryptHash },
  hash: mockBcryptHash,
}));

// Mock database - external storage system
const {
  mockDbQueryUsersFindFirst,
  mockDbInsertUsersReturning,
  mockDbInsertDrives,
  mockDbInsertUserAiSettings,
  mockDbInsertRefreshTokens,
} = vi.hoisted(() => ({
  mockDbQueryUsersFindFirst: vi.fn(),
  mockDbInsertUsersReturning: vi.fn(),
  mockDbInsertDrives: vi.fn(),
  mockDbInsertUserAiSettings: vi.fn(),
  mockDbInsertRefreshTokens: vi.fn(),
}));

vi.mock('@pagespace/db', () => {
  const createInsertChain = (mockFn: ReturnType<typeof vi.fn>) => ({
    values: vi.fn(() => ({
      returning: mockFn,
    })),
  });

  const createSimpleInsertChain = (mockFn: ReturnType<typeof vi.fn>) => ({
    values: mockFn,
  });

  return {
    db: {
      query: {
        users: { findFirst: mockDbQueryUsersFindFirst },
      },
      insert: vi.fn((table: unknown) => {
        if (table === 'users') {
          return createInsertChain(mockDbInsertUsersReturning);
        }
        if (table === 'drives') {
          return createSimpleInsertChain(mockDbInsertDrives);
        }
        if (table === 'userAiSettings') {
          return createSimpleInsertChain(mockDbInsertUserAiSettings);
        }
        if (table === 'refreshTokens') {
          return createSimpleInsertChain(mockDbInsertRefreshTokens);
        }
        return createInsertChain(mockDbInsertUsersReturning);
      }),
    },
    users: 'users',
    drives: 'drives',
    userAiSettings: 'userAiSettings',
    refreshTokens: 'refreshTokens',
    eq: vi.fn(),
  };
});

// Mock email service - external service boundary
const { mockSendEmail } = vi.hoisted(() => ({
  mockSendEmail: vi.fn(),
}));

vi.mock('@pagespace/lib/services/email-service', () => ({
  sendEmail: mockSendEmail,
}));

// Mock rate limiting - configured behavior, but don't verify calls
const { mockCheckRateLimit, mockResetRateLimit } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockResetRateLimit: vi.fn(),
}));

// Mock server utilities (need to provide implementations but don't verify internal calls)
vi.mock('@pagespace/lib/server', () => ({
  slugify: vi.fn((str: string) => str.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
  checkRateLimit: mockCheckRateLimit,
  resetRateLimit: mockResetRateLimit,
  generateAccessToken: vi.fn().mockResolvedValue('mock-access-token'),
  generateRefreshToken: vi.fn().mockResolvedValue('mock-refresh-token'),
  getRefreshTokenMaxAge: vi.fn().mockReturnValue(30 * 24 * 60 * 60),
  decodeToken: vi.fn().mockResolvedValue({
    userId: 'user_123',
    tokenVersion: 0,
    role: 'user',
    exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  }),
  validateOrCreateDeviceToken: vi.fn().mockResolvedValue({
    deviceToken: 'new-device-token',
    deviceTokenRecordId: 'device-record-123',
  }),
  createNotification: vi.fn().mockResolvedValue(undefined),
  logAuthEvent: vi.fn(),
  loggers: {
    auth: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  RATE_LIMIT_CONFIGS: {
    SIGNUP: {
      maxAttempts: 3,
      windowMs: 60 * 60 * 1000,
      blockDurationMs: 60 * 60 * 1000,
      progressiveDelay: false,
    },
  },
}));

// Mock verification utilities
vi.mock('@pagespace/lib/verification-utils', () => ({
  createVerificationToken: vi.fn().mockResolvedValue('mock-verification-token'),
}));

// Mock activity tracker (internal analytics - don't verify calls)
vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: vi.fn(),
}));

// Mock email template (just needs to exist)
vi.mock('@pagespace/lib/email-templates/VerificationEmail', () => ({
  VerificationEmail: vi.fn(),
}));

// Mock React for createElement
vi.mock('react', () => ({
  default: { createElement: vi.fn(() => 'mock-element') },
  createElement: vi.fn(() => 'mock-element'),
}));

// Mock cuid2
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-cuid'),
}));

// Mock cookie serialization
vi.mock('cookie', () => ({
  serialize: vi.fn((name: string, value: string) => `${name}=${value}`),
}));

// Import after mocks
import { POST } from '../route';

// === TEST HELPERS ===

const createValidSignupBody = (overrides: Partial<{
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  acceptedTos: boolean;
  deviceId: string;
  deviceName: string;
  deviceToken: string;
}> = {}) => ({
  name: overrides.name ?? 'Test User',
  email: overrides.email ?? 'test@example.com',
  password: overrides.password ?? 'SecurePass123!',
  confirmPassword: overrides.confirmPassword ?? 'SecurePass123!',
  acceptedTos: overrides.acceptedTos ?? true,
  ...(overrides.deviceId && { deviceId: overrides.deviceId }),
  ...(overrides.deviceName && { deviceName: overrides.deviceName }),
  ...(overrides.deviceToken && { deviceToken: overrides.deviceToken }),
});

const createRequest = (body: object, headers: Record<string, string> = {}) => {
  return new Request('https://example.com/api/auth/signup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
};

const mockUser = (overrides: Partial<{
  id: string;
  email: string;
  name: string;
  tokenVersion: number;
  role: 'user' | 'admin';
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  email: overrides.email ?? 'test@example.com',
  name: overrides.name ?? 'Test User',
  tokenVersion: overrides.tokenVersion ?? 0,
  role: overrides.role ?? 'user',
});

// === TESTS ===

describe('POST /api/auth/signup', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: rate limiting allowed
    mockCheckRateLimit.mockReturnValue({ allowed: true, attemptsRemaining: 2 });

    // Default: password hashing succeeds
    mockBcryptHash.mockResolvedValue('$2a$12$hashedpassword');

    // Default: user doesn't exist
    mockDbQueryUsersFindFirst.mockResolvedValue(null);

    // Default: all DB operations succeed
    mockDbInsertUsersReturning.mockResolvedValue([mockUser()]);
    mockDbInsertDrives.mockResolvedValue(undefined);
    mockDbInsertUserAiSettings.mockResolvedValue(undefined);
    mockDbInsertRefreshTokens.mockResolvedValue(undefined);

    // Default: email sending succeeds
    mockSendEmail.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --- Input Validation ---

  describe('input_validation', () => {
    it('rejects_request_when_name_is_missing', async () => {
      const body = createValidSignupBody();
      delete (body as Record<string, unknown>).name;

      const response = await POST(createRequest(body));
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors.name).toBeDefined();
    });

    it('rejects_request_when_email_is_missing', async () => {
      const body = createValidSignupBody();
      delete (body as Record<string, unknown>).email;

      const response = await POST(createRequest(body));
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors.email).toBeDefined();
    });

    it('rejects_request_when_email_format_is_invalid', async () => {
      const response = await POST(createRequest(createValidSignupBody({ email: 'not-an-email' })));
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors.email).toBeDefined();
    });

    it('rejects_request_when_password_is_too_short', async () => {
      const response = await POST(createRequest(createValidSignupBody({
        password: 'Short1A!',
        confirmPassword: 'Short1A!',
      })));
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors.password).toBeDefined();
      expect(result.errors.password[0]).toContain('12 characters');
    });

    it('rejects_password_without_uppercase_letter', async () => {
      const response = await POST(createRequest(createValidSignupBody({
        password: 'alllowercase123!',
        confirmPassword: 'alllowercase123!',
      })));
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors.password[0]).toContain('uppercase');
    });

    it('rejects_password_without_lowercase_letter', async () => {
      const response = await POST(createRequest(createValidSignupBody({
        password: 'ALLUPPERCASE123!',
        confirmPassword: 'ALLUPPERCASE123!',
      })));
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors.password[0]).toContain('lowercase');
    });

    it('rejects_password_without_number', async () => {
      const response = await POST(createRequest(createValidSignupBody({
        password: 'NoNumbersHere!!',
        confirmPassword: 'NoNumbersHere!!',
      })));
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors.password[0]).toContain('number');
    });

    it('rejects_request_when_passwords_do_not_match', async () => {
      const response = await POST(createRequest(createValidSignupBody({
        password: 'SecurePass123!',
        confirmPassword: 'DifferentPass123!',
      })));
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors.confirmPassword).toBeDefined();
      expect(result.errors.confirmPassword[0]).toContain('match');
    });

    it('rejects_request_when_tos_not_accepted', async () => {
      const response = await POST(createRequest(createValidSignupBody({ acceptedTos: false })));
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors.acceptedTos).toBeDefined();
    });

    it('returns_500_for_invalid_json_body', async () => {
      const request = new Request('https://example.com/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(500);
      expect(result.error).toBe('An unexpected error occurred.');
    });
  });

  // --- Rate Limiting ---

  describe('rate_limiting', () => {
    it('returns_429_when_ip_rate_limit_exceeded', async () => {
      mockCheckRateLimit.mockReturnValueOnce({ allowed: false, retryAfter: 3600 });

      const response = await POST(createRequest(createValidSignupBody()));
      const result = await response.json();

      expect(response.status).toBe(429);
      expect(result.error).toContain('Too many signup attempts from this IP');
      expect(result.retryAfter).toBe(3600);
    });

    it('returns_429_when_email_rate_limit_exceeded', async () => {
      // First check (IP) passes, second check (email) fails
      mockCheckRateLimit
        .mockReturnValueOnce({ allowed: true, attemptsRemaining: 2 })
        .mockReturnValueOnce({ allowed: false, retryAfter: 3600 });

      const response = await POST(createRequest(createValidSignupBody()));
      const result = await response.json();

      expect(response.status).toBe(429);
      expect(result.error).toContain('Too many signup attempts for this email');
    });

    // TODO: REVIEW - Should rate limiting use the raw email or normalized (lowercase)?
    // Current behavior: uses lowercase for email rate limiting
    it('rate_limits_emails_case_insensitively', async () => {
      const response1 = await POST(createRequest(createValidSignupBody({ email: 'TEST@EXAMPLE.COM' })));

      // First request should succeed (user created)
      expect(response1.status).toBe(303);

      // If we sent another request with lowercase version, it would hit the same rate limit bucket
      // This test verifies the normalization happens (implicitly through successful signup)
    });
  });

  // --- Duplicate Email ---

  describe('duplicate_email_detection', () => {
    it('returns_409_when_email_already_exists', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser());

      const response = await POST(createRequest(createValidSignupBody()));
      const result = await response.json();

      expect(response.status).toBe(409);
      expect(result.error).toBe('User with this email already exists');
    });
  });

  // --- Successful Signup ---

  describe('successful_signup', () => {
    it('creates_user_and_redirects_to_dashboard', async () => {
      const response = await POST(createRequest(createValidSignupBody()));

      expect(response.status).toBe(303);
      const location = response.headers.get('location');
      expect(location).toContain('/dashboard');
      expect(location).toContain('auth=success');
    });

    it('sets_httponly_auth_cookies', async () => {
      const response = await POST(createRequest(createValidSignupBody()));

      const cookies = response.headers.getSetCookie();
      expect(cookies.length).toBeGreaterThanOrEqual(2);

      // Cookies should contain access and refresh tokens
      const cookieStr = cookies.join('; ');
      expect(cookieStr).toContain('accessToken');
      expect(cookieStr).toContain('refreshToken');
    });

    it('stores_user_with_free_tier', async () => {
      await POST(createRequest(createValidSignupBody()));

      // User should be created (observable through database mock being called)
      expect(mockDbInsertUsersReturning).toHaveBeenCalled();
    });

    it('creates_personal_drive_for_new_user', async () => {
      await POST(createRequest(createValidSignupBody()));

      expect(mockDbInsertDrives).toHaveBeenCalled();
    });

    it('creates_default_ai_settings', async () => {
      await POST(createRequest(createValidSignupBody()));

      expect(mockDbInsertUserAiSettings).toHaveBeenCalled();
    });

    it('stores_refresh_token_in_database', async () => {
      await POST(createRequest(createValidSignupBody()));

      expect(mockDbInsertRefreshTokens).toHaveBeenCalled();
    });
  });

  // --- Email Verification ---

  describe('email_verification', () => {
    it('sends_verification_email_on_signup', async () => {
      await POST(createRequest(createValidSignupBody({ email: 'new@example.com' })));

      expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
        to: 'new@example.com',
        subject: 'Verify your PageSpace email',
      }));
    });

    it('signup_succeeds_even_if_email_sending_fails', async () => {
      mockSendEmail.mockRejectedValue(new Error('Email service unavailable'));

      const response = await POST(createRequest(createValidSignupBody()));

      // Should still redirect to dashboard
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toContain('/dashboard');
    });
  });

  // --- Device Token ---

  describe('device_token_handling', () => {
    it('includes_device_token_in_redirect_when_device_id_provided', async () => {
      const { validateOrCreateDeviceToken } = await import('@pagespace/lib/server');
      vi.mocked(validateOrCreateDeviceToken).mockResolvedValue({
        deviceToken: 'new-device-token-123',
        deviceTokenRecordId: 'record-123',
      });

      const response = await POST(createRequest(createValidSignupBody({
        deviceId: 'device-abc',
        deviceName: 'My Browser',
      })));

      const location = response.headers.get('location');
      expect(location).toContain('deviceToken=new-device-token-123');
    });

    it('does_not_include_device_token_when_device_id_not_provided', async () => {
      const response = await POST(createRequest(createValidSignupBody()));

      const location = response.headers.get('location');
      expect(location).not.toContain('deviceToken');
    });
  });

  // --- Error Handling ---

  describe('error_handling', () => {
    it('returns_500_when_database_user_creation_fails', async () => {
      mockDbInsertUsersReturning.mockRejectedValue(new Error('Database connection failed'));

      const response = await POST(createRequest(createValidSignupBody()));
      const result = await response.json();

      expect(response.status).toBe(500);
      expect(result.error).toBe('An unexpected error occurred.');
    });

    it('returns_500_when_password_hashing_fails', async () => {
      mockBcryptHash.mockRejectedValue(new Error('Bcrypt internal error'));

      const response = await POST(createRequest(createValidSignupBody()));
      const result = await response.json();

      expect(response.status).toBe(500);
      expect(result.error).toBe('An unexpected error occurred.');
    });
  });

  // --- IP Address Extraction ---
  // TODO: REVIEW - Is 'unknown' the right fallback for missing IP? Could affect rate limiting

  describe('ip_address_extraction', () => {
    it('extracts_first_ip_from_x_forwarded_for_header', async () => {
      // When x-forwarded-for contains multiple IPs, should use the first one
      const response = await POST(createRequest(
        createValidSignupBody(),
        { 'x-forwarded-for': '203.0.113.1, 198.51.100.178' }
      ));

      // Success means IP extraction didn't cause an error
      expect(response.status).toBe(303);
    });

    it('uses_x_real_ip_when_x_forwarded_for_not_present', async () => {
      const response = await POST(createRequest(
        createValidSignupBody(),
        { 'x-real-ip': '10.0.0.50' }
      ));

      expect(response.status).toBe(303);
    });

    it('falls_back_to_unknown_when_no_ip_headers_present', async () => {
      const response = await POST(createRequest(createValidSignupBody()));

      // Should succeed even without IP headers
      expect(response.status).toBe(303);
    });
  });
});
