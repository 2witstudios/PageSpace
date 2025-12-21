import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateCSRF, requiresCSRFProtection } from '../csrf-validation';

/**
 * CSRF Validation Module Contract Tests
 *
 * This module validates CSRF tokens for API routes. The contract is:
 *
 * Input: HTTP Request with:
 *   - Method (GET/HEAD/OPTIONS skip validation, others require it)
 *   - X-CSRF-Token header (required for mutation methods)
 *   - Cookie: accessToken=<JWT> (required for session binding)
 *
 * Output:
 *   - null: Validation successful (or skipped for safe methods)
 *   - NextResponse with 403: CSRF_TOKEN_MISSING or CSRF_TOKEN_INVALID
 *   - NextResponse with 401: CSRF_NO_SESSION or CSRF_INVALID_SESSION
 *
 * The validation binds CSRF tokens to JWT sessions via:
 *   JWT.claims -> getSessionIdFromJWT() -> sessionId -> validateCSRFToken(token, sessionId)
 */

// Mock dependencies at system boundary
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

import { validateCSRFToken, getSessionIdFromJWT, decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';

describe('csrf-validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('requiresCSRFProtection', () => {
    describe('safe HTTP methods (no CSRF required per HTTP spec)', () => {
      it('requiresCSRFProtection_GET_returnsFalse', () => {
        const request = new Request('https://example.com/api/test', { method: 'GET' });
        expect(requiresCSRFProtection(request)).toBe(false);
      });

      it('requiresCSRFProtection_HEAD_returnsFalse', () => {
        const request = new Request('https://example.com/api/test', { method: 'HEAD' });
        expect(requiresCSRFProtection(request)).toBe(false);
      });

      it('requiresCSRFProtection_OPTIONS_returnsFalse', () => {
        const request = new Request('https://example.com/api/test', { method: 'OPTIONS' });
        expect(requiresCSRFProtection(request)).toBe(false);
      });
    });

    describe('mutation HTTP methods (CSRF required)', () => {
      it('requiresCSRFProtection_POST_returnsTrue', () => {
        const request = new Request('https://example.com/api/test', { method: 'POST' });
        expect(requiresCSRFProtection(request)).toBe(true);
      });

      it('requiresCSRFProtection_PUT_returnsTrue', () => {
        const request = new Request('https://example.com/api/test', { method: 'PUT' });
        expect(requiresCSRFProtection(request)).toBe(true);
      });

      it('requiresCSRFProtection_PATCH_returnsTrue', () => {
        const request = new Request('https://example.com/api/test', { method: 'PATCH' });
        expect(requiresCSRFProtection(request)).toBe(true);
      });

      it('requiresCSRFProtection_DELETE_returnsTrue', () => {
        const request = new Request('https://example.com/api/test', { method: 'DELETE' });
        expect(requiresCSRFProtection(request)).toBe(true);
      });
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
      // Setup default mocks for successful validation path
      vi.mocked(parse).mockReturnValue({ accessToken: 'mock-jwt-token' });
      vi.mocked(decodeToken).mockResolvedValue(mockJwtPayload);
      vi.mocked(getSessionIdFromJWT).mockReturnValue(mockSessionId);
      vi.mocked(validateCSRFToken).mockReturnValue(true);
    });

    describe('safe method bypass', () => {
      it('validateCSRF_GETRequest_returnsNullAndSkipsValidation', async () => {
        const request = new Request('https://example.com/api/test', { method: 'GET' });
        const result = await validateCSRF(request);

        expect(result).toBeNull();
        // Contract: safe methods should not invoke token validation
        expect(validateCSRFToken).not.toHaveBeenCalled();
      });

      it('validateCSRF_HEADRequest_returnsNullAndSkipsValidation', async () => {
        const request = new Request('https://example.com/api/test', { method: 'HEAD' });
        const result = await validateCSRF(request);

        expect(result).toBeNull();
        expect(validateCSRFToken).not.toHaveBeenCalled();
      });

      it('validateCSRF_OPTIONSRequest_returnsNullAndSkipsValidation', async () => {
        const request = new Request('https://example.com/api/test', { method: 'OPTIONS' });
        const result = await validateCSRF(request);

        expect(result).toBeNull();
        expect(validateCSRFToken).not.toHaveBeenCalled();
      });
    });

    describe('error responses with consistent error shape', () => {
      it('validateCSRF_POSTWithoutCSRFHeader_returns403WithCSRF_TOKEN_MISSING', async () => {
        // Arrange: POST request without X-CSRF-Token header
        const request = new Request('https://example.com/api/test', { method: 'POST' });

        // Act
        const result = await validateCSRF(request);

        // Assert: 403 with structured error response
        expect(result).not.toBeNull();
        expect(result?.status).toBe(403);
        const body = await result?.json();
        expect(body).toMatchObject({
          error: 'CSRF token required',
          code: 'CSRF_TOKEN_MISSING',
          details: expect.stringContaining('X-CSRF-Token'),
        });
      });

      it('validateCSRF_POSTWithCSRFButNoCookie_returns401WithCSRF_NO_SESSION', async () => {
        // Arrange: CSRF token present but no session cookie
        vi.mocked(parse).mockReturnValue({});

        const headers = new Headers();
        headers.set('X-CSRF-Token', 'test-csrf-token');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        // Act
        const result = await validateCSRF(request);

        // Assert: 401 because session is required for CSRF validation
        expect(result).not.toBeNull();
        expect(result?.status).toBe(401);
        const body = await result?.json();
        expect(body.code).toBe('CSRF_NO_SESSION');
      });

      it('validateCSRF_POSTWithInvalidJWT_returns401WithCSRF_INVALID_SESSION', async () => {
        // Arrange: JWT decoding fails
        vi.mocked(decodeToken).mockResolvedValue(null);

        const headers = new Headers();
        headers.set('X-CSRF-Token', 'test-csrf-token');
        headers.set('Cookie', 'accessToken=invalid-token');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        // Act
        const result = await validateCSRF(request);

        // Assert
        expect(result).not.toBeNull();
        expect(result?.status).toBe(401);
        const body = await result?.json();
        expect(body.code).toBe('CSRF_INVALID_SESSION');
      });

      it('validateCSRF_POSTWithInvalidCSRFToken_returns403WithCSRF_TOKEN_INVALID', async () => {
        // Arrange: Token validation fails
        vi.mocked(validateCSRFToken).mockReturnValue(false);

        const headers = new Headers();
        headers.set('X-CSRF-Token', 'invalid-csrf-token');
        headers.set('Cookie', 'accessToken=valid-jwt-token');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        // Act
        const result = await validateCSRF(request);

        // Assert
        expect(result).not.toBeNull();
        expect(result?.status).toBe(403);
        const body = await result?.json();
        expect(body).toMatchObject({
          error: 'Invalid or expired CSRF token',
          code: 'CSRF_TOKEN_INVALID',
          details: expect.any(String),
        });
      });
    });

    describe('successful validation', () => {
      it('validateCSRF_POSTWithValidCSRFAndJWT_returnsNull', async () => {
        // Arrange
        const headers = new Headers();
        headers.set('X-CSRF-Token', 'valid-csrf-token');
        headers.set('Cookie', 'accessToken=valid-jwt-token');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        // Act
        const result = await validateCSRF(request);

        // Assert: null means validation passed
        expect(result).toBeNull();
      });

      it('validateCSRF_validRequest_extractsSessionIdFromJWTClaims', async () => {
        // Arrange
        const headers = new Headers();
        headers.set('X-CSRF-Token', 'valid-csrf-token');
        headers.set('Cookie', 'accessToken=valid-jwt-token');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        // Act
        await validateCSRF(request);

        // Assert: Verify the session binding flow
        expect(decodeToken).toHaveBeenCalledWith('mock-jwt-token');
        expect(getSessionIdFromJWT).toHaveBeenCalledWith(mockJwtPayload);
        expect(validateCSRFToken).toHaveBeenCalledWith('valid-csrf-token', mockSessionId);
      });
    });

    describe('mutation methods require validation', () => {
      const mutationMethods = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

      mutationMethods.forEach((method) => {
        it(`validateCSRF_${method}WithValidCredentials_validatesSuccessfully`, async () => {
          const headers = new Headers();
          headers.set('X-CSRF-Token', 'valid-csrf-token');
          headers.set('Cookie', 'accessToken=valid-jwt-token');
          const request = new Request('https://example.com/api/test', {
            method,
            headers,
          });

          const result = await validateCSRF(request);

          expect(result).toBeNull();
          expect(validateCSRFToken).toHaveBeenCalled();
        });
      });
    });

    describe('header extraction', () => {
      it('validateCSRF_lowercaseCSRFHeader_extractsTokenCorrectly', async () => {
        // Contract: HTTP headers are case-insensitive
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

      it('validateCSRF_multipleCookies_extractsAccessTokenCorrectly', async () => {
        // Arrange: Multiple cookies in the header
        vi.mocked(parse).mockReturnValue({ accessToken: 'custom-token' });

        const headers = new Headers();
        headers.set('X-CSRF-Token', 'valid-csrf-token');
        headers.set('Cookie', 'accessToken=custom-token; other=value; session=abc');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        // Act
        await validateCSRF(request);

        // Assert: Cookie parser receives full cookie string
        expect(parse).toHaveBeenCalledWith('accessToken=custom-token; other=value; session=abc');
        // Assert: Correct token is used for decoding
        expect(decodeToken).toHaveBeenCalledWith('custom-token');
      });
    });
  });
});
