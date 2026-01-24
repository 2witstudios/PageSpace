import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { GET } from '../csrf/route';

/**
 * /api/auth/csrf Endpoint Contract Tests
 *
 * This endpoint generates CSRF tokens for authenticated users.
 *
 * Contract:
 *   Request: GET with valid session cookie
 *   Response:
 *     200: { csrfToken: string } - Token bound to session
 *     401: { error: string } - Authentication required or invalid session
 *     500: { error: string } - Internal error during token generation
 *
 * Security Properties:
 *   - Does NOT require CSRF itself (chicken-egg problem)
 *   - Uses session-based authentication (opaque tokens, server-validated)
 *   - Token is bound to session via sessionId
 */

// Mock dependencies at system boundaries
vi.mock('@pagespace/lib/auth', () => ({
  generateCSRFToken: vi.fn().mockReturnValue('generated-csrf-token'),
  sessionService: {
    validateSession: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  getSessionFromCookies: vi.fn(),
}));

import { generateCSRFToken, sessionService } from '@pagespace/lib/auth';
import { getSessionFromCookies } from '@/lib/auth/cookie-config';

describe('/api/auth/csrf', () => {
  const mockSessionClaims = {
    userId: 'test-user-id',
    sessionId: 'test-session-id',
    userRole: 'user' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: valid session
    (getSessionFromCookies as unknown as Mock).mockReturnValue('valid-session-token');
    (sessionService.validateSession as unknown as Mock).mockResolvedValue(mockSessionClaims);
  });

  describe('successful CSRF token generation', () => {
    it('GET_withValidSession_returns200WithCSRFToken', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
        headers: {
          Cookie: 'session=valid-session-token',
        },
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert: Response contains the generated CSRF token
      expect(response.status).toBe(200);
      expect(body).toEqual({ csrfToken: 'generated-csrf-token' });
    });

    it('GET_withValidSession_bindsTokenToSessionId', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
        headers: {
          Cookie: 'session=valid-session-token',
        },
      });

      // Act
      await GET(request);

      // Assert: CSRF token is generated using the session ID
      expect(sessionService.validateSession).toHaveBeenCalledWith('valid-session-token');
      expect(generateCSRFToken).toHaveBeenCalledWith('test-session-id');
    });
  });

  describe('authentication errors (401)', () => {
    it('GET_withNoSessionCookie_returns401', async () => {
      // Arrange: No session cookie
      (getSessionFromCookies as unknown as Mock).mockReturnValue(null);

      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(401);
      expect(body.error).toBe('No session found');
    });

    it('GET_withInvalidSession_returns401', async () => {
      // Arrange: Session validation fails
      (sessionService.validateSession as unknown as Mock).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
        headers: {
          Cookie: 'session=invalid-session-token',
        },
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid or expired session');
    });

    it('GET_withExpiredSession_returns401', async () => {
      // Arrange: Session has expired
      (sessionService.validateSession as unknown as Mock).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
        headers: {
          Cookie: 'session=expired-session-token',
        },
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid or expired session');
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
          Cookie: 'session=valid-session-token',
        },
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert: 500 with generic error (don't leak implementation details)
      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to generate CSRF token');
    });

    it('GET_whenSessionValidationThrows_returns500', async () => {
      // Arrange: Session validation throws an error
      (sessionService.validateSession as unknown as Mock).mockRejectedValue(
        new Error('Database connection failed')
      );

      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
        headers: {
          Cookie: 'session=valid-session-token',
        },
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to generate CSRF token');
    });
  });
});
