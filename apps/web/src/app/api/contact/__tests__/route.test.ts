import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '../route';

/**
 * /api/contact Endpoint Contract Tests
 *
 * This endpoint handles public contact form submissions.
 *
 * Contract:
 *   Request: POST with name, email, subject, message
 *   Response:
 *     201: { message: string } - Submission saved
 *     400: { error: string } - Validation failed
 *     413: { error: string } - Payload too large
 *     429: { error: string } - Rate limit exceeded
 *     500: { error: string } - Internal error
 *
 * Security Properties:
 *   - No authentication required (public endpoint)
 *   - Rate limited: 10 requests/minute per IP
 *   - Payload size cap: 5KB
 *   - Strict schema validation
 */

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));
vi.mock('@pagespace/db/schema/contact', () => ({
  contactSubmissions: {},
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: {
    CONTACT_FORM: { maxAttempts: 10, windowMs: 60000 },
  },
}));

vi.mock('@/lib/auth/auth-helpers', () => ({
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

import { db } from '@pagespace/db/db';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';

const validPayload = {
  name: 'John Doe',
  email: 'john@example.com',
  subject: 'Hello there',
  message: 'This is a valid contact message with enough characters.',
};

const createRequest = (body: object, headers?: Record<string, string>) => {
  const bodyStr = JSON.stringify(body);
  return new Request('http://localhost/api/contact', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(bodyStr)),
      ...headers,
    },
    body: bodyStr,
  });
};

describe('/api/contact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true });
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  describe('successful submission', () => {
    it('POST_withValidPayload_returns201', async () => {
      const request = createRequest(validPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.message).toContain('successfully');
    });

    it('POST_withValidPayload_insertsToDatabase', async () => {
      const request = createRequest(validPayload);
      await POST(request);

      expect(db.insert).toHaveBeenCalledTimes(1);
      const valuesMock = (vi.mocked(db.insert).mock.results[0].value as { values: ReturnType<typeof vi.fn> }).values;
      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'John Doe',
          email: 'john@example.com',
          subject: 'Hello there',
        })
      );
    });

    it('POST_withValidPayload_logsSubmission', async () => {
      const request = createRequest(validPayload);
      await POST(request);

      expect(loggers.api.info).toHaveBeenCalledWith(
        'Contact submission received',
        expect.objectContaining({ ip: '127.0.0.1' })
      );
    });
  });

  describe('rate limiting (429)', () => {
    it('POST_whenRateLimitExceeded_returns429', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        retryAfter: 45,
      });

      const request = createRequest(validPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many');
      expect(response.headers.get('Retry-After')).toBe('45');
    });

    it('POST_whenRateLimitExceeded_doesNotInsert', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        retryAfter: 45,
      });

      const request = createRequest(validPayload);
      await POST(request);

      expect(db.insert).not.toHaveBeenCalled();
    });

    it('POST_whenRateLimitExceeded_logsWarning', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        retryAfter: 45,
      });

      const request = createRequest(validPayload);
      await POST(request);

      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Contact form rate limit exceeded',
        expect.objectContaining({ ip: '127.0.0.1' })
      );
    });
  });

  describe('payload size enforcement (413)', () => {
    it('POST_withOversizedPayload_returns413', async () => {
      const oversized = { ...validPayload, message: 'x'.repeat(6000) };
      const request = createRequest(oversized);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(413);
      expect(body.error).toContain('Payload too large');
    });

    it('POST_withOversizedContentLength_returns413', async () => {
      const request = createRequest(validPayload, { 'Content-Length': '10000' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(413);
      expect(body.error).toContain('Payload too large');
    });
  });

  describe('schema validation (400)', () => {
    it('POST_withMissingName_returns400', async () => {
      const { name: _, ...noName } = validPayload;
      const request = createRequest(noName);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });

    it('POST_withInvalidEmail_returns400', async () => {
      const request = createRequest({ ...validPayload, email: 'not-an-email' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });

    it('POST_withEmptySubject_returns400', async () => {
      const request = createRequest({ ...validPayload, subject: '' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });

    it('POST_withMessageTooShort_returns400', async () => {
      const request = createRequest({ ...validPayload, message: 'Hi' });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Validation failed');
    });

    it('POST_withMessageTooLong_returns400', async () => {
      const request = createRequest({ ...validPayload, message: 'x'.repeat(2001) });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });

    it('POST_withUnexpectedFields_stripsExtras', async () => {
      const request = createRequest({
        ...validPayload,
        extraField: 'should be ignored',
        anotherExtra: 123,
      });
      const response = await POST(request);

      expect(response.status).toBe(201);
    });

    it('POST_withInvalidJSON_returns400', async () => {
      const request = new Request('http://localhost/api/contact', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': '12',
        },
        body: 'not valid json',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid JSON');
    });

    it('POST_withNameTooLong_returns400', async () => {
      const request = createRequest({ ...validPayload, name: 'x'.repeat(101) });
      const response = await POST(request);

      expect(response.status).toBe(400);
    });
  });

  describe('error handling (500)', () => {
    it('POST_whenDatabaseThrows_returns500WithGenericError', async () => {
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockRejectedValue(new Error('DB connection failed')),
      } as never);

      const request = createRequest(validPayload);
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred. Please try again later.');
      expect(body.error).not.toContain('DB connection');
    });

    it('POST_whenDatabaseThrows_logsError', async () => {
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockRejectedValue(new Error('DB connection failed')),
      } as never);

      const request = createRequest(validPayload);
      await POST(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Contact form error',
        expect.objectContaining({ message: 'DB connection failed' })
      );
    });
  });
});
