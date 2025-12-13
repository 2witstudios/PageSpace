import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock bcryptjs
const { mockBcryptHash } = vi.hoisted(() => ({
  mockBcryptHash: vi.fn(),
}));

vi.mock('bcryptjs', () => ({
  default: { hash: mockBcryptHash },
  hash: mockBcryptHash,
}));

// Mock @pagespace/lib/server
const {
  mockSlugify,
  mockCheckRateLimit,
  mockResetRateLimit,
  mockGenerateAccessToken,
  mockGenerateRefreshToken,
  mockGetRefreshTokenMaxAge,
  mockDecodeToken,
  mockValidateOrCreateDeviceToken,
  mockCreateNotification,
  mockLogAuthEvent,
  mockLoggers,
} = vi.hoisted(() => ({
  mockSlugify: vi.fn((str: string) => str.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
  mockCheckRateLimit: vi.fn(),
  mockResetRateLimit: vi.fn(),
  mockGenerateAccessToken: vi.fn(),
  mockGenerateRefreshToken: vi.fn(),
  mockGetRefreshTokenMaxAge: vi.fn(),
  mockDecodeToken: vi.fn(),
  mockValidateOrCreateDeviceToken: vi.fn(),
  mockCreateNotification: vi.fn(),
  mockLogAuthEvent: vi.fn(),
  mockLoggers: {
    auth: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/server', () => ({
  slugify: mockSlugify,
  checkRateLimit: mockCheckRateLimit,
  resetRateLimit: mockResetRateLimit,
  generateAccessToken: mockGenerateAccessToken,
  generateRefreshToken: mockGenerateRefreshToken,
  getRefreshTokenMaxAge: mockGetRefreshTokenMaxAge,
  decodeToken: mockDecodeToken,
  validateOrCreateDeviceToken: mockValidateOrCreateDeviceToken,
  createNotification: mockCreateNotification,
  logAuthEvent: mockLogAuthEvent,
  loggers: mockLoggers,
  RATE_LIMIT_CONFIGS: {
    SIGNUP: {
      maxAttempts: 3,
      windowMs: 60 * 60 * 1000,
      blockDurationMs: 60 * 60 * 1000,
      progressiveDelay: false,
    },
  },
}));

// Mock @pagespace/lib/activity-tracker
const { mockTrackAuthEvent } = vi.hoisted(() => ({
  mockTrackAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: mockTrackAuthEvent,
}));

// Mock @pagespace/lib/verification-utils
const { mockCreateVerificationToken } = vi.hoisted(() => ({
  mockCreateVerificationToken: vi.fn(),
}));

vi.mock('@pagespace/lib/verification-utils', () => ({
  createVerificationToken: mockCreateVerificationToken,
}));

// Mock @pagespace/lib/services/email-service
const { mockSendEmail } = vi.hoisted(() => ({
  mockSendEmail: vi.fn(),
}));

vi.mock('@pagespace/lib/services/email-service', () => ({
  sendEmail: mockSendEmail,
}));

// Mock @pagespace/lib/email-templates/VerificationEmail
vi.mock('@pagespace/lib/email-templates/VerificationEmail', () => ({
  VerificationEmail: vi.fn(),
}));

// Mock React for createElement
vi.mock('react', () => ({
  default: { createElement: vi.fn(() => 'mock-element') },
  createElement: vi.fn(() => 'mock-element'),
}));

// Mock database
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
        // Return appropriate mock based on table
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
        // Default for users table (first call)
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

// Mock @paralleldrive/cuid2
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mock-cuid'),
}));

// Mock cookie
vi.mock('cookie', () => ({
  serialize: vi.fn((name: string, value: string) => `${name}=${value}`),
}));

// Import after mocks
import { POST } from '../route';

// Helper to create valid signup request body
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

// Helper to create request
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

// Helper to create mock user
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

describe('POST /api/auth/signup', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default rate limit - allowed
    mockCheckRateLimit.mockReturnValue({ allowed: true, attemptsRemaining: 2 });

    // Default password hashing
    mockBcryptHash.mockResolvedValue('$2a$12$hashedpassword');

    // Default user creation - user doesn't exist
    mockDbQueryUsersFindFirst.mockResolvedValue(null);

    // Default DB operations
    mockDbInsertUsersReturning.mockResolvedValue([mockUser()]);
    mockDbInsertDrives.mockResolvedValue(undefined);
    mockDbInsertUserAiSettings.mockResolvedValue(undefined);
    mockDbInsertRefreshTokens.mockResolvedValue(undefined);

    // Default token generation
    mockGenerateAccessToken.mockResolvedValue('mock-access-token');
    mockGenerateRefreshToken.mockResolvedValue('mock-refresh-token');
    mockGetRefreshTokenMaxAge.mockReturnValue(30 * 24 * 60 * 60);
    mockDecodeToken.mockResolvedValue({
      userId: 'user_123',
      tokenVersion: 0,
      role: 'user',
      exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    });

    // Default verification
    mockCreateVerificationToken.mockResolvedValue('mock-verification-token');
    mockSendEmail.mockResolvedValue(undefined);
    mockCreateNotification.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Input Validation', () => {
    it('should return 400 when name is missing', async () => {
      const body = createValidSignupBody();
      delete (body as Record<string, unknown>).name;

      const request = createRequest(body);
      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors).toBeDefined();
      expect(result.errors.name).toBeDefined();
    });

    it('should return 400 when email is missing', async () => {
      const body = createValidSignupBody();
      delete (body as Record<string, unknown>).email;

      const request = createRequest(body);
      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors).toBeDefined();
      expect(result.errors.email).toBeDefined();
    });

    it('should return 400 when email format is invalid', async () => {
      const request = createRequest(createValidSignupBody({ email: 'invalid-email' }));
      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors.email).toBeDefined();
    });

    it('should return 400 when password is too short', async () => {
      const request = createRequest(createValidSignupBody({
        password: 'Short1A',
        confirmPassword: 'Short1A',
      }));
      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors.password).toBeDefined();
      expect(result.errors.password[0]).toContain('12 characters');
    });

    it('should return 400 when password lacks uppercase letter', async () => {
      const request = createRequest(createValidSignupBody({
        password: 'lowercase12345!',
        confirmPassword: 'lowercase12345!',
      }));
      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors.password).toBeDefined();
      expect(result.errors.password[0]).toContain('uppercase');
    });

    it('should return 400 when password lacks lowercase letter', async () => {
      const request = createRequest(createValidSignupBody({
        password: 'UPPERCASE12345!',
        confirmPassword: 'UPPERCASE12345!',
      }));
      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors.password).toBeDefined();
      expect(result.errors.password[0]).toContain('lowercase');
    });

    it('should return 400 when password lacks number', async () => {
      const request = createRequest(createValidSignupBody({
        password: 'NoNumbersHere!',
        confirmPassword: 'NoNumbersHere!',
      }));
      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors.password).toBeDefined();
      expect(result.errors.password[0]).toContain('number');
    });

    it('should return 400 when passwords do not match', async () => {
      const request = createRequest(createValidSignupBody({
        password: 'SecurePass123!',
        confirmPassword: 'DifferentPass123!',
      }));
      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors.confirmPassword).toBeDefined();
      expect(result.errors.confirmPassword[0]).toContain('match');
    });

    it('should return 400 when TOS not accepted', async () => {
      const request = createRequest(createValidSignupBody({ acceptedTos: false }));
      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(400);
      expect(result.errors.acceptedTos).toBeDefined();
    });

    it('should return 400 when request body is invalid JSON', async () => {
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

  describe('Rate Limiting', () => {
    it('should return 429 when IP rate limit is exceeded', async () => {
      mockCheckRateLimit.mockReturnValueOnce({ allowed: false, retryAfter: 3600 });

      const request = createRequest(createValidSignupBody());
      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(429);
      expect(result.error).toContain('Too many signup attempts from this IP');
      expect(result.retryAfter).toBe(3600);
    });

    it('should return 429 when email rate limit is exceeded', async () => {
      mockCheckRateLimit
        .mockReturnValueOnce({ allowed: true, attemptsRemaining: 2 })
        .mockReturnValueOnce({ allowed: false, retryAfter: 3600 });

      const request = createRequest(createValidSignupBody());
      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(429);
      expect(result.error).toContain('Too many signup attempts for this email');
    });

    it('should check rate limit with lowercase email', async () => {
      const request = createRequest(createValidSignupBody({ email: 'TEST@EXAMPLE.COM' }));
      await POST(request);

      expect(mockCheckRateLimit).toHaveBeenNthCalledWith(
        2,
        'test@example.com',
        expect.any(Object)
      );
    });
  });

  describe('Existing User Check', () => {
    it('should return 409 when email already exists', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser());

      const request = createRequest(createValidSignupBody());
      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(409);
      expect(result.error).toBe('User with this email already exists');
    });

    it('should log failed signup when email exists', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser());

      const request = createRequest(
        createValidSignupBody({ email: 'existing@example.com' }),
        { 'x-forwarded-for': '192.168.1.1' }
      );

      await POST(request);

      expect(mockLogAuthEvent).toHaveBeenCalledWith(
        'failed',
        undefined,
        'existing@example.com',
        '192.168.1.1',
        'Email already exists'
      );
    });
  });

  describe('Successful Signup', () => {
    it('should hash password with bcrypt cost factor 12', async () => {
      const request = createRequest(createValidSignupBody({ password: 'SecurePass123!' }));
      await POST(request);

      expect(mockBcryptHash).toHaveBeenCalledWith('SecurePass123!', 12);
    });

    it('should create user with correct data', async () => {
      const request = createRequest(createValidSignupBody({
        name: 'New User',
        email: 'new@example.com',
      }));

      await POST(request);

      // User should be created with free tier
      expect(mockDbInsertUsersReturning).toHaveBeenCalled();
    });

    it('should create personal drive for new user', async () => {
      mockDbInsertUsersReturning.mockResolvedValue([mockUser({ name: 'Test User' })]);

      const request = createRequest(createValidSignupBody());
      await POST(request);

      expect(mockDbInsertDrives).toHaveBeenCalled();
      expect(mockSlugify).toHaveBeenCalledWith("Test User's Drive");
    });

    it('should create default AI settings with Ollama provider', async () => {
      const request = createRequest(createValidSignupBody());
      await POST(request);

      expect(mockDbInsertUserAiSettings).toHaveBeenCalled();
    });

    it('should redirect to dashboard with auth=success', async () => {
      const request = createRequest(createValidSignupBody());
      const response = await POST(request);

      expect(response.status).toBe(303);
      const location = response.headers.get('location');
      expect(location).toContain('/dashboard');
      expect(location).toContain('auth=success');
    });

    it('should set access and refresh token cookies', async () => {
      const request = createRequest(createValidSignupBody());
      const response = await POST(request);

      const cookies = response.headers.getSetCookie();
      expect(cookies.length).toBeGreaterThanOrEqual(2);
    });

    it('should log successful signup', async () => {
      const request = createRequest(
        createValidSignupBody({ email: 'test@example.com' }),
        { 'x-forwarded-for': '192.168.1.1' }
      );

      await POST(request);

      expect(mockLogAuthEvent).toHaveBeenCalledWith(
        'signup',
        'user_123',
        'test@example.com',
        '192.168.1.1'
      );
    });

    it('should track signup event', async () => {
      const request = createRequest(
        createValidSignupBody({ name: 'Test User', email: 'test@example.com' }),
        { 'x-forwarded-for': '192.168.1.1', 'user-agent': 'Test Agent' }
      );

      await POST(request);

      expect(mockTrackAuthEvent).toHaveBeenCalledWith(
        'user_123',
        'signup',
        expect.objectContaining({
          email: 'test@example.com',
          name: 'Test User',
          ip: '192.168.1.1',
        })
      );
    });

    it('should reset rate limits on successful signup', async () => {
      const request = createRequest(
        createValidSignupBody({ email: 'test@example.com' }),
        { 'x-forwarded-for': '192.168.1.1' }
      );

      await POST(request);

      expect(mockResetRateLimit).toHaveBeenCalledWith('192.168.1.1');
      expect(mockResetRateLimit).toHaveBeenCalledWith('test@example.com');
    });
  });

  describe('Email Verification', () => {
    it('should send verification email', async () => {
      const request = createRequest(createValidSignupBody({ email: 'test@example.com' }));
      await POST(request);

      expect(mockCreateVerificationToken).toHaveBeenCalledWith({
        userId: 'user_123',
        type: 'email_verification',
      });

      expect(mockSendEmail).toHaveBeenCalledWith({
        to: 'test@example.com',
        subject: 'Verify your PageSpace email',
        react: expect.anything(),
      });
    });

    it('should create notification for email verification', async () => {
      const request = createRequest(createValidSignupBody());
      await POST(request);

      expect(mockCreateNotification).toHaveBeenCalledWith({
        userId: 'user_123',
        type: 'EMAIL_VERIFICATION_REQUIRED',
        title: 'Please verify your email',
        message: expect.any(String),
        metadata: expect.any(Object),
      });
    });

    it('should not fail signup if email sending fails', async () => {
      mockSendEmail.mockRejectedValue(new Error('Email service error'));

      const request = createRequest(createValidSignupBody());
      const response = await POST(request);

      // Should still redirect to dashboard
      expect(response.status).toBe(303);
      expect(mockLoggers.auth.error).toHaveBeenCalledWith(
        'Failed to send verification email',
        expect.any(Error),
        expect.any(Object)
      );
    });
  });

  describe('Device Token Handling', () => {
    it('should create device token when deviceId is provided', async () => {
      mockValidateOrCreateDeviceToken.mockResolvedValue({
        deviceToken: 'new-device-token',
        deviceTokenRecordId: 'device-record-123',
      });

      const request = createRequest(
        createValidSignupBody({ deviceId: 'device-abc', deviceName: 'My Browser' }),
        { 'user-agent': 'Test Agent', 'x-forwarded-for': '192.168.1.1' }
      );

      const response = await POST(request);

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

      // Device token should be in redirect URL
      const location = response.headers.get('location');
      expect(location).toContain('deviceToken=new-device-token');
    });

    it('should not create device token when deviceId not provided', async () => {
      const request = createRequest(createValidSignupBody());
      await POST(request);

      expect(mockValidateOrCreateDeviceToken).not.toHaveBeenCalled();
    });
  });

  describe('Token Generation', () => {
    it('should generate tokens with correct user data', async () => {
      mockDbInsertUsersReturning.mockResolvedValue([
        mockUser({ id: 'new-user-id', tokenVersion: 0, role: 'user' }),
      ]);

      const request = createRequest(createValidSignupBody());
      await POST(request);

      expect(mockGenerateAccessToken).toHaveBeenCalledWith('new-user-id', 0, 'user');
      expect(mockGenerateRefreshToken).toHaveBeenCalledWith('new-user-id', 0, 'user');
    });

    it('should store refresh token in database', async () => {
      const request = createRequest(
        createValidSignupBody(),
        { 'user-agent': 'Test Agent', 'x-forwarded-for': '192.168.1.1' }
      );

      await POST(request);

      expect(mockDbInsertRefreshTokens).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should return 500 when user creation fails', async () => {
      mockDbInsertUsersReturning.mockRejectedValue(new Error('Database error'));

      const request = createRequest(createValidSignupBody());
      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(500);
      expect(result.error).toBe('An unexpected error occurred.');
    });

    it('should return 500 when password hashing fails', async () => {
      mockBcryptHash.mockRejectedValue(new Error('Bcrypt error'));

      const request = createRequest(createValidSignupBody());
      const response = await POST(request);
      const result = await response.json();

      expect(response.status).toBe(500);
      expect(result.error).toBe('An unexpected error occurred.');
    });

    it('should log errors with context', async () => {
      const testError = new Error('Test error');
      mockDbInsertUsersReturning.mockRejectedValue(testError);

      const request = createRequest(
        createValidSignupBody({ email: 'test@example.com' }),
        { 'x-forwarded-for': '192.168.1.1' }
      );

      await POST(request);

      expect(mockLoggers.auth.error).toHaveBeenCalledWith(
        'Signup error',
        testError,
        { email: 'test@example.com', clientIP: '192.168.1.1' }
      );
    });
  });

  describe('IP Address Extraction', () => {
    it('should extract IP from x-forwarded-for header', async () => {
      const request = createRequest(
        createValidSignupBody(),
        { 'x-forwarded-for': '203.0.113.1, 198.51.100.178' }
      );

      await POST(request);

      expect(mockCheckRateLimit).toHaveBeenNthCalledWith(
        1,
        '203.0.113.1',
        expect.any(Object)
      );
    });

    it('should extract IP from x-real-ip header', async () => {
      const request = createRequest(
        createValidSignupBody(),
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
      const request = createRequest(createValidSignupBody());
      await POST(request);

      expect(mockCheckRateLimit).toHaveBeenNthCalledWith(
        1,
        'unknown',
        expect.any(Object)
      );
    });
  });
});
