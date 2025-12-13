import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextResponse } from 'next/server';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock @/lib/auth
const { mockAuthenticateRequest, mockIsAuthError } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: mockAuthenticateRequest,
  isAuthError: mockIsAuthError,
}));

// Mock @pagespace/lib
const { mockCreateVerificationToken } = vi.hoisted(() => ({
  mockCreateVerificationToken: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
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
  VerificationEmail: () => null,
}));

// Mock @pagespace/lib/server
const { mockLoggerInfo, mockLoggerError } = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      info: mockLoggerInfo,
      error: mockLoggerError,
    },
  },
}));

// Mock database
const { mockSelectWhere } = vi.hoisted(() => ({
  mockSelectWhere: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: mockSelectWhere,
        })),
      })),
    })),
  },
  users: {},
  eq: vi.fn(),
}));

// Mock React for createElement
vi.mock('react', () => ({
  default: {
    createElement: vi.fn(() => ({})),
  },
  createElement: vi.fn(() => ({})),
}));

// Import after mocks
import { POST } from '../route';

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string): WebAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock user
const mockUser = (overrides: Partial<{
  id: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
}> = {}) => ({
  id: overrides.id ?? 'user_123',
  email: overrides.email ?? 'test@example.com',
  name: 'name' in overrides ? overrides.name : 'Test User',
  emailVerified: overrides.emailVerified ?? false,
});

// Helper to create request
const createRequest = (headers?: Record<string, string>) => {
  return new Request('https://example.com/api/auth/resend-verification', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
};

describe('POST /api/auth/resend-verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default authenticated user
    mockAuthenticateRequest.mockResolvedValue(mockWebAuth('user_123'));
    mockIsAuthError.mockReturnValue(false);

    // Default user exists and email not verified
    mockSelectWhere.mockResolvedValue([mockUser()]);

    // Default token creation
    mockCreateVerificationToken.mockResolvedValue('new-verification-token');

    // Default email send success
    mockSendEmail.mockResolvedValue(undefined);

    // Set default environment
    process.env.WEB_APP_URL = 'https://pagespace.app';
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.WEB_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  describe('Authentication', () => {
    it('should return 401 when not authenticated', async () => {
      mockIsAuthError.mockReturnValue(true);
      mockAuthenticateRequest.mockResolvedValue(mockAuthError(401));

      const request = createRequest();
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with correct options', async () => {
      const request = createRequest();
      await POST(request);

      expect(mockAuthenticateRequest).toHaveBeenCalledWith(
        request,
        { allow: ['jwt'], requireCSRF: true }
      );
    });

    it('should return 403 when CSRF token is invalid', async () => {
      mockIsAuthError.mockReturnValue(true);
      mockAuthenticateRequest.mockResolvedValue(mockAuthError(403));

      const request = createRequest();
      const response = await POST(request);

      expect(response.status).toBe(403);
    });
  });

  describe('User Not Found', () => {
    it('should return 404 when user not found', async () => {
      mockSelectWhere.mockResolvedValue([]);

      const request = createRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });
  });

  describe('Email Already Verified', () => {
    it('should return 400 when email is already verified', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ emailVerified: true })]);

      const request = createRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Email is already verified');
    });

    it('should not create token when email already verified', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ emailVerified: true })]);

      const request = createRequest();
      await POST(request);

      expect(mockCreateVerificationToken).not.toHaveBeenCalled();
    });

    it('should not send email when already verified', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ emailVerified: true })]);

      const request = createRequest();
      await POST(request);

      expect(mockSendEmail).not.toHaveBeenCalled();
    });
  });

  describe('Successful Verification Email Resend', () => {
    it('should return 200 with success message', async () => {
      const request = createRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Verification email sent successfully. Please check your inbox.');
    });

    it('should create verification token with correct parameters', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ id: 'user_456' })]);

      const request = createRequest();
      await POST(request);

      expect(mockCreateVerificationToken).toHaveBeenCalledWith({
        userId: 'user_456',
        type: 'email_verification',
      });
    });

    it('should send email with correct parameters', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({
        id: 'user_456',
        email: 'user@example.com',
        name: 'John Doe',
      })]);
      mockCreateVerificationToken.mockResolvedValue('token-abc');

      const request = createRequest();
      await POST(request);

      expect(mockSendEmail).toHaveBeenCalledWith({
        to: 'user@example.com',
        subject: 'Verify your PageSpace email',
        react: expect.anything(),
      });
    });

    it('should use NEXT_PUBLIC_APP_URL in verification URL', async () => {
      delete process.env.WEB_APP_URL;
      process.env.NEXT_PUBLIC_APP_URL = 'https://public.pagespace.app';

      const request = createRequest();
      await POST(request);

      // Verification URL should be passed to email template
      expect(mockSendEmail).toHaveBeenCalled();
    });

    it('should default to localhost for verification URL', async () => {
      delete process.env.WEB_APP_URL;
      delete process.env.NEXT_PUBLIC_APP_URL;

      const request = createRequest();
      await POST(request);

      expect(mockSendEmail).toHaveBeenCalled();
    });

    it('should log success', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({
        id: 'user_456',
        email: 'user@example.com',
      })]);

      const request = createRequest();
      await POST(request);

      expect(mockLoggerInfo).toHaveBeenCalledWith('Verification email resent', {
        userId: 'user_456',
        email: 'user@example.com',
      });
    });

    it('should handle user with null name', async () => {
      mockSelectWhere.mockResolvedValue([mockUser({ name: null })]);

      const request = createRequest();
      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockSendEmail).toHaveBeenCalled();
    });
  });

  describe('Rate Limiting', () => {
    it('should return 429 when rate limited', async () => {
      mockSendEmail.mockRejectedValue(new Error('Too many emails sent. Please wait before trying again.'));

      const request = createRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many emails');
    });

    it('should pass through rate limit error message', async () => {
      mockSendEmail.mockRejectedValue(new Error('Too many emails sent to this address'));

      const request = createRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toBe('Too many emails sent to this address');
    });
  });

  describe('Error Handling', () => {
    it('should return 500 when database query fails', async () => {
      mockSelectWhere.mockRejectedValue(new Error('Database connection failed'));

      const request = createRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to send verification email');
    });

    it('should return 500 when token creation fails', async () => {
      mockCreateVerificationToken.mockRejectedValue(new Error('Token generation failed'));

      const request = createRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to send verification email');
    });

    it('should return 500 when email send fails (non-rate-limit)', async () => {
      mockSendEmail.mockRejectedValue(new Error('SMTP connection failed'));

      const request = createRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to send verification email');
    });

    it('should log error when verification fails', async () => {
      const error = new Error('Unexpected error');
      mockSelectWhere.mockRejectedValue(error);

      const request = createRequest();
      await POST(request);

      expect(mockLoggerError).toHaveBeenCalledWith('Error resending verification email', error);
    });

    it('should not expose internal error details', async () => {
      mockSelectWhere.mockRejectedValue(new Error('PostgreSQL connection refused at port 5432'));

      const request = createRequest();
      const response = await POST(request);
      const body = await response.json();

      expect(body.error).toBe('Failed to send verification email');
      expect(body.error).not.toContain('PostgreSQL');
    });
  });
});
