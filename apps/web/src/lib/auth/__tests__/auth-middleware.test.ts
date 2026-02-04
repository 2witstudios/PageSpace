import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  authenticateSessionRequest,
  authenticateMCPRequest,
  authenticateHybridRequest,
  authenticateRequestWithOptions,
  validateMCPToken,
  validateSessionToken,
  isAuthError,
  isMCPAuthResult,
  isSessionAuthResult,
} from '../index';

// Mock dependencies
vi.mock('@pagespace/lib/auth', () => ({
  hashToken: vi.fn().mockReturnValue('mocked-hash'),
  sessionService: {
    validateSession: vi.fn(),
  },
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      mcpTokens: {
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

vi.mock('../cookie-config', () => ({
  getSessionFromCookies: vi.fn(),
}));

import { sessionService } from '@pagespace/lib/auth';
import { db } from '@pagespace/db';
import { validateCSRF } from '../csrf-validation';
import { validateOrigin } from '../origin-validation';
import { getSessionFromCookies } from '../cookie-config';

describe('Auth Middleware', () => {
  const mockSessionClaims = {
    sessionId: 'test-session-id',
    userId: 'test-user-id',
    userRole: 'user' as const,
    tokenVersion: 0,
    adminRoleVersion: 0,
    type: 'user' as const,
    scopes: ['*'],
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (sessionService.validateSession as Mock).mockResolvedValue(null);
    (db.query.mcpTokens.findFirst as Mock).mockResolvedValue(null);
    (validateCSRF as Mock).mockResolvedValue(null);
    (validateOrigin as Mock).mockReturnValue(null);
    (getSessionFromCookies as Mock).mockReturnValue(null);
  });

  describe('validateSessionToken', () => {
    it('returns null for empty token', async () => {
      // Act
      const result = await validateSessionToken('');

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when session validation fails', async () => {
      // Arrange
      (sessionService.validateSession as Mock).mockResolvedValue(null);

      // Act
      const result = await validateSessionToken('ps_sess_invalid');

      // Assert
      expect(result).toBeNull();
    });

    it('returns session claims for valid token', async () => {
      // Arrange
      (sessionService.validateSession as Mock).mockResolvedValue(mockSessionClaims);

      // Act
      const result = await validateSessionToken('ps_sess_valid');

      // Assert
      expect(result).toEqual(mockSessionClaims);
    });

    it('returns null when sessionService throws error', async () => {
      // Arrange
      (sessionService.validateSession as Mock).mockRejectedValue(
        new Error('Session service unavailable')
      );

      // Act
      const result = await validateSessionToken('ps_sess_test');

      // Assert - verify graceful degradation
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
          adminRoleVersion: 0,
        },
        driveScopes: [],
      };
      (db.query.mcpTokens.findFirst as Mock).mockResolvedValue(mockMCPToken);

      // Act
      const result = await validateMCPToken('mcp_valid-token');

      // Assert
      expect(result).toEqual({
        userId: 'test-user-id',
        role: 'user',
        tokenVersion: 0,
        adminRoleVersion: 0,
        tokenId: 'token-id',
        allowedDriveIds: [],
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
          adminRoleVersion: 0,
        },
        driveScopes: [],
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

  describe('authenticateSessionRequest', () => {
    it('returns error when no session cookie', async () => {
      // Arrange
      (getSessionFromCookies as Mock).mockReturnValue(null);

      const request = new Request('http://localhost/api/test', {
        method: 'GET',
      });

      // Act
      const result = await authenticateSessionRequest(request);

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
      const result = await authenticateSessionRequest(request);

      // Assert
      expect(isAuthError(result)).toBe(true);
      if (isAuthError(result)) {
        expect(result.error.status).toBe(401);
        const body = await result.error.json();
        expect(body.error).toContain('MCP tokens are not permitted');
      }
    });

    it('authenticates with valid session cookie', async () => {
      // Arrange
      (getSessionFromCookies as Mock).mockReturnValue('ps_sess_valid');
      (sessionService.validateSession as Mock).mockResolvedValue(mockSessionClaims);

      const request = new Request('http://localhost/api/test', {
        method: 'GET',
        headers: {
          Cookie: 'session=ps_sess_valid',
        },
      });

      // Act
      const result = await authenticateSessionRequest(request);

      // Assert
      expect(isAuthError(result)).toBe(false);
      if (isSessionAuthResult(result)) {
        expect(result.tokenType).toBe('session');
        expect(result.userId).toBe(mockSessionClaims.userId);
        expect(result.sessionId).toBe(mockSessionClaims.sessionId);
      }
    });

    it('returns error for invalid session', async () => {
      // Arrange
      (getSessionFromCookies as Mock).mockReturnValue('ps_sess_invalid');
      (sessionService.validateSession as Mock).mockResolvedValue(null);

      const request = new Request('http://localhost/api/test', {
        method: 'GET',
        headers: {
          Cookie: 'session=ps_sess_invalid',
        },
      });

      // Act
      const result = await authenticateSessionRequest(request);

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
          Authorization: 'Bearer regular-token',
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
          adminRoleVersion: 0,
        },
        driveScopes: [],
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

      it('rejects MCP token when only session allowed', async () => {
        // Arrange
        const request = new Request('http://localhost/api/test', {
          method: 'GET',
          headers: {
            Authorization: 'Bearer mcp_some-token',
          },
        });

        // Act
        const result = await authenticateRequestWithOptions(request, {
          allow: ['session'],
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
            adminRoleVersion: 0,
          },
          driveScopes: [],
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
          allow: ['mcp', 'session'],
        });

        // Assert
        expect(isAuthError(result)).toBe(false);
        expect(isMCPAuthResult(result)).toBe(true);
      });
    });

    describe('CSRF validation', () => {
      it('validates CSRF for session auth when required', async () => {
        // Arrange
        (getSessionFromCookies as Mock).mockReturnValue('ps_sess_valid');
        (sessionService.validateSession as Mock).mockResolvedValue(mockSessionClaims);

        const request = new Request('http://localhost/api/test', {
          method: 'POST',
          headers: {
            Cookie: 'session=ps_sess_valid',
            'X-CSRF-Token': 'valid-csrf-token',
          },
        });

        // Act
        await authenticateRequestWithOptions(request, {
          allow: ['session'],
          requireCSRF: true,
        });

        // Assert
        expect(validateCSRF).toHaveBeenCalledWith(request);
      });

      it('returns CSRF error when validation fails', async () => {
        // Arrange
        (getSessionFromCookies as Mock).mockReturnValue('ps_sess_valid');
        (sessionService.validateSession as Mock).mockResolvedValue(mockSessionClaims);
        (validateCSRF as Mock).mockResolvedValue(
          Response.json({ error: 'Invalid CSRF token' }, { status: 403 })
        );

        const request = new Request('http://localhost/api/test', {
          method: 'POST',
          headers: {
            Cookie: 'session=ps_sess_valid',
          },
        });

        // Act
        const result = await authenticateRequestWithOptions(request, {
          allow: ['session'],
          requireCSRF: true,
        });

        // Assert
        expect(isAuthError(result)).toBe(true);
        if (isAuthError(result)) {
          expect(result.error.status).toBe(403);
        }
      });

      it('skips CSRF validation for Bearer token auth (not vulnerable to CSRF)', async () => {
        // Arrange - Bearer token session auth (desktop/mobile)
        (sessionService.validateSession as Mock).mockResolvedValue(mockSessionClaims);

        const request = new Request('http://localhost/api/test', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ps_sess_valid',
          },
        });

        // Act
        const result = await authenticateRequestWithOptions(request, {
          allow: ['session'],
          requireCSRF: true,
        });

        // Assert - authentication passes
        expect(isAuthError(result)).toBe(false);
        if (!isAuthError(result)) {
          expect(result.userId).toBe(mockSessionClaims.userId);
          expect(result.tokenType).toBe('session');
        }

        // Assert - CSRF validation was NOT called because Bearer auth is CSRF-safe
        // CSRF attacks exploit browser-sent cookies; Bearer tokens must be explicitly set
        expect(validateCSRF).not.toHaveBeenCalled();
      });
    });

    describe('Origin validation (defense-in-depth)', () => {
      it('validates origin when requireCSRF is true for session auth', async () => {
        // Arrange
        (getSessionFromCookies as Mock).mockReturnValue('ps_sess_valid');
        (sessionService.validateSession as Mock).mockResolvedValue(mockSessionClaims);

        const request = new Request('http://localhost/api/test', {
          method: 'POST',
          headers: {
            Cookie: 'session=ps_sess_valid',
            'X-CSRF-Token': 'valid-csrf-token',
            Origin: 'http://localhost',
          },
        });

        // Act
        await authenticateRequestWithOptions(request, {
          allow: ['session'],
          requireCSRF: true,
        });

        // Assert - origin validation is called for session auth when requireCSRF is true
        expect(validateOrigin).toHaveBeenCalledWith(request);
      });

      it('validates origin when requireOriginValidation is explicitly true', async () => {
        // Arrange
        (getSessionFromCookies as Mock).mockReturnValue('ps_sess_valid');
        (sessionService.validateSession as Mock).mockResolvedValue(mockSessionClaims);

        const request = new Request('http://localhost/api/test', {
          method: 'POST',
          headers: {
            Cookie: 'session=ps_sess_valid',
            Origin: 'http://localhost',
          },
        });

        // Act
        await authenticateRequestWithOptions(request, {
          allow: ['session'],
          requireOriginValidation: true,
        });

        // Assert
        expect(validateOrigin).toHaveBeenCalledWith(request);
      });

      it('returns 403 when origin validation fails before CSRF check', async () => {
        // Arrange
        (getSessionFromCookies as Mock).mockReturnValue('ps_sess_valid');
        (sessionService.validateSession as Mock).mockResolvedValue(mockSessionClaims);
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
            Cookie: 'session=ps_sess_valid',
            'X-CSRF-Token': 'valid-csrf-token',
            Origin: 'https://evil.example.com',
          },
        });

        // Act
        const result = await authenticateRequestWithOptions(request, {
          allow: ['session'],
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
        (getSessionFromCookies as Mock).mockReturnValue('ps_sess_valid');
        (sessionService.validateSession as Mock).mockResolvedValue(mockSessionClaims);
        (validateOrigin as Mock).mockReturnValue(null);
        (validateCSRF as Mock).mockResolvedValue(null);

        const request = new Request('http://localhost/api/test', {
          method: 'POST',
          headers: {
            Cookie: 'session=ps_sess_valid',
            'X-CSRF-Token': 'valid-csrf-token',
            Origin: 'http://localhost',
          },
        });

        // Act
        const result = await authenticateRequestWithOptions(request, {
          allow: ['session'],
          requireCSRF: true,
        });

        // Assert - authentication passes
        expect(isAuthError(result)).toBe(false);
        if (!isAuthError(result)) {
          expect(result.userId).toBe(mockSessionClaims.userId);
          expect(result.tokenType).toBe('session');
        }

        // Assert - both validations were called
        expect(validateOrigin).toHaveBeenCalledWith(request);
        expect(validateCSRF).toHaveBeenCalledWith(request);
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
            adminRoleVersion: 0,
          },
          driveScopes: [],
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
          allow: ['mcp', 'session'],
          requireCSRF: true,
          requireOriginValidation: true,
        });

        // Assert - origin validation not called for MCP token auth
        expect(validateOrigin).not.toHaveBeenCalled();
      });

      it('allows disabling origin validation even when requireCSRF is true', async () => {
        // Arrange
        (getSessionFromCookies as Mock).mockReturnValue('ps_sess_valid');
        (sessionService.validateSession as Mock).mockResolvedValue(mockSessionClaims);

        const request = new Request('http://localhost/api/test', {
          method: 'POST',
          headers: {
            Cookie: 'session=ps_sess_valid',
            'X-CSRF-Token': 'valid-csrf-token',
          },
        });

        // Act
        await authenticateRequestWithOptions(request, {
          allow: ['session'],
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
    it('accepts session tokens', async () => {
      // Arrange
      (getSessionFromCookies as Mock).mockReturnValue('ps_sess_valid');
      (sessionService.validateSession as Mock).mockResolvedValue(mockSessionClaims);

      const request = new Request('http://localhost/api/test', {
        method: 'GET',
        headers: {
          Cookie: 'session=ps_sess_valid',
        },
      });

      // Act
      const result = await authenticateHybridRequest(request);

      // Assert
      expect(isAuthError(result)).toBe(false);
      if (!isAuthError(result)) {
        expect(result.tokenType).toBe('session');
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
          adminRoleVersion: 0,
        },
        driveScopes: [],
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
          adminRoleVersion: 0,
          tokenType: 'session' as const,
          sessionId: 'test-session-id',
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
          adminRoleVersion: 0,
          tokenType: 'mcp' as const,
          tokenId: 'token-id',
          allowedDriveIds: [],
        };
        expect(isMCPAuthResult(mcpResult)).toBe(true);
      });

      it('returns false for session result', () => {
        const sessionResult = {
          userId: 'test',
          role: 'user' as const,
          tokenVersion: 0,
          adminRoleVersion: 0,
          tokenType: 'session' as const,
          sessionId: 'test-session-id',
        };
        expect(isMCPAuthResult(sessionResult)).toBe(false);
      });
    });

    describe('isSessionAuthResult', () => {
      it('returns true for session result', () => {
        const sessionResult = {
          userId: 'test',
          role: 'user' as const,
          tokenVersion: 0,
          adminRoleVersion: 0,
          tokenType: 'session' as const,
          sessionId: 'test-session-id',
        };
        expect(isSessionAuthResult(sessionResult)).toBe(true);
      });

      it('returns false for MCP result', () => {
        const mcpResult = {
          userId: 'test',
          role: 'user' as const,
          tokenVersion: 0,
          adminRoleVersion: 0,
          tokenType: 'mcp' as const,
          tokenId: 'token-id',
          allowedDriveIds: [],
        };
        expect(isSessionAuthResult(mcpResult)).toBe(false);
      });
    });
  });
});
