import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  authenticateWebRequest,
  authenticateMCPRequest,
  authenticateHybridRequest,
  authenticateRequestWithOptions,
  validateMCPToken,
  validateJWTToken,
  isAuthError,
  isMCPAuthResult,
  isWebAuthResult,
} from '../index';

// Mock dependencies
vi.mock('cookie', () => ({
  parse: vi.fn().mockReturnValue({}),
}));

vi.mock('@pagespace/lib/server', () => ({
  decodeToken: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      mcpTokens: {
        findFirst: vi.fn(),
      },
      users: {
        findFirst: vi.fn(),
      },
    },
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
  mcpTokens: {},
  users: {},
  eq: vi.fn((field, value) => ({ field, value })),
  and: vi.fn((...conditions) => conditions),
  isNull: vi.fn((field) => ({ field, isNull: true })),
}));

vi.mock('../csrf-validation', () => ({
  validateCSRF: vi.fn().mockResolvedValue(null),
}));

vi.mock('../origin-validation', () => ({
  validateOrigin: vi.fn().mockReturnValue(null),
}));

vi.mock('@pagespace/lib/auth', () => ({
  hashToken: vi.fn().mockReturnValue('mocked-hash'),
}));

import { parse } from 'cookie';
import { decodeToken } from '@pagespace/lib/server';
import { db } from '@pagespace/db';
import { validateCSRF } from '../csrf-validation';
import { validateOrigin } from '../origin-validation';

describe('Auth Middleware', () => {
  const mockUser = {
    id: 'test-user-id',
    role: 'user' as const,
    tokenVersion: 0,
  };

  const mockDecodedToken = {
    userId: 'test-user-id',
    tokenVersion: 0,
    role: 'user' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (parse as Mock).mockReturnValue({});
    (decodeToken as Mock).mockResolvedValue(null);
    (db.query.users.findFirst as Mock).mockResolvedValue(null);
    (db.query.mcpTokens.findFirst as Mock).mockResolvedValue(null);
    (validateCSRF as Mock).mockResolvedValue(null);
    (validateOrigin as Mock).mockReturnValue(null);
  });

  describe('validateJWTToken', () => {
    it('returns null for empty token', async () => {
      // Act
      const result = await validateJWTToken('');

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when token decoding fails', async () => {
      // Arrange
      (decodeToken as Mock).mockResolvedValue(null);

      // Act
      const result = await validateJWTToken('invalid-token');

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when user not found', async () => {
      // Arrange
      (decodeToken as Mock).mockResolvedValue(mockDecodedToken);
      (db.query.users.findFirst as Mock).mockResolvedValue(null);

      // Act
      const result = await validateJWTToken('valid-token');

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when tokenVersion mismatch', async () => {
      // Arrange
      (decodeToken as Mock).mockResolvedValue(mockDecodedToken);
      (db.query.users.findFirst as Mock).mockResolvedValue({
        ...mockUser,
        tokenVersion: 1, // Different version
      });

      // Act
      const result = await validateJWTToken('valid-token');

      // Assert
      expect(result).toBeNull();
    });

    it('returns auth details for valid token', async () => {
      // Arrange
      (decodeToken as Mock).mockResolvedValue(mockDecodedToken);
      (db.query.users.findFirst as Mock).mockResolvedValue(mockUser);

      // Act
      const result = await validateJWTToken('valid-token');

      // Assert
      expect(result).toEqual({
        userId: mockUser.id,
        role: mockUser.role,
        tokenVersion: mockUser.tokenVersion,
      });
    });

    it('returns null when database query throws error', async () => {
      // Arrange
      (decodeToken as Mock).mockResolvedValue(mockDecodedToken);
      (db.query.users.findFirst as Mock).mockRejectedValue(new Error('Database connection failed'));

      // Act
      const result = await validateJWTToken('valid-token');

      // Assert - verify graceful degradation under database failures
      expect(result).toBeNull();
    });
  });

  describe('validateMCPToken', () => {
    it('returns null for token without mcp_ prefix', async () => {
      // Act
      const result = await validateMCPToken('invalid-token');

      // Assert
      expect(result).toBeNull();
    });

    it('returns null for empty token', async () => {
      // Act
      const result = await validateMCPToken('');

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when token not found in database', async () => {
      // Arrange
      (db.query.mcpTokens.findFirst as Mock).mockResolvedValue(null);

      // Act
      const result = await validateMCPToken('mcp_valid-token');

      // Assert
      expect(result).toBeNull();
    });

    it('returns auth details for valid MCP token', async () => {
      // Arrange
      const mockMCPToken = {
        id: 'token-id',
        userId: 'test-user-id',
        user: {
          id: 'test-user-id',
          role: 'user' as const,
          tokenVersion: 0,
        },
      };
      (db.query.mcpTokens.findFirst as Mock).mockResolvedValue(mockMCPToken);

      // Act
      const result = await validateMCPToken('mcp_valid-token');

      // Assert
      expect(result).toEqual({
        userId: 'test-user-id',
        role: 'user',
        tokenVersion: 0,
        tokenId: 'token-id',
      });
    });

    it('updates lastUsed timestamp on valid token', async () => {
      // Arrange
      const mockMCPToken = {
        id: 'token-id',
        userId: 'test-user-id',
        user: {
          id: 'test-user-id',
          role: 'user',
          tokenVersion: 0,
        },
      };
      (db.query.mcpTokens.findFirst as Mock).mockResolvedValue(mockMCPToken);

      // Capture the values passed to set()
      let capturedSetValues: Record<string, unknown> | undefined;
      const mockSet = vi.fn().mockImplementation((vals) => {
        capturedSetValues = vals;
        return {
          where: vi.fn().mockResolvedValue(undefined),
        };
      });
      (db.update as Mock).mockReturnValue({ set: mockSet });

      // Act
      await validateMCPToken('mcp_valid-token');

      // Assert - verify complete update chain and that lastUsed is a Date
      expect(db.update).toHaveBeenCalled();
      expect(mockSet).toHaveBeenCalled();
      expect(capturedSetValues).toBeDefined();
      expect(capturedSetValues!.lastUsed).toBeInstanceOf(Date);
    });
  });

  describe('authenticateWebRequest', () => {
    it('returns error when no token provided', async () => {
      // Arrange
      const request = new Request('http://localhost/api/test', {
        method: 'GET',
      });

      // Act
      const result = await authenticateWebRequest(request);

      // Assert
      expect(isAuthError(result)).toBe(true);
      if (isAuthError(result)) {
        expect(result.error.status).toBe(401);
      }
    });

    it('returns error when MCP token used (not permitted)', async () => {
      // Arrange
      const request = new Request('http://localhost/api/test', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer mcp_some-token',
        },
      });

      // Act
      const result = await authenticateWebRequest(request);

      // Assert
      expect(isAuthError(result)).toBe(true);
      if (isAuthError(result)) {
        expect(result.error.status).toBe(401);
        const body = await result.error.json();
        expect(body.error).toContain('MCP tokens are not permitted');
      }
    });

    it('authenticates with Bearer token', async () => {
      // Arrange
      (decodeToken as Mock).mockResolvedValue(mockDecodedToken);
      (db.query.users.findFirst as Mock).mockResolvedValue(mockUser);

      const request = new Request('http://localhost/api/test', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer valid-jwt-token',
        },
      });

      // Act
      const result = await authenticateWebRequest(request);

      // Assert
      expect(isAuthError(result)).toBe(false);
      if (isWebAuthResult(result)) {
        expect(result.source).toBe('header');
        expect(result.tokenType).toBe('jwt');
        expect(result.userId).toBe(mockUser.id);
      }
    });

    it('authenticates with cookie token', async () => {
      // Arrange
      (parse as Mock).mockReturnValue({ accessToken: 'cookie-jwt-token' });
      (decodeToken as Mock).mockResolvedValue(mockDecodedToken);
      (db.query.users.findFirst as Mock).mockResolvedValue(mockUser);

      const request = new Request('http://localhost/api/test', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=cookie-jwt-token',
        },
      });

      // Act
      const result = await authenticateWebRequest(request);

      // Assert
      expect(isAuthError(result)).toBe(false);
      if (isWebAuthResult(result)) {
        expect(result.source).toBe('cookie');
        expect(result.tokenType).toBe('jwt');
      }
    });

    it('returns error for invalid session', async () => {
      // Arrange
      (parse as Mock).mockReturnValue({ accessToken: 'invalid-token' });
      (decodeToken as Mock).mockResolvedValue(null);

      const request = new Request('http://localhost/api/test', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=invalid-token',
        },
      });

      // Act
      const result = await authenticateWebRequest(request);

      // Assert
      expect(isAuthError(result)).toBe(true);
      if (isAuthError(result)) {
        const body = await result.error.json();
        expect(body.error).toBe('Invalid or expired session');
      }
    });
  });

  describe('authenticateMCPRequest', () => {
    it('returns error when no token provided', async () => {
      // Arrange
      const request = new Request('http://localhost/api/test', {
        method: 'GET',
      });

      // Act
      const result = await authenticateMCPRequest(request);

      // Assert
      expect(isAuthError(result)).toBe(true);
      if (isAuthError(result)) {
        const body = await result.error.json();
        expect(body.error).toBe('MCP token required');
      }
    });

    it('returns error when non-MCP token provided', async () => {
      // Arrange
      const request = new Request('http://localhost/api/test', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer jwt-token',
        },
      });

      // Act
      const result = await authenticateMCPRequest(request);

      // Assert
      expect(isAuthError(result)).toBe(true);
      if (isAuthError(result)) {
        const body = await result.error.json();
        expect(body.error).toBe('MCP token required');
      }
    });

    it('returns error for invalid MCP token', async () => {
      // Arrange
      (db.query.mcpTokens.findFirst as Mock).mockResolvedValue(null);

      const request = new Request('http://localhost/api/test', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer mcp_invalid-token',
        },
      });

      // Act
      const result = await authenticateMCPRequest(request);

      // Assert
      expect(isAuthError(result)).toBe(true);
      if (isAuthError(result)) {
        const body = await result.error.json();
        expect(body.error).toBe('Invalid MCP token');
      }
    });

    it('authenticates with valid MCP token', async () => {
      // Arrange
      const mockMCPToken = {
        id: 'token-id',
        userId: 'test-user-id',
        user: {
          id: 'test-user-id',
          role: 'user',
          tokenVersion: 0,
        },
      };
      (db.query.mcpTokens.findFirst as Mock).mockResolvedValue(mockMCPToken);

      const request = new Request('http://localhost/api/test', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer mcp_valid-token',
        },
      });

      // Act
      const result = await authenticateMCPRequest(request);

      // Assert
      expect(isAuthError(result)).toBe(false);
      if (isMCPAuthResult(result)) {
        expect(result.tokenType).toBe('mcp');
        expect(result.userId).toBe('test-user-id');
        expect(result.tokenId).toBe('token-id');
      }
    });
  });

  describe('authenticateRequestWithOptions', () => {
    describe('allowed token types', () => {
      it('returns error when no token types allowed', async () => {
        // Arrange
        const request = new Request('http://localhost/api/test', {
          method: 'GET',
        });

        // Act
        const result = await authenticateRequestWithOptions(request, {
          allow: [],
        });

        // Assert
        expect(isAuthError(result)).toBe(true);
        if (isAuthError(result)) {
          expect(result.error.status).toBe(500);
        }
      });

      it('rejects MCP token when only JWT allowed', async () => {
        // Arrange
        const request = new Request('http://localhost/api/test', {
          method: 'GET',
          headers: {
            Authorization: 'Bearer mcp_some-token',
          },
        });

        // Act
        const result = await authenticateRequestWithOptions(request, {
          allow: ['jwt'],
        });

        // Assert
        expect(isAuthError(result)).toBe(true);
        if (isAuthError(result)) {
          const body = await result.error.json();
          expect(body.error).toContain('MCP tokens are not permitted');
        }
      });

      it('allows MCP token when MCP type is allowed', async () => {
        // Arrange
        const mockMCPToken = {
          id: 'token-id',
          userId: 'test-user-id',
          user: {
            id: 'test-user-id',
            role: 'user',
            tokenVersion: 0,
          },
        };
        (db.query.mcpTokens.findFirst as Mock).mockResolvedValue(mockMCPToken);

        const request = new Request('http://localhost/api/test', {
          method: 'GET',
          headers: {
            Authorization: 'Bearer mcp_valid-token',
          },
        });

        // Act
        const result = await authenticateRequestWithOptions(request, {
          allow: ['mcp', 'jwt'],
        });

        // Assert
        expect(isAuthError(result)).toBe(false);
        expect(isMCPAuthResult(result)).toBe(true);
      });
    });

    describe('CSRF validation', () => {
      it('validates CSRF for cookie-based JWT when required', async () => {
        // Arrange
        (parse as Mock).mockReturnValue({ accessToken: 'cookie-token' });
        (decodeToken as Mock).mockResolvedValue(mockDecodedToken);
        (db.query.users.findFirst as Mock).mockResolvedValue(mockUser);

        const request = new Request('http://localhost/api/test', {
          method: 'POST',
          headers: {
            Cookie: 'accessToken=cookie-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
        });

        // Act
        await authenticateRequestWithOptions(request, {
          allow: ['jwt'],
          requireCSRF: true,
        });

        // Assert
        expect(validateCSRF).toHaveBeenCalledWith(request);
      });

      it('skips CSRF for Bearer token auth', async () => {
        // Arrange
        (decodeToken as Mock).mockResolvedValue(mockDecodedToken);
        (db.query.users.findFirst as Mock).mockResolvedValue(mockUser);

        const request = new Request('http://localhost/api/test', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer jwt-token',
          },
        });

        // Act
        await authenticateRequestWithOptions(request, {
          allow: ['jwt'],
          requireCSRF: true,
        });

        // Assert - CSRF not validated for header-based auth
        expect(validateCSRF).not.toHaveBeenCalled();
      });

      it('returns CSRF error when validation fails', async () => {
        // Arrange
        (parse as Mock).mockReturnValue({ accessToken: 'cookie-token' });
        (decodeToken as Mock).mockResolvedValue(mockDecodedToken);
        (db.query.users.findFirst as Mock).mockResolvedValue(mockUser);
        (validateCSRF as Mock).mockResolvedValue(
          Response.json({ error: 'Invalid CSRF token' }, { status: 403 })
        );

        const request = new Request('http://localhost/api/test', {
          method: 'POST',
          headers: {
            Cookie: 'accessToken=cookie-token',
          },
        });

        // Act
        const result = await authenticateRequestWithOptions(request, {
          allow: ['jwt'],
          requireCSRF: true,
        });

        // Assert
        expect(isAuthError(result)).toBe(true);
        if (isAuthError(result)) {
          expect(result.error.status).toBe(403);
        }
      });
    });

    describe('Origin validation (defense-in-depth)', () => {
      it('validates origin when requireCSRF is true for cookie-based auth', async () => {
        // Arrange
        (parse as Mock).mockReturnValue({ accessToken: 'cookie-token' });
        (decodeToken as Mock).mockResolvedValue(mockDecodedToken);
        (db.query.users.findFirst as Mock).mockResolvedValue(mockUser);

        const request = new Request('http://localhost/api/test', {
          method: 'POST',
          headers: {
            Cookie: 'accessToken=cookie-token',
            'X-CSRF-Token': 'valid-csrf-token',
            Origin: 'http://localhost',
          },
        });

        // Act
        await authenticateRequestWithOptions(request, {
          allow: ['jwt'],
          requireCSRF: true,
        });

        // Assert - origin validation is called for cookie-based auth when requireCSRF is true
        expect(validateOrigin).toHaveBeenCalledWith(request);
      });

      it('validates origin when requireOriginValidation is explicitly true', async () => {
        // Arrange
        (parse as Mock).mockReturnValue({ accessToken: 'cookie-token' });
        (decodeToken as Mock).mockResolvedValue(mockDecodedToken);
        (db.query.users.findFirst as Mock).mockResolvedValue(mockUser);

        const request = new Request('http://localhost/api/test', {
          method: 'POST',
          headers: {
            Cookie: 'accessToken=cookie-token',
            Origin: 'http://localhost',
          },
        });

        // Act
        await authenticateRequestWithOptions(request, {
          allow: ['jwt'],
          requireOriginValidation: true,
        });

        // Assert
        expect(validateOrigin).toHaveBeenCalledWith(request);
      });

      it('returns 403 when origin validation fails before CSRF check', async () => {
        // Arrange
        (parse as Mock).mockReturnValue({ accessToken: 'cookie-token' });
        (decodeToken as Mock).mockResolvedValue(mockDecodedToken);
        (db.query.users.findFirst as Mock).mockResolvedValue(mockUser);
        // Origin validation fails
        (validateOrigin as Mock).mockReturnValue(
          Response.json(
            { error: 'Origin not allowed', code: 'ORIGIN_INVALID' },
            { status: 403 }
          )
        );

        const request = new Request('http://localhost/api/test', {
          method: 'POST',
          headers: {
            Cookie: 'accessToken=cookie-token',
            'X-CSRF-Token': 'valid-csrf-token',
            Origin: 'https://evil.example.com',
          },
        });

        // Act
        const result = await authenticateRequestWithOptions(request, {
          allow: ['jwt'],
          requireCSRF: true,
        });

        // Assert - origin failure returns 403
        expect(isAuthError(result)).toBe(true);
        if (isAuthError(result)) {
          expect(result.error.status).toBe(403);
          const body = await result.error.json();
          expect(body.code).toBe('ORIGIN_INVALID');
        }

        // Assert - CSRF validation was NOT called because origin failed first
        expect(validateCSRF).not.toHaveBeenCalled();
      });

      it('passes authentication with valid origin and valid CSRF', async () => {
        // Arrange
        (parse as Mock).mockReturnValue({ accessToken: 'cookie-token' });
        (decodeToken as Mock).mockResolvedValue(mockDecodedToken);
        (db.query.users.findFirst as Mock).mockResolvedValue(mockUser);
        (validateOrigin as Mock).mockReturnValue(null);
        (validateCSRF as Mock).mockResolvedValue(null);

        const request = new Request('http://localhost/api/test', {
          method: 'POST',
          headers: {
            Cookie: 'accessToken=cookie-token',
            'X-CSRF-Token': 'valid-csrf-token',
            Origin: 'http://localhost',
          },
        });

        // Act
        const result = await authenticateRequestWithOptions(request, {
          allow: ['jwt'],
          requireCSRF: true,
        });

        // Assert - authentication passes
        expect(isAuthError(result)).toBe(false);
        if (!isAuthError(result)) {
          expect(result.userId).toBe(mockUser.id);
          expect(result.tokenType).toBe('jwt');
        }

        // Assert - both validations were called
        expect(validateOrigin).toHaveBeenCalledWith(request);
        expect(validateCSRF).toHaveBeenCalledWith(request);
      });

      it('skips origin validation for Bearer token auth (non-browser)', async () => {
        // Arrange
        (decodeToken as Mock).mockResolvedValue(mockDecodedToken);
        (db.query.users.findFirst as Mock).mockResolvedValue(mockUser);

        const request = new Request('http://localhost/api/test', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer jwt-token',
          },
        });

        // Act
        await authenticateRequestWithOptions(request, {
          allow: ['jwt'],
          requireCSRF: true,
          requireOriginValidation: true,
        });

        // Assert - origin validation not called for header-based auth
        expect(validateOrigin).not.toHaveBeenCalled();
      });

      it('skips origin validation for MCP token auth', async () => {
        // Arrange
        const mockMCPToken = {
          id: 'token-id',
          userId: 'test-user-id',
          user: {
            id: 'test-user-id',
            role: 'user',
            tokenVersion: 0,
          },
        };
        (db.query.mcpTokens.findFirst as Mock).mockResolvedValue(mockMCPToken);

        const request = new Request('http://localhost/api/test', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer mcp_valid-token',
          },
        });

        // Act
        await authenticateRequestWithOptions(request, {
          allow: ['mcp', 'jwt'],
          requireCSRF: true,
          requireOriginValidation: true,
        });

        // Assert - origin validation not called for MCP token auth
        expect(validateOrigin).not.toHaveBeenCalled();
      });

      it('allows disabling origin validation even when requireCSRF is true', async () => {
        // Arrange
        (parse as Mock).mockReturnValue({ accessToken: 'cookie-token' });
        (decodeToken as Mock).mockResolvedValue(mockDecodedToken);
        (db.query.users.findFirst as Mock).mockResolvedValue(mockUser);

        const request = new Request('http://localhost/api/test', {
          method: 'POST',
          headers: {
            Cookie: 'accessToken=cookie-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
        });

        // Act
        await authenticateRequestWithOptions(request, {
          allow: ['jwt'],
          requireCSRF: true,
          requireOriginValidation: false, // explicitly disabled
        });

        // Assert - origin validation was NOT called because it was explicitly disabled
        expect(validateOrigin).not.toHaveBeenCalled();
        // Assert - CSRF validation was still called
        expect(validateCSRF).toHaveBeenCalledWith(request);
      });
    });
  });

  describe('authenticateHybridRequest', () => {
    it('accepts JWT tokens', async () => {
      // Arrange
      (decodeToken as Mock).mockResolvedValue(mockDecodedToken);
      (db.query.users.findFirst as Mock).mockResolvedValue(mockUser);

      const request = new Request('http://localhost/api/test', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer jwt-token',
        },
      });

      // Act
      const result = await authenticateHybridRequest(request);

      // Assert
      expect(isAuthError(result)).toBe(false);
      if (!isAuthError(result)) {
        expect(result.tokenType).toBe('jwt');
      }
    });

    it('accepts MCP tokens', async () => {
      // Arrange
      const mockMCPToken = {
        id: 'token-id',
        userId: 'test-user-id',
        user: {
          id: 'test-user-id',
          role: 'user',
          tokenVersion: 0,
        },
      };
      (db.query.mcpTokens.findFirst as Mock).mockResolvedValue(mockMCPToken);

      const request = new Request('http://localhost/api/test', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer mcp_valid-token',
        },
      });

      // Act
      const result = await authenticateHybridRequest(request);

      // Assert - verify MCP token is accepted in hybrid auth
      expect(isAuthError(result)).toBe(false);
      if (!isAuthError(result)) {
        expect(isMCPAuthResult(result)).toBe(true);
        expect(result.tokenType).toBe('mcp');
        expect(result.userId).toBe('test-user-id');
      }
    });
  });

  describe('type guards', () => {
    describe('isAuthError', () => {
      it('returns true for error result', () => {
        const errorResult = {
          error: Response.json({ error: 'Test' }, { status: 401 }),
        } as unknown as import('@/lib/auth').AuthError;
        expect(isAuthError(errorResult)).toBe(true);
      });

      it('returns false for success result', () => {
        const successResult = {
          userId: 'test',
          role: 'user' as const,
          tokenVersion: 0,
          tokenType: 'jwt' as const,
          source: 'cookie' as const,
        };
        expect(isAuthError(successResult)).toBe(false);
      });
    });

    describe('isMCPAuthResult', () => {
      it('returns true for MCP result', () => {
        const mcpResult = {
          userId: 'test',
          role: 'user' as const,
          tokenVersion: 0,
          tokenType: 'mcp' as const,
          tokenId: 'token-id',
        };
        expect(isMCPAuthResult(mcpResult)).toBe(true);
      });

      it('returns false for JWT result', () => {
        const jwtResult = {
          userId: 'test',
          role: 'user' as const,
          tokenVersion: 0,
          tokenType: 'jwt' as const,
          source: 'cookie' as const,
        };
        expect(isMCPAuthResult(jwtResult)).toBe(false);
      });
    });

    describe('isWebAuthResult', () => {
      it('returns true for JWT result', () => {
        const jwtResult = {
          userId: 'test',
          role: 'user' as const,
          tokenVersion: 0,
          tokenType: 'jwt' as const,
          source: 'cookie' as const,
        };
        expect(isWebAuthResult(jwtResult)).toBe(true);
      });

      it('returns false for MCP result', () => {
        const mcpResult = {
          userId: 'test',
          role: 'user' as const,
          tokenVersion: 0,
          tokenType: 'mcp' as const,
          tokenId: 'token-id',
        };
        expect(isWebAuthResult(mcpResult)).toBe(false);
      });
    });
  });
});
