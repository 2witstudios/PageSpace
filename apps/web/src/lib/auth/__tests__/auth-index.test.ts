import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      mcpTokens: { findFirst: vi.fn() },
      pages: { findFirst: vi.fn() },
    },
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
  },
  mcpTokens: {},
  pages: {},
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
}));

vi.mock('@pagespace/lib/auth', () => ({
  hashToken: vi.fn((t: string) => `hashed_${t}`),
  sessionService: {
    validateSession: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/server', () => ({
  EnforcedAuthContext: {
    fromSession: vi.fn((claims: unknown) => ({ claims })),
  },
  logSecurityEvent: vi.fn(),
}));

vi.mock('../cookie-config', () => ({
  getSessionFromCookies: vi.fn(),
}));

vi.mock('../origin-validation', () => ({
  validateOrigin: vi.fn(),
}));

vi.mock('../csrf-validation', () => ({
  validateCSRF: vi.fn(),
}));

import {
  isAuthError,
  isMCPAuthResult,
  isSessionAuthResult,
  isEnforcedAuthError,
  getAllowedDriveIds,
  checkMCPDriveScope,
  filterDrivesByMCPScope,
  checkMCPCreateScope,
  validateMCPToken,
  validateSessionToken,
  authenticateMCPRequest,
  authenticateSessionRequest,
  authenticateRequestWithOptions,
  type AuthResult,
  type MCPAuthResult,
  type SessionAuthResult,
  type AuthenticationResult,
} from '../index';
import { db } from '@pagespace/db';
import { sessionService } from '@pagespace/lib/auth';
import { getSessionFromCookies } from '../cookie-config';

describe('auth/index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- Type Guards ----

  describe('isAuthError', () => {
    it('should return true for auth error results', () => {
      const result = { error: NextResponse.json({}, { status: 401 }) };
      expect(isAuthError(result)).toBe(true);
    });

    it('should return false for successful auth results', () => {
      const result: MCPAuthResult = {
        userId: 'u1',
        role: 'user',
        tokenVersion: 1,
        adminRoleVersion: 1,
        tokenType: 'mcp',
        tokenId: 't1',
        allowedDriveIds: [],
      };
      expect(isAuthError(result)).toBe(false);
    });
  });

  describe('isMCPAuthResult', () => {
    it('should return true for MCP auth results', () => {
      const result: MCPAuthResult = {
        userId: 'u1',
        role: 'user',
        tokenVersion: 1,
        adminRoleVersion: 1,
        tokenType: 'mcp',
        tokenId: 't1',
        allowedDriveIds: [],
      };
      expect(isMCPAuthResult(result)).toBe(true);
    });

    it('should return false for session auth results', () => {
      const result: SessionAuthResult = {
        userId: 'u1',
        role: 'user',
        tokenVersion: 1,
        adminRoleVersion: 1,
        tokenType: 'session',
        sessionId: 's1',
      };
      expect(isMCPAuthResult(result)).toBe(false);
    });

    it('should return false for auth errors', () => {
      const result = { error: NextResponse.json({}, { status: 401 }) };
      expect(isMCPAuthResult(result)).toBe(false);
    });
  });

  describe('isSessionAuthResult', () => {
    it('should return true for session auth results', () => {
      const result: SessionAuthResult = {
        userId: 'u1',
        role: 'user',
        tokenVersion: 1,
        adminRoleVersion: 1,
        tokenType: 'session',
        sessionId: 's1',
      };
      expect(isSessionAuthResult(result)).toBe(true);
    });

    it('should return false for MCP auth results', () => {
      const result: MCPAuthResult = {
        userId: 'u1',
        role: 'user',
        tokenVersion: 1,
        adminRoleVersion: 1,
        tokenType: 'mcp',
        tokenId: 't1',
        allowedDriveIds: [],
      };
      expect(isSessionAuthResult(result)).toBe(false);
    });
  });

  describe('isEnforcedAuthError', () => {
    it('should return true when result has error', () => {
      expect(isEnforcedAuthError({ error: NextResponse.json({}) })).toBe(true);
    });

    it('should return false when result has ctx', () => {
      expect(isEnforcedAuthError({ ctx: {} as any })).toBe(false);
    });
  });

  // ---- MCP Scope Helpers ----

  describe('getAllowedDriveIds', () => {
    it('should return allowedDriveIds for MCP token', () => {
      const auth: MCPAuthResult = {
        userId: 'u1',
        role: 'user',
        tokenVersion: 1,
        adminRoleVersion: 1,
        tokenType: 'mcp',
        tokenId: 't1',
        allowedDriveIds: ['d1', 'd2'],
      };
      expect(getAllowedDriveIds(auth)).toEqual(['d1', 'd2']);
    });

    it('should return empty array for session auth', () => {
      const auth: SessionAuthResult = {
        userId: 'u1',
        role: 'user',
        tokenVersion: 1,
        adminRoleVersion: 1,
        tokenType: 'session',
        sessionId: 's1',
      };
      expect(getAllowedDriveIds(auth)).toEqual([]);
    });
  });

  describe('checkMCPDriveScope', () => {
    const mcpAuth: MCPAuthResult = {
      userId: 'u1',
      role: 'user',
      tokenVersion: 1,
      adminRoleVersion: 1,
      tokenType: 'mcp',
      tokenId: 't1',
      allowedDriveIds: ['d1', 'd2'],
    };

    it('should return null when drive is in scope', () => {
      expect(checkMCPDriveScope(mcpAuth, 'd1')).toBeNull();
    });

    it('should return 403 when drive is not in scope', () => {
      const result = checkMCPDriveScope(mcpAuth, 'd3');
      expect(result).toBeInstanceOf(NextResponse);
      expect(result?.status).toBe(403);
    });

    it('should return null for session auth (full access)', () => {
      const sessionAuth: SessionAuthResult = {
        userId: 'u1',
        role: 'user',
        tokenVersion: 1,
        adminRoleVersion: 1,
        tokenType: 'session',
        sessionId: 's1',
      };
      expect(checkMCPDriveScope(sessionAuth, 'any-drive')).toBeNull();
    });

    it('should return null for unscoped MCP token', () => {
      const unscopedMcp: MCPAuthResult = {
        ...mcpAuth,
        allowedDriveIds: [],
      };
      expect(checkMCPDriveScope(unscopedMcp, 'any-drive')).toBeNull();
    });
  });

  describe('filterDrivesByMCPScope', () => {
    it('should filter drives to only allowed ones for scoped MCP token', () => {
      const auth: MCPAuthResult = {
        userId: 'u1',
        role: 'user',
        tokenVersion: 1,
        adminRoleVersion: 1,
        tokenType: 'mcp',
        tokenId: 't1',
        allowedDriveIds: ['d1', 'd3'],
      };
      expect(filterDrivesByMCPScope(auth, ['d1', 'd2', 'd3', 'd4'])).toEqual(['d1', 'd3']);
    });

    it('should return all drives for session auth', () => {
      const auth: SessionAuthResult = {
        userId: 'u1',
        role: 'user',
        tokenVersion: 1,
        adminRoleVersion: 1,
        tokenType: 'session',
        sessionId: 's1',
      };
      expect(filterDrivesByMCPScope(auth, ['d1', 'd2'])).toEqual(['d1', 'd2']);
    });

    it('should return all drives for unscoped MCP token', () => {
      const auth: MCPAuthResult = {
        userId: 'u1',
        role: 'user',
        tokenVersion: 1,
        adminRoleVersion: 1,
        tokenType: 'mcp',
        tokenId: 't1',
        allowedDriveIds: [],
      };
      expect(filterDrivesByMCPScope(auth, ['d1', 'd2'])).toEqual(['d1', 'd2']);
    });
  });

  describe('checkMCPCreateScope', () => {
    const scopedMcp: MCPAuthResult = {
      userId: 'u1',
      role: 'user',
      tokenVersion: 1,
      adminRoleVersion: 1,
      tokenType: 'mcp',
      tokenId: 't1',
      allowedDriveIds: ['d1'],
    };

    it('should return null for unscoped token', () => {
      const unscoped: MCPAuthResult = { ...scopedMcp, allowedDriveIds: [] };
      expect(checkMCPCreateScope(unscoped, null)).toBeNull();
      expect(checkMCPCreateScope(unscoped, 'd99')).toBeNull();
    });

    it('should return 403 when scoped token tries to create a new drive', () => {
      const result = checkMCPCreateScope(scopedMcp, null);
      expect(result?.status).toBe(403);
    });

    it('should return 403 when target drive not in scope', () => {
      const result = checkMCPCreateScope(scopedMcp, 'd99');
      expect(result?.status).toBe(403);
    });

    it('should return null when target drive is in scope', () => {
      expect(checkMCPCreateScope(scopedMcp, 'd1')).toBeNull();
    });
  });

  // ---- Token Validation ----

  describe('validateMCPToken', () => {
    it('should return null for empty token', async () => {
      expect(await validateMCPToken('')).toBeNull();
    });

    it('should return null for token without mcp_ prefix', async () => {
      expect(await validateMCPToken('not_an_mcp_token')).toBeNull();
    });

    it('should return null when token not found in DB', async () => {
      vi.mocked(db.query.mcpTokens.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      expect(await validateMCPToken('mcp_test123')).toBeNull();
    });

    it('should return null for suspended user and revoke token', async () => {
      vi.mocked(db.query.mcpTokens.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 't1',
        userId: 'u1',
        isScoped: false,
        user: {
          id: 'u1',
          role: 'user',
          tokenVersion: 1,
          adminRoleVersion: 1,
          suspendedAt: new Date(),
        },
        driveScopes: [],
      });
      const updateSet = vi.fn(() => ({ where: vi.fn() }));
      vi.mocked(db.update).mockReturnValue({ set: updateSet } as any);

      const result = await validateMCPToken('mcp_test123');
      expect(result).toBeNull();
      expect(db.update).toHaveBeenCalled();
    });

    it('should return null for scoped token with no remaining drives (fail-closed)', async () => {
      vi.mocked(db.query.mcpTokens.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 't1',
        userId: 'u1',
        isScoped: true,
        user: {
          id: 'u1',
          role: 'user',
          tokenVersion: 1,
          adminRoleVersion: 1,
          suspendedAt: null,
        },
        driveScopes: [],
      });

      expect(await validateMCPToken('mcp_test123')).toBeNull();
    });

    it('should return auth details for valid token', async () => {
      const updateSet = vi.fn(() => ({ where: vi.fn() }));
      vi.mocked(db.update).mockReturnValue({ set: updateSet } as any);
      vi.mocked(db.query.mcpTokens.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 't1',
        userId: 'u1',
        isScoped: true,
        user: {
          id: 'u1',
          role: 'admin',
          tokenVersion: 3,
          adminRoleVersion: 2,
          suspendedAt: null,
        },
        driveScopes: [{ driveId: 'd1' }, { driveId: 'd2' }],
      });

      const result = await validateMCPToken('mcp_valid');
      expect(result).toEqual({
        userId: 'u1',
        role: 'admin',
        tokenVersion: 3,
        adminRoleVersion: 2,
        tokenId: 't1',
        allowedDriveIds: ['d1', 'd2'],
      });
    });
  });

  describe('validateSessionToken', () => {
    it('should return null for empty token', async () => {
      expect(await validateSessionToken('')).toBeNull();
    });

    it('should delegate to sessionService.validateSession', async () => {
      const claims = {
        userId: 'u1',
        userRole: 'user',
        tokenVersion: 1,
        adminRoleVersion: 1,
        sessionId: 's1',
      };
      vi.mocked(sessionService.validateSession).mockResolvedValue(claims as any);
      const result = await validateSessionToken('ps_sess_abc');
      expect(result).toEqual(claims);
    });

    it('should return null on error', async () => {
      vi.mocked(sessionService.validateSession).mockRejectedValue(new Error('bad'));
      expect(await validateSessionToken('ps_sess_abc')).toBeNull();
    });
  });

  // ---- Request Authentication ----

  describe('authenticateMCPRequest', () => {
    it('should return error when no bearer token', async () => {
      const req = new Request('http://localhost/api', { method: 'GET' });
      const result = await authenticateMCPRequest(req);
      expect(isAuthError(result)).toBe(true);
    });

    it('should return error for non-MCP bearer token', async () => {
      const req = new Request('http://localhost/api', {
        method: 'GET',
        headers: { authorization: 'Bearer ps_sess_123' },
      });
      const result = await authenticateMCPRequest(req);
      expect(isAuthError(result)).toBe(true);
    });
  });

  describe('authenticateSessionRequest', () => {
    it('should reject MCP tokens sent as bearer', async () => {
      const req = new Request('http://localhost/api', {
        method: 'GET',
        headers: { authorization: 'Bearer mcp_token123' },
      });
      const result = await authenticateSessionRequest(req);
      expect(isAuthError(result)).toBe(true);
    });

    it('should reject unknown bearer token format', async () => {
      const req = new Request('http://localhost/api', {
        method: 'GET',
        headers: { authorization: 'Bearer unknown_format' },
      });
      const result = await authenticateSessionRequest(req);
      expect(isAuthError(result)).toBe(true);
    });

    it('should authenticate via session cookie when no bearer token', async () => {
      vi.mocked(getSessionFromCookies).mockReturnValue('ps_sess_cookie123');
      vi.mocked(sessionService.validateSession).mockResolvedValue({
        userId: 'u1',
        userRole: 'user',
        tokenVersion: 1,
        adminRoleVersion: 1,
        sessionId: 's1',
      } as any);

      const req = new Request('http://localhost/api', {
        method: 'GET',
        headers: { cookie: 'session=abc' },
      });
      const result = await authenticateSessionRequest(req);
      expect(isAuthError(result)).toBe(false);
      if (!isAuthError(result)) {
        expect(result.tokenType).toBe('session');
        expect(result.userId).toBe('u1');
      }
    });

    it('should return error when no cookie and no bearer', async () => {
      vi.mocked(getSessionFromCookies).mockReturnValue(null);
      const req = new Request('http://localhost/api', { method: 'GET' });
      const result = await authenticateSessionRequest(req);
      expect(isAuthError(result)).toBe(true);
    });

    it('should authenticate via bearer session token', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue({
        userId: 'u1',
        userRole: 'user',
        tokenVersion: 1,
        adminRoleVersion: 1,
        sessionId: 's1',
      } as any);

      const req = new Request('http://localhost/api', {
        method: 'GET',
        headers: { authorization: 'Bearer ps_sess_mobile123' },
      });
      const result = await authenticateSessionRequest(req);
      expect(isAuthError(result)).toBe(false);
      if (!isAuthError(result)) {
        expect(result.tokenType).toBe('session');
      }
    });
  });

  describe('authenticateRequestWithOptions', () => {
    it('should return error when no auth methods allowed', async () => {
      const req = new Request('http://localhost/api', { method: 'GET' });
      const result = await authenticateRequestWithOptions(req, { allow: [] });
      expect(isAuthError(result)).toBe(true);
    });

    it('should reject MCP token when only session is allowed', async () => {
      const req = new Request('http://localhost/api', {
        method: 'GET',
        headers: { authorization: 'Bearer mcp_token123' },
      });
      const result = await authenticateRequestWithOptions(req, { allow: ['session'] });
      expect(isAuthError(result)).toBe(true);
    });

    it('should route MCP tokens to MCP auth when allowed', async () => {
      vi.mocked(db.query.mcpTokens.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const req = new Request('http://localhost/api', {
        method: 'GET',
        headers: { authorization: 'Bearer mcp_token123' },
      });
      const result = await authenticateRequestWithOptions(req, { allow: ['mcp', 'session'] });
      // MCP token validation fails (no DB record), so returns error
      expect(isAuthError(result)).toBe(true);
    });
  });
});
