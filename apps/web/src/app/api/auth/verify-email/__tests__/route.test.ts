import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock @pagespace/lib/verification-utils
const { mockVerifyToken, mockMarkEmailVerified } = vi.hoisted(() => ({
  mockVerifyToken: vi.fn(),
  mockMarkEmailVerified: vi.fn(),
}));

vi.mock('@pagespace/lib/verification-utils', () => ({
  verifyToken: mockVerifyToken,
  markEmailVerified: mockMarkEmailVerified,
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

// Mock @pagespace/lib/activity-tracker
const { mockTrackAuthEvent } = vi.hoisted(() => ({
  mockTrackAuthEvent: vi.fn(),
}));

vi.mock('@pagespace/lib/activity-tracker', () => ({
  trackAuthEvent: mockTrackAuthEvent,
}));

// Import after mocks
import { GET } from '../route';

// Helper to create request with token
const createRequest = (token?: string) => {
  const url = token
    ? `https://example.com/api/auth/verify-email?token=${token}`
    : 'https://example.com/api/auth/verify-email';

  return new NextRequest(url, { method: 'GET' });
};

describe('GET /api/auth/verify-email', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default successful verification
    mockVerifyToken.mockResolvedValue('user_123');
    mockMarkEmailVerified.mockResolvedValue(undefined);

    // Set default environment
    process.env.WEB_APP_URL = 'https://pagespace.app';
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.WEB_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  describe('Token Validation', () => {
    it('should return 400 when token is missing', async () => {
      const request = createRequest();
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Verification token is required');
    });

    it('should return 400 when token is empty string', async () => {
      const request = createRequest('');
      const response = await GET(request);

      // Empty string becomes falsy
      expect(response.status).toBe(400);
    });

    it('should call verifyToken with correct type', async () => {
      const request = createRequest('valid-token');
      await GET(request);

      expect(mockVerifyToken).toHaveBeenCalledWith('valid-token', 'email_verification');
    });
  });

  describe('Invalid or Expired Token', () => {
    it('should return 400 when token is invalid', async () => {
      mockVerifyToken.mockResolvedValue(null);

      const request = createRequest('invalid-token');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid or expired verification token');
    });

    it('should return 400 when token is expired', async () => {
      mockVerifyToken.mockResolvedValue(null);

      const request = createRequest('expired-token');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid or expired verification token');
    });

    it('should return 400 when token returns undefined', async () => {
      mockVerifyToken.mockResolvedValue(undefined);

      const request = createRequest('bad-token');
      const response = await GET(request);

      expect(response.status).toBe(400);
    });

    it('should not call markEmailVerified when token is invalid', async () => {
      mockVerifyToken.mockResolvedValue(null);

      const request = createRequest('invalid-token');
      await GET(request);

      expect(mockMarkEmailVerified).not.toHaveBeenCalled();
    });
  });

  describe('Successful Verification', () => {
    it('should call markEmailVerified with user ID', async () => {
      mockVerifyToken.mockResolvedValue('user_456');

      const request = createRequest('valid-token');
      await GET(request);

      expect(mockMarkEmailVerified).toHaveBeenCalledWith('user_456');
    });

    it('should redirect to dashboard with auth=success', async () => {
      const request = createRequest('valid-token');
      const response = await GET(request);

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('https://pagespace.app/dashboard?auth=success');
    });

    it('should use NEXT_PUBLIC_APP_URL if WEB_APP_URL not set', async () => {
      delete process.env.WEB_APP_URL;
      process.env.NEXT_PUBLIC_APP_URL = 'https://public.pagespace.app';

      const request = createRequest('valid-token');
      const response = await GET(request);

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('https://public.pagespace.app/dashboard?auth=success');
    });

    it('should default to localhost if no URL env vars set', async () => {
      delete process.env.WEB_APP_URL;
      delete process.env.NEXT_PUBLIC_APP_URL;

      const request = createRequest('valid-token');
      const response = await GET(request);

      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('http://localhost:3000/dashboard?auth=success');
    });

    it('should log verification success', async () => {
      mockVerifyToken.mockResolvedValue('user_789');

      const request = createRequest('valid-token');
      await GET(request);

      expect(mockLoggerInfo).toHaveBeenCalledWith('Email verified', { userId: 'user_789' });
    });

    it('should track email_verified auth event', async () => {
      mockVerifyToken.mockResolvedValue('user_789');

      const request = createRequest('valid-token');
      await GET(request);

      expect(mockTrackAuthEvent).toHaveBeenCalledWith('user_789', 'email_verified', {});
    });
  });

  describe('Error Handling', () => {
    it('should return 500 when verifyToken throws', async () => {
      mockVerifyToken.mockRejectedValue(new Error('Database error'));

      const request = createRequest('valid-token');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Email verification failed');
    });

    it('should return 500 when markEmailVerified throws', async () => {
      mockMarkEmailVerified.mockRejectedValue(new Error('Database error'));

      const request = createRequest('valid-token');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Email verification failed');
    });

    it('should log error when verification fails', async () => {
      const error = new Error('Unexpected error');
      mockVerifyToken.mockRejectedValue(error);

      const request = createRequest('valid-token');
      await GET(request);

      expect(mockLoggerError).toHaveBeenCalledWith('Email verification error', error);
    });

    it('should not expose internal error details', async () => {
      mockVerifyToken.mockRejectedValue(new Error('Internal database connection failed'));

      const request = createRequest('valid-token');
      const response = await GET(request);
      const body = await response.json();

      expect(body.error).toBe('Email verification failed');
      expect(body.error).not.toContain('database');
    });
  });

  describe('Token Edge Cases', () => {
    it('should handle tokens with special characters', async () => {
      const request = createRequest('token-with-special_chars.123');
      await GET(request);

      expect(mockVerifyToken).toHaveBeenCalledWith('token-with-special_chars.123', 'email_verification');
    });

    it('should handle very long tokens', async () => {
      const longToken = 'a'.repeat(500);
      const request = createRequest(longToken);
      await GET(request);

      expect(mockVerifyToken).toHaveBeenCalledWith(longToken, 'email_verification');
    });

    it('should handle URL-encoded tokens', async () => {
      // URL encoding is handled by NextRequest - %20 becomes space
      const request = new NextRequest(
        `https://example.com/api/auth/verify-email?token=token%20with%20spaces`,
        { method: 'GET' }
      );
      await GET(request);

      expect(mockVerifyToken).toHaveBeenCalledWith('token with spaces', 'email_verification');
    });
  });
});
