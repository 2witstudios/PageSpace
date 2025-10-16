import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateCSRF, requiresCSRFProtection } from '../csrf-validation';

// Mock dependencies
vi.mock('@pagespace/lib/server', () => ({
  validateCSRFToken: vi.fn(),
  getSessionIdFromJWT: vi.fn(),
  decodeToken: vi.fn(),
  loggers: {
    auth: {
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
  },
}));

vi.mock('cookie', () => ({
  parse: vi.fn(),
}));

import { validateCSRFToken, getSessionIdFromJWT, decodeToken, loggers } from '@pagespace/lib/server';
import { parse } from 'cookie';

describe('csrf-validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('requiresCSRFProtection', () => {
    it('returns false for GET requests', () => {
      const request = new Request('https://example.com/api/test', { method: 'GET' });
      expect(requiresCSRFProtection(request)).toBe(false);
    });

    it('returns false for HEAD requests', () => {
      const request = new Request('https://example.com/api/test', { method: 'HEAD' });
      expect(requiresCSRFProtection(request)).toBe(false);
    });

    it('returns false for OPTIONS requests', () => {
      const request = new Request('https://example.com/api/test', { method: 'OPTIONS' });
      expect(requiresCSRFProtection(request)).toBe(false);
    });

    it('returns true for POST requests', () => {
      const request = new Request('https://example.com/api/test', { method: 'POST' });
      expect(requiresCSRFProtection(request)).toBe(true);
    });

    it('returns true for PUT requests', () => {
      const request = new Request('https://example.com/api/test', { method: 'PUT' });
      expect(requiresCSRFProtection(request)).toBe(true);
    });

    it('returns true for PATCH requests', () => {
      const request = new Request('https://example.com/api/test', { method: 'PATCH' });
      expect(requiresCSRFProtection(request)).toBe(true);
    });

    it('returns true for DELETE requests', () => {
      const request = new Request('https://example.com/api/test', { method: 'DELETE' });
      expect(requiresCSRFProtection(request)).toBe(true);
    });
  });

  describe('validateCSRF', () => {
    const mockSessionId = 'session_abc123';
    const mockUserId = 'user_123';
    const mockJwtPayload = {
      userId: mockUserId,
      tokenVersion: 0,
      role: 'user' as const,
      iat: Math.floor(Date.now() / 1000),
    };

    beforeEach(() => {
      // Setup default mocks
      vi.mocked(parse).mockReturnValue({ accessToken: 'mock-jwt-token' });
      vi.mocked(decodeToken).mockResolvedValue(mockJwtPayload);
      vi.mocked(getSessionIdFromJWT).mockReturnValue(mockSessionId);
      vi.mocked(validateCSRFToken).mockReturnValue(true);
    });

    it('skips validation for safe methods (GET)', async () => {
      const request = new Request('https://example.com/api/test', { method: 'GET' });
      const result = await validateCSRF(request);

      expect(result).toBeNull();
      expect(validateCSRFToken).not.toHaveBeenCalled();
    });

    it('skips validation for HEAD requests', async () => {
      const request = new Request('https://example.com/api/test', { method: 'HEAD' });
      const result = await validateCSRF(request);

      expect(result).toBeNull();
      expect(validateCSRFToken).not.toHaveBeenCalled();
    });

    it('skips validation for OPTIONS requests', async () => {
      const request = new Request('https://example.com/api/test', { method: 'OPTIONS' });
      const result = await validateCSRF(request);

      expect(result).toBeNull();
      expect(validateCSRFToken).not.toHaveBeenCalled();
    });

    it('returns error when CSRF token is missing from POST request', async () => {
      const request = new Request('https://example.com/api/test', { method: 'POST' });
      const result = await validateCSRF(request);

      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
      const body = await result?.json();
      expect(body.code).toBe('CSRF_TOKEN_MISSING');
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'CSRF token missing from request',
        expect.any(Object)
      );
    });

    it('returns error when access token cookie is missing', async () => {
      vi.mocked(parse).mockReturnValue({});

      const headers = new Headers();
      headers.set('X-CSRF-Token', 'test-csrf-token');
      const request = new Request('https://example.com/api/test', {
        method: 'POST',
        headers,
      });

      const result = await validateCSRF(request);

      expect(result).not.toBeNull();
      expect(result?.status).toBe(401);
      const body = await result?.json();
      expect(body.code).toBe('CSRF_NO_SESSION');
    });

    it('returns error when JWT is invalid', async () => {
      vi.mocked(decodeToken).mockResolvedValue(null);

      const headers = new Headers();
      headers.set('X-CSRF-Token', 'test-csrf-token');
      headers.set('Cookie', 'accessToken=invalid-token');
      const request = new Request('https://example.com/api/test', {
        method: 'POST',
        headers,
      });

      const result = await validateCSRF(request);

      expect(result).not.toBeNull();
      expect(result?.status).toBe(401);
      const body = await result?.json();
      expect(body.code).toBe('CSRF_INVALID_SESSION');
    });

    it('returns error when CSRF token is invalid', async () => {
      vi.mocked(validateCSRFToken).mockReturnValue(false);

      const headers = new Headers();
      headers.set('X-CSRF-Token', 'invalid-csrf-token');
      headers.set('Cookie', 'accessToken=valid-jwt-token');
      const request = new Request('https://example.com/api/test', {
        method: 'POST',
        headers,
      });

      const result = await validateCSRF(request);

      expect(result).not.toBeNull();
      expect(result?.status).toBe(403);
      const body = await result?.json();
      expect(body.code).toBe('CSRF_TOKEN_INVALID');
    });

    it('validates successfully with valid CSRF token and JWT', async () => {
      const headers = new Headers();
      headers.set('X-CSRF-Token', 'valid-csrf-token');
      headers.set('Cookie', 'accessToken=valid-jwt-token');
      const request = new Request('https://example.com/api/test', {
        method: 'POST',
        headers,
      });

      const result = await validateCSRF(request);

      expect(result).toBeNull();
      expect(decodeToken).toHaveBeenCalledWith('mock-jwt-token');
      expect(getSessionIdFromJWT).toHaveBeenCalledWith(mockJwtPayload);
      expect(validateCSRFToken).toHaveBeenCalledWith('valid-csrf-token', mockSessionId);
      expect(loggers.auth.debug).toHaveBeenCalledWith(
        'CSRF token validated successfully',
        expect.objectContaining({
          method: 'POST',
          userId: mockUserId,
        })
      );
    });

    it('validates PATCH requests', async () => {
      const headers = new Headers();
      headers.set('X-CSRF-Token', 'valid-csrf-token');
      headers.set('Cookie', 'accessToken=valid-jwt-token');
      const request = new Request('https://example.com/api/test', {
        method: 'PATCH',
        headers,
      });

      const result = await validateCSRF(request);

      expect(result).toBeNull();
      expect(validateCSRFToken).toHaveBeenCalled();
    });

    it('validates PUT requests', async () => {
      const headers = new Headers();
      headers.set('X-CSRF-Token', 'valid-csrf-token');
      headers.set('Cookie', 'accessToken=valid-jwt-token');
      const request = new Request('https://example.com/api/test', {
        method: 'PUT',
        headers,
      });

      const result = await validateCSRF(request);

      expect(result).toBeNull();
      expect(validateCSRFToken).toHaveBeenCalled();
    });

    it('validates DELETE requests', async () => {
      const headers = new Headers();
      headers.set('X-CSRF-Token', 'valid-csrf-token');
      headers.set('Cookie', 'accessToken=valid-jwt-token');
      const request = new Request('https://example.com/api/test', {
        method: 'DELETE',
        headers,
      });

      const result = await validateCSRF(request);

      expect(result).toBeNull();
      expect(validateCSRFToken).toHaveBeenCalled();
    });

    it('extracts CSRF token from lowercase header', async () => {
      const headers = new Headers();
      headers.set('x-csrf-token', 'valid-csrf-token'); // lowercase
      headers.set('Cookie', 'accessToken=valid-jwt-token');
      const request = new Request('https://example.com/api/test', {
        method: 'POST',
        headers,
      });

      const result = await validateCSRF(request);

      expect(result).toBeNull();
      expect(validateCSRFToken).toHaveBeenCalledWith('valid-csrf-token', mockSessionId);
    });

    it('handles cookie parsing correctly', async () => {
      vi.mocked(parse).mockReturnValue({ accessToken: 'custom-token' });

      const headers = new Headers();
      headers.set('X-CSRF-Token', 'valid-csrf-token');
      headers.set('Cookie', 'accessToken=custom-token; other=value');
      const request = new Request('https://example.com/api/test', {
        method: 'POST',
        headers,
      });

      await validateCSRF(request);

      expect(parse).toHaveBeenCalledWith('accessToken=custom-token; other=value');
      expect(decodeToken).toHaveBeenCalledWith('custom-token');
    });

    it('provides helpful error messages', async () => {
      const request = new Request('https://example.com/api/test', { method: 'POST' });
      const result = await validateCSRF(request);

      const body = await result?.json();
      expect(body.error).toBe('CSRF token required');
      expect(body.details).toContain('X-CSRF-Token header');
    });

    it('logs validation failures with context', async () => {
      vi.mocked(validateCSRFToken).mockReturnValue(false);

      const headers = new Headers();
      headers.set('X-CSRF-Token', 'invalid-token');
      headers.set('Cookie', 'accessToken=valid-jwt-token');
      const request = new Request('https://example.com/api/pages/123', {
        method: 'DELETE',
        headers,
      });

      await validateCSRF(request);

      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'CSRF token validation failed',
        expect.objectContaining({
          method: 'DELETE',
          userId: mockUserId,
        })
      );
    });
  });
});
