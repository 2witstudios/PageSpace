/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';

// ============================================================================
// Contract Tests for /api/internal/contact
//
// Tests internal contact form submission endpoint with token-based auth.
// ============================================================================

const { mockInsertValues, mockInsert } = vi.hoisted(() => {
  const mockInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });
  return { mockInsertValues, mockInsert };
});

vi.mock('@pagespace/db', () => ({
  db: {
    insert: mockInsert,
  },
  contactSubmissions: 'contactSubmissions',
}));

vi.mock('@pagespace/lib', () => ({
  secureCompare: vi.fn(),
}));

import { POST } from '../route';
import { secureCompare } from '@pagespace/lib';

// ============================================================================
// Helpers
// ============================================================================

const VALID_BODY = {
  name: 'John Doe',
  email: 'john@example.com',
  subject: 'Test Subject',
  message: 'This is a test message that is at least 10 characters long.',
};

const makeRequest = (body: any, token?: string) => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return new Request('http://localhost/api/internal/contact', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
};

// ============================================================================
// POST /api/internal/contact - Contract Tests
// ============================================================================

describe('POST /api/internal/contact', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, INTERNAL_API_SECRET: 'test-secret' };
    vi.mocked(secureCompare).mockReturnValue(true);
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockInsertValues.mockResolvedValue(undefined);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('configuration', () => {
    it('should return 503 when INTERNAL_API_SECRET is not configured', async () => {
      delete process.env.INTERNAL_API_SECRET;

      const request = makeRequest(VALID_BODY, 'any-token');
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body.error).toBe('Internal API not configured');
    });
  });

  describe('authentication', () => {
    it('should return 401 when no authorization header is provided', async () => {
      const request = new Request('http://localhost/api/internal/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_BODY),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 401 when token does not match', async () => {
      vi.mocked(secureCompare).mockReturnValue(false);

      const request = makeRequest(VALID_BODY, 'wrong-token');
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 401 when authorization header is not Bearer format', async () => {
      const request = new Request('http://localhost/api/internal/contact', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic dXNlcjpwYXNz',
        },
        body: JSON.stringify(VALID_BODY),
      });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should return 400 for invalid JSON', async () => {
      const request = new Request('http://localhost/api/internal/contact', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-secret',
        },
        body: 'not-json',
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid JSON payload');
    });

    it('should return 400 when name is missing', async () => {
      const request = makeRequest({ ...VALID_BODY, name: undefined }, 'test-secret');
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('name');
    });

    it('should return 400 when name exceeds 100 characters', async () => {
      const request = makeRequest({ ...VALID_BODY, name: 'a'.repeat(101) }, 'test-secret');
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('name');
    });

    it('should return 400 when email is invalid', async () => {
      const request = makeRequest({ ...VALID_BODY, email: 'not-an-email' }, 'test-secret');
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('email');
    });

    it('should return 400 when subject is missing', async () => {
      const request = makeRequest({ ...VALID_BODY, subject: '' }, 'test-secret');
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('subject');
    });

    it('should return 400 when subject exceeds 200 characters', async () => {
      const request = makeRequest({ ...VALID_BODY, subject: 'a'.repeat(201) }, 'test-secret');
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('subject');
    });

    it('should return 400 when message is too short', async () => {
      const request = makeRequest({ ...VALID_BODY, message: 'short' }, 'test-secret');
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Message');
    });

    it('should return 400 when message exceeds 2000 characters', async () => {
      const request = makeRequest({ ...VALID_BODY, message: 'a'.repeat(2001) }, 'test-secret');
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Message');
    });
  });

  describe('success', () => {
    it('should insert contact submission and return 201', async () => {
      const request = makeRequest(VALID_BODY, 'test-secret');
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.success).toBe(true);
    });

    it('should trim input values before insertion', async () => {
      // Note: email validation checks regex before trimming, so it cannot have spaces
      const request = makeRequest(
        {
          name: '  John Doe  ',
          email: 'john@example.com',
          subject: '  Test Subject  ',
          message: '  This is a test message that is long enough.  ',
        },
        'test-secret'
      );
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.success).toBe(true);
      // Verify insert was called with trimmed values
      expect(mockInsert).toHaveBeenCalled();
      const valuesCall = mockInsertValues.mock.calls[0]?.[0];
      expect(valuesCall).toEqual({
        name: 'John Doe',
        email: 'john@example.com',
        subject: 'Test Subject',
        message: 'This is a test message that is long enough.',
      });
    });
  });

  describe('error handling', () => {
    it('should return 500 when database insert fails', async () => {
      mockInsertValues.mockRejectedValue(new Error('Insert failed'));

      const request = makeRequest(VALID_BODY, 'test-secret');
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to save contact submission');
    });
  });
});
