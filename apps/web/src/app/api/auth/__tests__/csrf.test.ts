import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { GET } from '../csrf/route';

/**
 * /api/auth/csrf Endpoint Contract Tests
 *
 * This endpoint generates CSRF tokens for authenticated users.
 *
 * Contract:
 *   Request: GET with valid JWT (via Cookie or Bearer token)
 *   Response:
 *     200: { csrfToken: string } - Token bound to JWT session
 *     401: { error: string } - Authentication required or invalid JWT
 *     500: { error: string } - Internal error during token generation
 *
 * Security Properties:
 *   - Does NOT require CSRF itself (chicken-egg problem)
 *   - Only accepts JWT authentication (no MCP tokens)
 *   - Token is bound to session via: JWT claims -> sessionId -> HMAC signature
 */

// Mock dependencies at system boundaries
vi.mock('cookie', () => ({
  parse: vi.fn().mockReturnValue({ accessToken: 'valid-access-token' }),
}));

vi.mock('@pagespace/lib/server', () => ({
  generateCSRFToken: vi.fn().mockReturnValue('generated-csrf-token'),
  getSessionIdFromJWT: vi.fn().mockReturnValue('session-id-123'),
  decodeToken: vi.fn(),
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { parse } from 'cookie';
import { generateCSRFToken, getSessionIdFromJWT, decodeToken } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

describe('/api/auth/csrf', () => {
  const mockDecodedToken = {
    userId: 'test-user-id',
    tokenVersion: 0,
    role: 'user' as const,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900, // 15 minutes
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user via cookie
    (authenticateRequestWithOptions as unknown as Mock).mockResolvedValue({
      userId: 'test-user-id',
      role: 'user',
      tokenVersion: 0,
      tokenType: 'jwt',
      source: 'cookie',
    });
    (isAuthError as unknown as Mock).mockReturnValue(false);
    (decodeToken as unknown as Mock).mockResolvedValue(mockDecodedToken);
    (parse as unknown as Mock).mockReturnValue({ accessToken: 'valid-access-token' });
  });

  describe('successful CSRF token generation', () => {
    it('GET_withValidCookieAuth_returns200WithCSRFToken', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=valid-access-token',
        },
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert: Response contains the generated CSRF token
      expect(response.status).toBe(200);
      expect(body).toEqual({ csrfToken: 'generated-csrf-token' });
    });

    it('GET_withValidAuth_bindsTokenToSessionViaJWTClaims', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=valid-access-token',
        },
      });

      // Act
      await GET(request);

      // Assert: Session binding flow - JWT claims -> sessionId -> token generation
      expect(getSessionIdFromJWT).toHaveBeenCalledWith({
        userId: 'test-user-id',
        tokenVersion: 0,
        iat: mockDecodedToken.iat,
      });
      expect(generateCSRFToken).toHaveBeenCalledWith('session-id-123');
    });

    it('GET_withBearerToken_extractsTokenFromAuthorizationHeader', async () => {
      // Arrange: Configure for Bearer token authentication
      vi.clearAllMocks();
      (authenticateRequestWithOptions as unknown as Mock).mockResolvedValue({
        userId: 'test-user-id',
        role: 'user',
        tokenVersion: 0,
        tokenType: 'jwt',
        source: 'bearer',
      });
      (isAuthError as unknown as Mock).mockReturnValue(false);
      (decodeToken as unknown as Mock).mockResolvedValue(mockDecodedToken);

      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer valid-access-token',
        },
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert: Response is successful
      expect(response.status).toBe(200);
      expect(body.csrfToken).toBe('generated-csrf-token');

      // Assert: Bearer token takes precedence over cookies
      expect(decodeToken).toHaveBeenCalledWith('valid-access-token');
      expect(parse).not.toHaveBeenCalled();
    });

    it('GET_withCookieAuth_extractsTokenFromAccessTokenCookie', async () => {
      // Arrange
      (parse as unknown as Mock).mockReturnValue({ accessToken: 'cookie-access-token' });

      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=cookie-access-token',
        },
      });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(200);
    });
  });

  describe('authentication errors (401)', () => {
    it('GET_withNoAuth_returns401', async () => {
      // Arrange: Authentication middleware returns error
      const mockError = { error: Response.json({ error: 'Authentication required' }, { status: 401 }) };
      (authenticateRequestWithOptions as unknown as Mock).mockResolvedValue(mockError);
      (isAuthError as unknown as Mock).mockReturnValue(true);

      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
      });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(401);
    });

    it('GET_withoutAccessTokenCookie_returns401', async () => {
      // Arrange: No accessToken in cookies
      (parse as Mock).mockReturnValue({});

      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(401);
      expect(body.error).toBe('No JWT token found');
    });

    it('GET_withJWTMissingIatClaim_returns401', async () => {
      // REVIEW: iat (issued at) is required for session binding.
      // This ensures tokens from different sessions are distinguishable.
      (decodeToken as unknown as Mock).mockResolvedValue({
        userId: 'test-user-id',
        tokenVersion: 0,
        role: 'user',
        // iat intentionally missing
      });

      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=valid-access-token',
        },
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid JWT token');
    });

    it('GET_withInvalidJWT_returns401', async () => {
      // Arrange: JWT decoding fails
      (decodeToken as Mock).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=invalid-token',
        },
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid JWT token');
    });
  });

  describe('security configuration', () => {
    it('GET_csrfEndpoint_doesNotRequireCSRF', async () => {
      // This is the chicken-egg problem: you can't require CSRF to get a CSRF token
      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=valid-access-token',
        },
      });

      // Act
      await GET(request);

      // Assert: requireCSRF must be false
      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          requireCSRF: false,
        })
      );
    });

    it('GET_csrfEndpoint_onlyAllowsJWTAuth', async () => {
      // MCP tokens should not be able to generate CSRF tokens
      // (CSRF is for browser-based web sessions only)
      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=valid-access-token',
        },
      });

      // Act
      await GET(request);

      // Assert: Only JWT auth allowed, not MCP
      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          allow: ['jwt'],
        })
      );
    });
  });

  describe('error handling (500)', () => {
    it('GET_whenTokenGenerationThrows_returns500WithGenericError', async () => {
      // Arrange: Token generation throws an error
      (generateCSRFToken as unknown as Mock).mockImplementation(() => {
        throw new Error('CSRF_SECRET not configured');
      });

      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=valid-access-token',
        },
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert: 500 with generic error (don't leak implementation details)
      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to generate CSRF token');
    });
  });
});
