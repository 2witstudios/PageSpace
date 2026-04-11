import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, POST } from '../mcp-tokens/route';
import { DELETE } from '../mcp-tokens/[tokenId]/route';
import { NextRequest } from 'next/server';

// Mock dependencies
vi.mock('@/lib/repositories/session-repository', () => ({
  sessionRepository: {
    createMcpTokenWithDriveScopes: vi.fn(),
    findDrivesByIds: vi.fn(),
    findUserMcpTokensWithDrives: vi.fn(),
    findMcpTokenByIdAndUser: vi.fn(),
    revokeMcpToken: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
    },
    security: {
      warn: vi.fn(),
    },
  },
  securityAudit: {
    logAuthSuccess: vi.fn().mockResolvedValue(undefined),
    logAuthFailure: vi.fn().mockResolvedValue(undefined),
    logTokenCreated: vi.fn().mockResolvedValue(undefined),
    logTokenRevoked: vi.fn().mockResolvedValue(undefined),
    logDataAccess: vi.fn().mockResolvedValue(undefined),
    logEvent: vi.fn().mockResolvedValue(undefined),
    logLogout: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@pagespace/lib/auth', () => ({
  generateToken: vi.fn().mockReturnValue({
    token: 'mcp_randomBase64UrlString',
    hash: 'mockTokenHash123',
    tokenPrefix: 'mcp_randomBas',
  }),
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com' }),
  logTokenActivity: vi.fn(),
}));

vi.mock('@pagespace/lib/services/drive-service', () => ({
  getDriveAccess: vi.fn().mockResolvedValue({
    isOwner: true,
    isAdmin: true,
    isMember: true,
    role: 'OWNER',
  }),
  listAccessibleDrives: vi.fn().mockResolvedValue([]),
}));

import { sessionRepository } from '@/lib/repositories/session-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { logTokenActivity } from '@pagespace/lib/monitoring/activity-logger';

describe('/api/auth/mcp-tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
      userId: 'test-user-id',
      role: 'user',
      tokenVersion: 0,
      tokenType: 'session',
      sessionId: 'test-session-id',
    } as never);
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default repository mocks
    vi.mocked(sessionRepository.createMcpTokenWithDriveScopes).mockResolvedValue({
      id: 'new-mcp-token-id',
      name: 'Test Token',
      createdAt: new Date(),
    } as never);
    vi.mocked(sessionRepository.findDrivesByIds).mockResolvedValue([]);
    vi.mocked(sessionRepository.findUserMcpTokensWithDrives).mockResolvedValue([]);
    vi.mocked(sessionRepository.findMcpTokenByIdAndUser).mockResolvedValue({
      id: 'token-123',
      name: 'Test Token',
    } as never);
    vi.mocked(sessionRepository.revokeMcpToken).mockResolvedValue(undefined);
  });

  describe('POST /api/auth/mcp-tokens', () => {
    describe('successful token creation', () => {
      it('returns 200 with new token data', async () => {
        // Arrange
        vi.mocked(sessionRepository.createMcpTokenWithDriveScopes).mockResolvedValue({
          id: 'new-mcp-token-id',
          name: 'My API Token',
          createdAt: new Date(),
        } as never);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'ps_session=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({ name: 'My API Token' }),
        });

        // Act
        const response = await POST(request);
        const body = await response.json();

        // Assert - verify response matches input
        expect(response.status).toBe(200);
        expect(body.id).toBe('new-mcp-token-id');
        expect(body.name).toBe('My API Token');
        expect(body.token).toBe('mcp_randomBase64UrlString');
        expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        // Assert - verify repository was called with correct params
        expect(sessionRepository.createMcpTokenWithDriveScopes).toHaveBeenCalledWith({
          name: 'My API Token',
          userId: 'test-user-id',
          tokenHash: 'mockTokenHash123',
          tokenPrefix: 'mcp_randomBas',
          isScoped: false,
          driveIds: [],
        });

        // Assert - verify activity logging for token creation (boundary contract)
        expect(logTokenActivity).toHaveBeenCalledWith(
          'test-user-id',
          'token_create',
          {
            tokenId: 'new-mcp-token-id',
            tokenType: 'mcp',
            tokenName: 'My API Token',
          },
          { actorEmail: 'test@example.com' }
        );
      });

      it('generates token with mcp_ prefix', async () => {
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'ps_session=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({ name: 'My Token' }),
        });

        // Act
        const response = await POST(request);
        const body = await response.json();

        // Assert - verify RESPONSE token has mcp_ prefix (DB stores hash, response returns raw token)
        expect(sessionRepository.createMcpTokenWithDriveScopes).toHaveBeenCalledWith({
          name: 'My Token',
          userId: 'test-user-id',
          tokenHash: 'mockTokenHash123',
          tokenPrefix: 'mcp_randomBas',
          isScoped: false,
          driveIds: [],
        });
        expect(body.token).toBe('mcp_randomBase64UrlString');
      });

      it('associates token with authenticated user', async () => {
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'ps_session=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({ name: 'My Token' }),
        });

        // Act
        await POST(request);

        // Assert - verify token is associated with authenticated user
        expect(sessionRepository.createMcpTokenWithDriveScopes).toHaveBeenCalledWith({
          name: 'My Token',
          userId: 'test-user-id',
          tokenHash: 'mockTokenHash123',
          tokenPrefix: 'mcp_randomBas',
          isScoped: false,
          driveIds: [],
        });
      });
    });

    describe('input validation', () => {
      it('returns 400 for missing name', async () => {
        // Arrange
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'ps_session=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({}),
        });

        // Act
        const response = await POST(request);
        const body = await response.json();

        // Assert
        expect(response.status).toBe(400);
        expect(body.error).toHaveLength(1);
        expect(body.error[0].path).toEqual(['name']);
        expect(body.error[0].message).toMatch(/string/i);
      });

      it('returns 400 for empty name', async () => {
        // Arrange
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'ps_session=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({ name: '' }),
        });

        // Act
        const response = await POST(request);
        const body = await response.json();

        // Assert
        expect(response.status).toBe(400);
        expect(body.error).toHaveLength(1);
        expect(body.error[0].path).toEqual(['name']);
        expect(body.error[0].message).toBe('Too small: expected string to have >=1 characters');
      });

      it('returns 400 for name exceeding 100 characters', async () => {
        // Arrange
        const longName = 'a'.repeat(101);
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'ps_session=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({ name: longName }),
        });

        // Act
        const response = await POST(request);
        const body = await response.json();

        // Assert
        expect(response.status).toBe(400);
        expect(body.error).toHaveLength(1);
        expect(body.error[0].path).toEqual(['name']);
        expect(body.error[0].message).toBe('Too big: expected string to have <=100 characters');
      });
    });

    describe('authentication', () => {
      it('returns 401 when not authenticated', async () => {
        // Arrange
        const mockError = {
          error: Response.json({ error: 'Unauthorized' }, { status: 401 }),
        };
        vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockError as never);
        vi.mocked(isAuthError).mockReturnValue(true);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'My Token' }),
        });

        // Act
        const response = await POST(request);

        // Assert
        expect(response.status).toBe(401);
      });

      it('requires CSRF token for write operations', async () => {
        // Arrange
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'ps_session=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({ name: 'My Token' }),
        });

        // Act
        await POST(request);

        // Assert
        expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
          request,
          { allow: ['session'], requireCSRF: true }
        );
      });
    });
  });

  describe('GET /api/auth/mcp-tokens', () => {
    beforeEach(() => {
      vi.mocked(sessionRepository.findUserMcpTokensWithDrives).mockResolvedValue([
        {
          id: 'token-1',
          name: 'Token 1',
          lastUsed: new Date(),
          createdAt: new Date(),
          isScoped: false,
          driveScopes: [{ id: 'drive-1', name: 'Work Drive' }],
        },
        {
          id: 'token-2',
          name: 'Token 2',
          lastUsed: null,
          createdAt: new Date(),
          isScoped: false,
          driveScopes: [],
        },
      ] as never);
    });

    describe('successful listing', () => {
      it('returns 200 with list of tokens', async () => {
        // Arrange
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'GET',
          headers: {
            Cookie: 'ps_session=valid-token',
          },
        });

        // Act
        const response = await GET(request);
        const body = await response.json();

        // Assert
        expect(response.status).toBe(200);
        expect(Array.isArray(body)).toBe(true);
        expect(body.length).toBe(2);
      });

      it('does not expose actual token values', async () => {
        // Arrange
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'GET',
          headers: {
            Cookie: 'ps_session=valid-token',
          },
        });

        // Act
        const response = await GET(request);
        const body = await response.json();

        // Assert - verify token is either absent or masked (not a real mcp_ token)
        body.forEach((token: { token?: string }) => {
          // Token should either be undefined OR not match the real token pattern
          if (token.token !== undefined) {
            // If present, it should be masked/preview, not a real mcp_ token
            expect(token.token).not.toMatch(/^mcp_[A-Za-z0-9]{20,}$/);
          }
        });
      });

      it('includes lastUsed and createdAt timestamps', async () => {
        // Arrange
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'GET',
          headers: {
            Cookie: 'ps_session=valid-token',
          },
        });

        // Act
        const response = await GET(request);
        const body = await response.json();

        // Assert
        expect(body[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(body[0].lastUsed).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      });
    });

    describe('empty list', () => {
      it('returns empty array when user has no tokens', async () => {
        // Arrange
        vi.mocked(sessionRepository.findUserMcpTokensWithDrives).mockResolvedValue([]);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'GET',
          headers: {
            Cookie: 'ps_session=valid-token',
          },
        });

        // Act
        const response = await GET(request);
        const body = await response.json();

        // Assert
        expect(response.status).toBe(200);
        expect(body).toEqual([]);
      });
    });

    describe('authentication', () => {
      it('does not require CSRF token for read operations', async () => {
        // Arrange
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'GET',
          headers: {
            Cookie: 'ps_session=valid-token',
          },
        });

        // Act
        await GET(request);

        // Assert
        expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
          request,
          { allow: ['session'], requireCSRF: false }
        );
      });
    });
  });

  describe('DELETE /api/auth/mcp-tokens/[tokenId]', () => {
    describe('successful revocation', () => {
      it('returns 200 on successful token revocation', async () => {
        // Arrange
        const request = new NextRequest(
          'http://localhost/api/auth/mcp-tokens/token-123',
          {
            method: 'DELETE',
            headers: {
              Cookie: 'ps_session=valid-token',
              'X-CSRF-Token': 'valid-csrf-token',
            },
          }
        );
        const context = { params: Promise.resolve({ tokenId: 'token-123' }) };

        // Act
        const response = await DELETE(request, context);
        const body = await response.json();

        // Assert
        expect(response.status).toBe(200);
        expect(body.message).toBe('Token revoked successfully');

        // Assert - verify activity logging for token revocation (boundary contract)
        expect(logTokenActivity).toHaveBeenCalledWith(
          'test-user-id',
          'token_revoke',
          {
            tokenId: 'token-123',
            tokenType: 'mcp',
            tokenName: 'Test Token',
          },
          { actorEmail: 'test@example.com' }
        );
      });

      it('calls revokeMcpToken to revoke the token', async () => {
        // Arrange
        const request = new NextRequest(
          'http://localhost/api/auth/mcp-tokens/token-123',
          {
            method: 'DELETE',
            headers: {
              Cookie: 'ps_session=valid-token',
              'X-CSRF-Token': 'valid-csrf-token',
            },
          }
        );
        const context = { params: Promise.resolve({ tokenId: 'token-123' }) };

        // Act
        await DELETE(request, context);

        // Assert - verify revokeMcpToken was called with the correct args
        expect(sessionRepository.revokeMcpToken).toHaveBeenCalledWith('token-123', 'test-user-id');
      });
    });

    describe('token not found', () => {
      it('returns 404 when token does not exist', async () => {
        // Arrange - findMcpTokenByIdAndUser returns null when token doesn't exist
        vi.mocked(sessionRepository.findMcpTokenByIdAndUser).mockResolvedValueOnce(null);

        const request = new NextRequest(
          'http://localhost/api/auth/mcp-tokens/nonexistent-token',
          {
            method: 'DELETE',
            headers: {
              Cookie: 'ps_session=valid-token',
              'X-CSRF-Token': 'valid-csrf-token',
            },
          }
        );
        const context = { params: Promise.resolve({ tokenId: 'nonexistent-token' }) };

        // Act
        const response = await DELETE(request, context);

        // Assert
        expect(response.status).toBe(404);
      });

      it('returns 404 when token belongs to different user', async () => {
        // Arrange - findMcpTokenByIdAndUser returns null when token doesn't match userId
        vi.mocked(sessionRepository.findMcpTokenByIdAndUser).mockResolvedValueOnce(null);

        const request = new NextRequest(
          'http://localhost/api/auth/mcp-tokens/other-user-token',
          {
            method: 'DELETE',
            headers: {
              Cookie: 'ps_session=valid-token',
              'X-CSRF-Token': 'valid-csrf-token',
            },
          }
        );
        const context = { params: Promise.resolve({ tokenId: 'other-user-token' }) };

        // Act
        const response = await DELETE(request, context);

        // Assert
        expect(response.status).toBe(404);
      });
    });

    describe('authentication', () => {
      it('requires CSRF token for delete operations', async () => {
        // Arrange
        const request = new NextRequest(
          'http://localhost/api/auth/mcp-tokens/token-123',
          {
            method: 'DELETE',
            headers: {
              Cookie: 'ps_session=valid-token',
              'X-CSRF-Token': 'valid-csrf-token',
            },
          }
        );
        const context = { params: Promise.resolve({ tokenId: 'token-123' }) };

        // Act
        await DELETE(request, context);

        // Assert
        expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
          request,
          { allow: ['session'], requireCSRF: true }
        );
      });
    });
  });
});
