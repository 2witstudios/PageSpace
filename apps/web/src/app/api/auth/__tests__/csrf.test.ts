import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { GET } from '../csrf/route';

// Mock dependencies
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
import {
  generateCSRFToken,
  getSessionIdFromJWT,
  decodeToken,
  loggers,
} from '@pagespace/lib/server';
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

    // Default: authenticated user
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
    it('returns 200 with CSRF token', async () => {
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

      // Assert
      expect(response.status).toBe(200);
      expect(body.csrfToken).toBe('generated-csrf-token');
    });

    it('generates CSRF token using session ID from JWT', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=valid-access-token',
        },
      });

      // Act
      await GET(request);

      // Assert
      expect(getSessionIdFromJWT).toHaveBeenCalledWith({
        userId: 'test-user-id',
        tokenVersion: 0,
        iat: mockDecodedToken.iat,
      });
      expect(generateCSRFToken).toHaveBeenCalledWith('session-id-123');
    });

    it('supports Bearer token authentication', async () => {
      // Arrange - reset mocks first to ensure isolation
      vi.clearAllMocks();

      // Configure authenticateRequestWithOptions to indicate Bearer auth was used
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

      // Assert - verify response
      expect(response.status).toBe(200);
      expect(body.csrfToken).toBe('generated-csrf-token');

      // Assert - verify Bearer token was decoded (not cookie token)
      expect(decodeToken).toHaveBeenCalledWith('valid-access-token');
      expect(decodeToken).toHaveBeenCalledTimes(1);

      // Assert - verify cookie parsing was NOT invoked since Bearer token takes precedence
      expect(parse).not.toHaveBeenCalled();

      // Assert - verify auth was called with correct options
      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          allow: ['jwt'],
          requireCSRF: false,
        })
      );
    });

    it('supports cookie-based authentication', async () => {
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

  describe('authentication errors', () => {
    it('returns 401 when not authenticated', async () => {
      // Arrange
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

    it('returns 401 when JWT token is not found', async () => {
      // Arrange
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

    it('returns 401 when JWT is invalid (missing iat)', async () => {
      // Arrange
      (decodeToken as unknown as Mock).mockResolvedValue({
        userId: 'test-user-id',
        tokenVersion: 0,
        role: 'user',
        // missing iat
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

    it('returns 401 when decodeToken returns null', async () => {
      // Arrange
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

  describe('auth options', () => {
    it('does not require CSRF for CSRF token endpoint', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=valid-access-token',
        },
      });

      // Act
      await GET(request);

      // Assert
      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          requireCSRF: false,
        })
      );
    });

    it('only allows JWT authentication', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=valid-access-token',
        },
      });

      // Act
      await GET(request);

      // Assert
      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          allow: ['jwt'],
        })
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 on unexpected errors', async () => {
      // Arrange
      (generateCSRFToken as unknown as Mock).mockImplementation(() => {
        throw new Error('CSRF generation failed');
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
      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to generate CSRF token');
    });

    it('logs errors for debugging', async () => {
      // Arrange
      const mockError = new Error('CSRF generation failed');
      (generateCSRFToken as Mock).mockImplementation(() => {
        throw mockError;
      });

      const request = new Request('http://localhost/api/auth/csrf', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=valid-access-token',
        },
      });

      // Act
      await GET(request);

      // Assert
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'CSRF token generation error:',
        mockError
      );
    });
  });
});
