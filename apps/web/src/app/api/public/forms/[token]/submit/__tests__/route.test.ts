import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * /api/public/forms/[token]/submit Endpoint Contract Tests
 *
 * Public, unauthenticated form-submission endpoint. Every accepted request is
 * independently gated: size cap -> rate limit (IP + token prefix) -> token
 * lookup (the ONLY authorization decision) -> honeypot -> schema validation
 * -> row append. Unknown and paused tokens must be indistinguishable (404).
 */

const mockCheckDistributedRateLimit = vi.hoisted(() => vi.fn());
const mockLookupActiveFormTarget = vi.hoisted(() => vi.fn());
const mockAppendFormSubmission = vi.hoisted(() => vi.fn());
const mockGetClientIP = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: mockCheckDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS: {
    FORM_SUBMISSION: { maxAttempts: 10, windowMs: 60000 },
  },
}));

vi.mock('@/services/api/form-target-service', () => ({
  lookupActiveFormTarget: mockLookupActiveFormTarget,
  appendFormSubmission: mockAppendFormSubmission,
}));

vi.mock('@/lib/auth/auth-helpers', () => ({
  getClientIP: mockGetClientIP,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

import { POST, OPTIONS } from '../route';

const fields = [
  { name: 'name', label: 'Name', type: 'text' as const, required: true },
  { name: 'email', label: 'Email', type: 'email' as const, required: true },
];

const activeFormTarget = { id: 'ft-1', fields };

const createRequest = (body: object, headers?: Record<string, string>) => {
  const bodyStr = JSON.stringify(body);
  return new Request('http://localhost/api/public/forms/pft_realtoken/submit', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(bodyStr)),
      ...headers,
    },
    body: bodyStr,
  });
};

const params = () => ({ params: Promise.resolve({ token: 'pft_realtoken' }) });

describe('POST /api/public/forms/[token]/submit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetClientIP.mockReturnValue('127.0.0.1');
    mockCheckDistributedRateLimit.mockResolvedValue({ allowed: true });
    mockLookupActiveFormTarget.mockResolvedValue(activeFormTarget);
    mockAppendFormSubmission.mockResolvedValue(undefined);
  });

  describe('successful submission', () => {
    it('appends the row and returns 200 for a valid submission', async () => {
      const request = createRequest({ name: 'Ada Lovelace', email: 'ada@example.com' });
      const response = await POST(request, params());

      expect(response.status).toBe(200);
      expect(mockAppendFormSubmission).toHaveBeenCalledWith(
        expect.objectContaining({
          formTargetId: 'ft-1',
          values: { name: 'Ada Lovelace', email: 'ada@example.com' },
        })
      );
    });
  });

  describe('token authorization (404 — no distinguishable signal)', () => {
    it('returns 404 for an unknown token', async () => {
      mockLookupActiveFormTarget.mockResolvedValue(null);

      const request = createRequest({ name: 'Ada', email: 'ada@example.com' });
      const response = await POST(request, params());

      expect(response.status).toBe(404);
      expect(mockAppendFormSubmission).not.toHaveBeenCalled();
    });

    it('returns the identical 404 for a paused token as for an unknown one', async () => {
      // lookupActiveFormTarget already collapses paused/archived to null —
      // this test locks that contract in at the route level too.
      mockLookupActiveFormTarget.mockResolvedValue(null);

      const request = createRequest({ name: 'Ada', email: 'ada@example.com' });
      const unknownResponse = await POST(request, params());
      const unknownBody = await unknownResponse.json();

      mockLookupActiveFormTarget.mockResolvedValue(null);
      const pausedRequest = createRequest({ name: 'Ada', email: 'ada@example.com' });
      const pausedResponse = await POST(pausedRequest, params());
      const pausedBody = await pausedResponse.json();

      expect(pausedResponse.status).toBe(unknownResponse.status);
      expect(pausedBody).toEqual(unknownBody);
    });
  });

  describe('honeypot (silent drop)', () => {
    it('returns 200 success but does not append when the honeypot field is filled', async () => {
      const request = createRequest({ name: 'Bot', email: 'bot@example.com', _hp: 'i am a bot' });
      const response = await POST(request, params());

      expect(response.status).toBe(200);
      expect(mockAppendFormSubmission).not.toHaveBeenCalled();
    });
  });

  describe('rate limiting (429)', () => {
    it('returns 429 when the per-IP limit is exceeded', async () => {
      mockCheckDistributedRateLimit.mockResolvedValue({ allowed: false, retryAfter: 30 });

      const request = createRequest({ name: 'Ada', email: 'ada@example.com' });
      const response = await POST(request, params());

      expect(response.status).toBe(429);
      expect(mockLookupActiveFormTarget).not.toHaveBeenCalled();
    });

    it('checks a secondary rate-limit key derived from the token prefix', async () => {
      const request = createRequest({ name: 'Ada', email: 'ada@example.com' });
      await POST(request, params());

      const keys = mockCheckDistributedRateLimit.mock.calls.map((call) => call[0] as string);
      expect(keys.some((key) => key.startsWith('form:ip:'))).toBe(true);
      expect(keys.some((key) => key.startsWith('form:token:'))).toBe(true);
    });
  });

  describe('payload size enforcement (413)', () => {
    it('returns 413 for an oversized declared Content-Length', async () => {
      const request = createRequest({ name: 'Ada', email: 'ada@example.com' }, { 'Content-Length': '100000' });
      const response = await POST(request, params());

      expect(response.status).toBe(413);
      expect(mockCheckDistributedRateLimit).not.toHaveBeenCalled();
    });

    it('returns 413 for an oversized body even when Content-Length is absent (e.g. chunked encoding)', async () => {
      const oversized = 'x'.repeat(8 * 1024 + 1); // exceeds the route's 8KB cap
      const request = new Request('http://localhost/api/public/forms/pft_realtoken/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: oversized,
      });

      const response = await POST(request, params());

      expect(response.status).toBe(413);
      expect(mockCheckDistributedRateLimit).not.toHaveBeenCalled();
    });
  });

  describe('schema validation (400)', () => {
    it('returns 400 when a required field is missing', async () => {
      const request = createRequest({ name: 'Ada' });
      const response = await POST(request, params());

      expect(response.status).toBe(400);
      expect(mockAppendFormSubmission).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid JSON body', async () => {
      const request = new Request('http://localhost/api/public/forms/pft_realtoken/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '12' },
        body: 'not valid json',
      });
      const response = await POST(request, params());

      expect(response.status).toBe(400);
    });
  });

  describe('error handling (500)', () => {
    it('returns 500 with a generic message when the append fails', async () => {
      mockAppendFormSubmission.mockRejectedValue(new Error('DB connection failed'));

      const request = createRequest({ name: 'Ada', email: 'ada@example.com' });
      const response = await POST(request, params());
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).not.toContain('DB connection');
    });
  });

  describe('CORS (submitting page is on a different origin by design)', () => {
    it('answers the preflight OPTIONS request with matching CORS headers', () => {
      const response = OPTIONS();

      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
      expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
    });

    it('sets Access-Control-Allow-Origin on a successful POST response', async () => {
      const request = createRequest({ name: 'Ada Lovelace', email: 'ada@example.com' });
      const response = await POST(request, params());

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('sets Access-Control-Allow-Origin on an error POST response too (e.g. 404)', async () => {
      mockLookupActiveFormTarget.mockResolvedValue(null);

      const request = createRequest({ name: 'Ada', email: 'ada@example.com' });
      const response = await POST(request, params());

      expect(response.status).toBe(404);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });
});
