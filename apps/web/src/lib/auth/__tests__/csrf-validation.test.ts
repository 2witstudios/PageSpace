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
 *   - Cookie: session=<token> (required for session binding)
 *
 * Output:
 *   - null: Validation successful (or skipped for safe methods)
 *   - NextResponse with 403: CSRF_TOKEN_MISSING or CSRF_TOKEN_INVALID
 *   - NextResponse with 401: CSRF_NO_SESSION or CSRF_INVALID_SESSION
 *
 * Session-based CSRF: Tokens are bound to server-validated session IDs,
 * not client-controlled JWT claims.
 */

// Mock dependencies at system boundary
vi.mock('@pagespace/lib/auth', () => ({
  validateCSRFToken: vi.fn(),
  sessionService: {
    validateSession: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
  },
}));

vi.mock('../cookie-config', () => ({
  getSessionFromCookies: vi.fn(),
}));

import { validateCSRFToken, sessionService } from '@pagespace/lib/auth';
import { getSessionFromCookies } from '../cookie-config';

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
    const mockSessionClaims = {
      sessionId: mockSessionId,
      userId: 'user_123',
      userRole: 'user' as const,
      tokenVersion: 0,
      adminRoleVersion: 0,
      type: 'user' as const,
      scopes: ['*'],
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    };

    beforeEach(() => {
      // Setup default mocks for successful validation path
      vi.mocked(getSessionFromCookies).mockReturnValue('ps_sess_valid');
      vi.mocked(sessionService.validateSession).mockResolvedValue(mockSessionClaims);
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

      it('validateCSRF_POSTWithCSRFButNoSession_returns401WithCSRF_NO_SESSION', async () => {
        // Arrange: CSRF token present but no session cookie
        vi.mocked(getSessionFromCookies).mockReturnValue(null);

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

      it('validateCSRF_POSTWithInvalidSession_returns401WithCSRF_INVALID_SESSION', async () => {
        // Arrange: Session validation fails
        vi.mocked(sessionService.validateSession).mockResolvedValue(null);

        const headers = new Headers();
        headers.set('X-CSRF-Token', 'test-csrf-token');
        headers.set('Cookie', 'session=ps_sess_invalid');
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
        headers.set('Cookie', 'session=ps_sess_valid');
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
      it('validateCSRF_POSTWithValidCSRFAndSession_returnsNull', async () => {
        // Arrange
        const headers = new Headers();
        headers.set('X-CSRF-Token', 'valid-csrf-token');
        headers.set('Cookie', 'session=ps_sess_valid');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        // Act
        const result = await validateCSRF(request);

        // Assert: null means validation passed
        expect(result).toBeNull();
      });

      it('validateCSRF_validRequest_usesSessionIdFromServerValidation', async () => {
        // Arrange
        const headers = new Headers();
        headers.set('X-CSRF-Token', 'valid-csrf-token');
        headers.set('Cookie', 'session=ps_sess_valid');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        // Act
        await validateCSRF(request);

        // Assert: Verify the session-based binding flow
        expect(getSessionFromCookies).toHaveBeenCalled();
        expect(sessionService.validateSession).toHaveBeenCalledWith('ps_sess_valid');
        expect(validateCSRFToken).toHaveBeenCalledWith('valid-csrf-token', mockSessionId);
      });
    });

    describe('mutation methods require validation', () => {
      const mutationMethods = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

      mutationMethods.forEach((method) => {
        it(`validateCSRF_${method}WithValidCredentials_validatesSuccessfully`, async () => {
          const headers = new Headers();
          headers.set('X-CSRF-Token', 'valid-csrf-token');
          headers.set('Cookie', 'session=ps_sess_valid');
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
        headers.set('Cookie', 'session=ps_sess_valid');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = await validateCSRF(request);

        expect(result).toBeNull();
        expect(validateCSRFToken).toHaveBeenCalledWith('valid-csrf-token', mockSessionId);
      });

      it('validateCSRF_sessionFromCookies_extractsCorrectly', async () => {
        // Arrange: Custom session token from cookies
        vi.mocked(getSessionFromCookies).mockReturnValue('ps_sess_custom');

        const headers = new Headers();
        headers.set('X-CSRF-Token', 'valid-csrf-token');
        headers.set('Cookie', 'session=ps_sess_custom; other=value');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        // Act
        await validateCSRF(request);

        // Assert: Session service validates the correct token
        expect(sessionService.validateSession).toHaveBeenCalledWith('ps_sess_custom');
      });
    });
  });
});
