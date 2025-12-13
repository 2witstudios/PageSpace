import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @pagespace/db
const {
  mockDbQueryUsersFindFirst,
  mockDbInsertReturning,
  mockDbInsertValues,
} = vi.hoisted(() => ({
  mockDbQueryUsersFindFirst: vi.fn(),
  mockDbInsertReturning: vi.fn(),
  mockDbInsertValues: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: { users: { findFirst: mockDbQueryUsersFindFirst } },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => ({ then: (cb: Function) => cb(mockDbInsertReturning()) })),
      })),
    })),
  },
  users: {},
  drives: {},
  userAiSettings: {},
  eq: vi.fn(),
}));

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
  mockGenerateAccessToken,
  mockCheckRateLimit,
  mockResetRateLimit,
  mockCreateNotification,
  mockDecodeToken,
  mockValidateOrCreateDeviceToken,
  mockGenerateCSRFToken,
  mockGetSessionIdFromJWT,
  mockLoggerInfo,
  mockLoggerError,
  mockLogAuthEvent,
} = vi.hoisted(() => ({
  mockSlugify: vi.fn(),
  mockGenerateAccessToken: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockResetRateLimit: vi.fn(),
  mockCreateNotification: vi.fn(),
  mockDecodeToken: vi.fn(),
  mockValidateOrCreateDeviceToken: vi.fn(),
  mockGenerateCSRFToken: vi.fn(),
  mockGetSessionIdFromJWT: vi.fn(),
  mockLoggerInfo: vi.fn(),
  mockLoggerError: vi.fn(),
  mockLogAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  slugify: mockSlugify,
  generateAccessToken: mockGenerateAccessToken,
  checkRateLimit: mockCheckRateLimit,
  resetRateLimit: mockResetRateLimit,
  createNotification: mockCreateNotification,
  decodeToken: mockDecodeToken,
  validateOrCreateDeviceToken: mockValidateOrCreateDeviceToken,
  generateCSRFToken: mockGenerateCSRFToken,
  getSessionIdFromJWT: mockGetSessionIdFromJWT,
  logAuthEvent: mockLogAuthEvent,
  loggers: {
    auth: {
      info: mockLoggerInfo,
      error: mockLoggerError,
    },
  },
  RATE_LIMIT_CONFIGS: {
    SIGNUP: { maxAttempts: 3, windowMs: 3600000, blockDurationMs: 3600000 },
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

// Mock email template
vi.mock('@pagespace/lib/email-templates/VerificationEmail', () => ({
  VerificationEmail: () => null,
}));

// Mock React
vi.mock('react', () => ({
  default: { createElement: vi.fn(() => ({})) },
  createElement: vi.fn(() => ({})),
}));

// Import after mocks
import { POST } from '../route';

// Helper to create mock user
const mockUser = (overrides: Partial<{
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  tokenVersion: number;
  role: 'user' | 'admin';
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  email: overrides.email ?? 'test@example.com',
  name: 'name' in overrides ? overrides.name : 'Test User',
  image: 'image' in overrides ? overrides.image : null,
  tokenVersion: overrides.tokenVersion ?? 0,
  role: overrides.role ?? 'user',
});

// Helper to create request
const createRequest = (body: Record<string, unknown>, headers?: Record<string, string>) => {
  return new Request('https://example.com/api/auth/mobile/signup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
};

describe('POST /api/auth/mobile/signup', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default rate limit - allowed
    mockCheckRateLimit.mockReturnValue({ allowed: true });

    // Default no existing user
    mockDbQueryUsersFindFirst.mockResolvedValue(null);

    // Default user creation
    mockBcryptHash.mockResolvedValue('hashed-password');
    mockDbInsertReturning.mockReturnValue([mockUser()]);

    // Default token generation
    mockGenerateAccessToken.mockResolvedValue('mock-access-token');
    mockDecodeToken.mockResolvedValue({
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    });
    mockValidateOrCreateDeviceToken.mockResolvedValue({ deviceToken: 'mock-device-token' });
    mockGetSessionIdFromJWT.mockReturnValue('mock-session-id');
    mockGenerateCSRFToken.mockReturnValue('mock-csrf-token');
    mockSlugify.mockImplementation((s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-'));

    // Default email sending
    mockCreateVerificationToken.mockResolvedValue('verification-token');
    mockSendEmail.mockResolvedValue(undefined);
    mockCreateNotification.mockResolvedValue(undefined);

    // Set env
    process.env.WEB_APP_URL = 'https://pagespace.app';
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.WEB_APP_URL;
  });

  describe('Validation', () => {
    it('should return 400 for missing name', async () => {
      const request = createRequest({
        email: 'test@example.com',
        password: 'ValidPass123!',
        confirmPassword: 'ValidPass123!',
        deviceId: 'device_123',
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('should return 400 for invalid email', async () => {
      const request = createRequest({
        name: 'Test User',
        email: 'not-an-email',
        password: 'ValidPass123!',
        confirmPassword: 'ValidPass123!',
        deviceId: 'device_123',
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('should return 400 for weak password', async () => {
      const request = createRequest({
        name: 'Test User',
        email: 'test@example.com',
        password: 'short',
        confirmPassword: 'short',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.password).toBeDefined();
    });

    it('should return 400 for password without uppercase', async () => {
      const request = createRequest({
        name: 'Test User',
        email: 'test@example.com',
        password: 'nouppercase123',
        confirmPassword: 'nouppercase123',
        deviceId: 'device_123',
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('should return 400 for password without number', async () => {
      const request = createRequest({
        name: 'Test User',
        email: 'test@example.com',
        password: 'NoNumberPassword',
        confirmPassword: 'NoNumberPassword',
        deviceId: 'device_123',
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('should return 400 for mismatched passwords', async () => {
      const request = createRequest({
        name: 'Test User',
        email: 'test@example.com',
        password: 'ValidPass123!',
        confirmPassword: 'DifferentPass123!',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.errors.confirmPassword).toBeDefined();
    });

    it('should return 400 for missing deviceId', async () => {
      const request = createRequest({
        name: 'Test User',
        email: 'test@example.com',
        password: 'ValidPass123!',
        confirmPassword: 'ValidPass123!',
      });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });
  });

  describe('Rate Limiting', () => {
    it('should return 429 when IP rate limit exceeded', async () => {
      mockCheckRateLimit.mockReturnValueOnce({ allowed: false, retryAfter: 3600 });

      const request = createRequest({
        name: 'Test User',
        email: 'test@example.com',
        password: 'ValidPass123!',
        confirmPassword: 'ValidPass123!',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('IP address');
    });

    it('should return 429 when email rate limit exceeded', async () => {
      mockCheckRateLimit
        .mockReturnValueOnce({ allowed: true })
        .mockReturnValueOnce({ allowed: false, retryAfter: 3600 });

      const request = createRequest({
        name: 'Test User',
        email: 'test@example.com',
        password: 'ValidPass123!',
        confirmPassword: 'ValidPass123!',
        deviceId: 'device_123',
      });
      const response = await POST(request);

      expect(response.status).toBe(429);
    });
  });

  describe('Existing User', () => {
    it('should return 409 when user already exists', async () => {
      mockDbQueryUsersFindFirst.mockResolvedValue(mockUser());

      const request = createRequest({
        name: 'Test User',
        email: 'existing@example.com',
        password: 'ValidPass123!',
        confirmPassword: 'ValidPass123!',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toBe('User with this email already exists');
    });
  });

  describe('Successful Signup', () => {
    it('should return 201 with user and tokens', async () => {
      const request = createRequest({
        name: 'New User',
        email: 'new@example.com',
        password: 'ValidPass123!',
        confirmPassword: 'ValidPass123!',
        deviceId: 'device_123',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.user).toBeDefined();
      expect(body.token).toBe('mock-access-token');
      expect(body.csrfToken).toBe('mock-csrf-token');
      expect(body.deviceToken).toBe('mock-device-token');
    });

    it('should hash password with bcrypt', async () => {
      const request = createRequest({
        name: 'Test User',
        email: 'test@example.com',
        password: 'ValidPass123!',
        confirmPassword: 'ValidPass123!',
        deviceId: 'device_123',
      });
      await POST(request);

      expect(mockBcryptHash).toHaveBeenCalledWith('ValidPass123!', 12);
    });

    it('should reset rate limits on success', async () => {
      const request = createRequest({
        name: 'Test User',
        email: 'test@example.com',
        password: 'ValidPass123!',
        confirmPassword: 'ValidPass123!',
        deviceId: 'device_123',
      });
      await POST(request);

      expect(mockResetRateLimit).toHaveBeenCalled();
    });

    it('should track signup event', async () => {
      const request = createRequest({
        name: 'Test User',
        email: 'test@example.com',
        password: 'ValidPass123!',
        confirmPassword: 'ValidPass123!',
        deviceId: 'device_123',
        platform: 'android',
        appVersion: '2.0.0',
      });
      await POST(request);

      expect(mockTrackAuthEvent).toHaveBeenCalledWith(
        'user_123',
        'signup',
        expect.objectContaining({
          platform: 'android',
          appVersion: '2.0.0',
        })
      );
    });
  });

  describe('Email Verification', () => {
    it('should send verification email', async () => {
      const request = createRequest({
        name: 'Test User',
        email: 'test@example.com',
        password: 'ValidPass123!',
        confirmPassword: 'ValidPass123!',
        deviceId: 'device_123',
      });
      await POST(request);

      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'test@example.com',
          subject: 'Verify your PageSpace email',
        })
      );
    });

    it('should create notification for email verification', async () => {
      const request = createRequest({
        name: 'Test User',
        email: 'test@example.com',
        password: 'ValidPass123!',
        confirmPassword: 'ValidPass123!',
        deviceId: 'device_123',
      });
      await POST(request);

      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'EMAIL_VERIFICATION_REQUIRED',
        })
      );
    });

    it('should not fail signup if email fails', async () => {
      mockSendEmail.mockRejectedValue(new Error('SMTP error'));

      const request = createRequest({
        name: 'Test User',
        email: 'test@example.com',
        password: 'ValidPass123!',
        confirmPassword: 'ValidPass123!',
        deviceId: 'device_123',
      });
      const response = await POST(request);

      expect(response.status).toBe(201);
    });
  });

  describe('CSRF Token Generation', () => {
    it('should return 500 if access token decode fails', async () => {
      mockDecodeToken.mockResolvedValue(null);

      const request = createRequest({
        name: 'Test User',
        email: 'test@example.com',
        password: 'ValidPass123!',
        confirmPassword: 'ValidPass123!',
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
        name: 'Test User',
        email: 'test@example.com',
        password: 'ValidPass123!',
        confirmPassword: 'ValidPass123!',
        deviceId: 'device_123',
      });
      const response = await POST(request);

      expect(response.status).toBe(500);
    });
  });
});
