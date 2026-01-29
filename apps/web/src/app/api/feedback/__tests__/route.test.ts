import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { POST } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

/**
 * /api/feedback Endpoint Contract Tests
 *
 * This endpoint handles user feedback submissions with optional image attachments.
 *
 * Contract:
 *   Request: POST with valid session, CSRF token, and feedback payload
 *   Response:
 *     201: { message: string } - Feedback submitted successfully
 *     400: { error: string } - Validation failed (message, attachments)
 *     401: { error: string } - Authentication required
 *     429: { error: string } - Rate limit exceeded
 *     500: { error: string } - Internal error
 *
 * Security Properties:
 *   - Requires session authentication (no API keys)
 *   - Requires CSRF token
 *   - Rate limited per user
 *   - Zero-trust attachment validation (magic bytes verification)
 */

// Mock dependencies at system boundaries
vi.mock('@pagespace/db', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  },
  feedbackSubmissions: {},
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: {
    CONTACT_FORM: { maxRequests: 5, windowMs: 3600000 },
  },
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('test-feedback-id'),
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDistributedRateLimit } from '@pagespace/lib/security';

// Test fixtures
const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: Response.json({ error: 'Unauthorized' }, { status }),
});

// Valid base64-encoded images for testing
const VALID_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';
const VALID_JPEG_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof';
const SPOOFED_PNG_DATA_URL = 'data:image/png;base64,YWJjZGVmZ2hpamtsbW5vcA=='; // Random bytes, not PNG

const createRequest = (body: object) => {
  return new Request('http://localhost/api/feedback', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': 'session=valid-session',
      'X-CSRF-Token': 'valid-csrf-token',
    },
    body: JSON.stringify(body),
  });
};

describe('/api/feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user, rate limit allowed
    (authenticateRequestWithOptions as unknown as Mock).mockResolvedValue(mockWebAuth('user-123'));
    (isAuthError as unknown as Mock).mockReturnValue(false);
    (checkDistributedRateLimit as unknown as Mock).mockResolvedValue({ allowed: true });
  });

  describe('successful feedback submission', () => {
    it('POST_withValidFeedback_returns201', async () => {
      const request = createRequest({
        message: 'Great product! Love the new features.',
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.message).toContain('successfully');
    });

    it('POST_withValidFeedbackAndAttachment_returns201', async () => {
      const request = createRequest({
        message: 'Found a bug, see screenshot',
        attachments: [
          {
            name: 'screenshot.png',
            type: 'image/png',
            data: VALID_PNG_DATA_URL,
          },
        ],
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.message).toContain('successfully');
    });

    it('POST_withValidFeedback_insertsToDatabase', async () => {
      const request = createRequest({
        message: 'Test feedback message',
        context: {
          pageUrl: 'https://example.com/page',
          userAgent: 'Mozilla/5.0',
          screenSize: '1920x1080',
          viewportSize: '1280x720',
          appVersion: '1.0.0',
        },
      });

      await POST(request);

      expect(db.insert).toHaveBeenCalled();
      const insertMock = db.insert as unknown as Mock;
      const valuesMock = insertMock.mock.results[0].value.values as Mock;
      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
          message: 'Test feedback message',
          pageUrl: 'https://example.com/page',
          viewportSize: '1280x720',
        })
      );
    });

    it('POST_withValidFeedback_logsSubmission', async () => {
      const request = createRequest({
        message: 'Test feedback',
      });

      await POST(request);

      expect(loggers.api.info).toHaveBeenCalledWith(
        'Feedback submission received',
        expect.objectContaining({
          userId: 'user-123',
          feedbackId: 'test-feedback-id',
        })
      );
    });
  });

  describe('authentication errors (401)', () => {
    it('POST_withNoSession_returns401', async () => {
      (authenticateRequestWithOptions as unknown as Mock).mockResolvedValue(mockAuthError(401));
      (isAuthError as unknown as Mock).mockReturnValue(true);

      const request = createRequest({ message: 'Test' });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('POST_withInvalidSession_returns401', async () => {
      (authenticateRequestWithOptions as unknown as Mock).mockResolvedValue(mockAuthError(401));
      (isAuthError as unknown as Mock).mockReturnValue(true);

      const request = createRequest({ message: 'Test' });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });
  });

  describe('rate limiting (429)', () => {
    it('POST_whenRateLimitExceeded_returns429', async () => {
      (checkDistributedRateLimit as unknown as Mock).mockResolvedValue({
        allowed: false,
        retryAfter: 1800,
      });

      const request = createRequest({ message: 'Test' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many');
      expect(response.headers.get('Retry-After')).toBe('1800');
    });

    it('POST_whenRateLimitExceeded_logsWarning', async () => {
      (checkDistributedRateLimit as unknown as Mock).mockResolvedValue({
        allowed: false,
        retryAfter: 3600,
      });

      const request = createRequest({ message: 'Test' });
      await POST(request);

      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Feedback rate limit exceeded',
        expect.objectContaining({ userId: 'user-123' })
      );
    });
  });

  describe('validation errors (400)', () => {
    it('POST_withEmptyMessage_returns400', async () => {
      const request = createRequest({ message: '' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });

    it('POST_withMessageTooLong_returns400', async () => {
      const request = createRequest({ message: 'x'.repeat(2001) });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });

    it('POST_withTooManyAttachments_returns400', async () => {
      const attachments = Array(6).fill({
        name: 'test.png',
        type: 'image/png',
        data: VALID_PNG_DATA_URL,
      });

      const request = createRequest({
        message: 'Test',
        attachments,
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });

    it('POST_withDisallowedMimeType_returns400', async () => {
      const request = createRequest({
        message: 'Test',
        attachments: [
          {
            name: 'script.svg',
            type: 'image/svg+xml',
            data: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
          },
        ],
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });

    it('POST_withOversizedAttachment_returns400', async () => {
      // Create a large base64 string (simulates >10MB file)
      const largeData = 'data:image/png;base64,' + 'A'.repeat(15 * 1024 * 1024);

      const request = createRequest({
        message: 'Test',
        attachments: [
          {
            name: 'large.png',
            type: 'image/png',
            data: largeData,
          },
        ],
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('exceeds maximum size');
    });
  });

  describe('zero-trust attachment validation (400)', () => {
    it('POST_withSpoofedMagicBytes_returns400', async () => {
      const request = createRequest({
        message: 'Spoofed attachment',
        attachments: [
          {
            name: 'fake.png',
            type: 'image/png',
            data: SPOOFED_PNG_DATA_URL,
          },
        ],
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('magic bytes');
    });

    it('POST_withMismatchedDataUrlMime_returns400', async () => {
      const request = createRequest({
        message: 'Mismatched MIME',
        attachments: [
          {
            name: 'test.png',
            type: 'image/png',
            data: VALID_JPEG_DATA_URL, // JPEG data but declared as PNG
          },
        ],
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('mismatch');
    });

    it('POST_withInvalidDataUrlFormat_returns400', async () => {
      const request = createRequest({
        message: 'Invalid data URL',
        attachments: [
          {
            name: 'test.png',
            type: 'image/png',
            data: 'not-a-valid-data-url',
          },
        ],
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid data URL');
    });

    it('POST_withSpoofedAttachment_logsWarning', async () => {
      const request = createRequest({
        message: 'Spoofed attachment',
        attachments: [
          {
            name: 'fake.png',
            type: 'image/png',
            data: SPOOFED_PNG_DATA_URL,
          },
        ],
      });

      await POST(request);

      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Feedback attachment validation failed',
        expect.objectContaining({
          userId: 'user-123',
          fileName: 'fake.png',
          declaredType: 'image/png',
        })
      );
    });
  });

  describe('error handling (500)', () => {
    it('POST_whenDatabaseThrows_returns500WithGenericError', async () => {
      const insertMock = db.insert as unknown as Mock;
      insertMock.mockReturnValue({
        values: vi.fn().mockRejectedValue(new Error('DB connection failed')),
      });

      const request = createRequest({ message: 'Test' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred. Please try again later.');
      expect(body.error).not.toContain('DB connection'); // Don't leak internals
    });

    it('POST_whenUnexpectedError_logsError', async () => {
      const insertMock = db.insert as unknown as Mock;
      insertMock.mockReturnValue({
        values: vi.fn().mockRejectedValue(new Error('Unexpected error')),
      });

      const request = createRequest({ message: 'Test' });
      await POST(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Feedback submission error',
        expect.any(Error)
      );
    });
  });
});
