import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { GET, POST } from '../mcp-tokens/route';
import { DELETE } from '../mcp-tokens/[tokenId]/route';
import { NextRequest } from 'next/server';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          {
            id: 'new-mcp-token-id',
            name: 'Test Token',
            token: 'mcp_generated-token',
            createdAt: new Date(),
          },
        ]),
      }),
    }),
    query: {
      mcpTokens: {
        findMany: vi.fn(),
      },
    },
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'token-id' }]),
        }),
      }),
    }),
  },
  mcpTokens: {},
  eq: vi.fn((field, value) => ({ field, value })),
  and: vi.fn((...conditions) => conditions),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
    },
  },
}));

vi.mock('crypto', () => ({
  randomBytes: vi.fn().mockReturnValue({
    toString: vi.fn().mockReturnValue('randomBase64UrlString'),
  }),
}));

import { db } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

describe('/api/auth/mcp-tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    (authenticateRequestWithOptions as Mock).mockResolvedValue({
      userId: 'test-user-id',
      role: 'user',
      tokenVersion: 0,
      tokenType: 'jwt',
      source: 'cookie',
    });
    (isAuthError as Mock).mockReturnValue(false);
  });

  describe('POST /api/auth/mcp-tokens', () => {
    describe('successful token creation', () => {
      it('returns 200 with new token data', async () => {
        // Arrange
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'accessToken=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({ name: 'My API Token' }),
        });

        // Act
        const response = await POST(request);
        const body = await response.json();

        // Assert
        expect(response.status).toBe(200);
        expect(body.id).toBe('new-mcp-token-id');
        expect(body.name).toBe('Test Token');
        expect(body.token).toBe('mcp_generated-token');
        expect(body.createdAt).toBeDefined();
      });

      it('generates token with mcp_ prefix', async () => {
        // Arrange
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'accessToken=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({ name: 'My Token' }),
        });

        // Act
        await POST(request);

        // Assert
        expect(db.insert).toHaveBeenCalled();
      });

      it('associates token with authenticated user', async () => {
        // Arrange
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'accessToken=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({ name: 'My Token' }),
        });

        // Act
        await POST(request);

        // Assert
        expect(db.insert).toHaveBeenCalled();
      });
    });

    describe('input validation', () => {
      it('returns 400 for missing name', async () => {
        // Arrange
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'accessToken=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({}),
        });

        // Act
        const response = await POST(request);
        const body = await response.json();

        // Assert
        expect(response.status).toBe(400);
        expect(body.error).toBeDefined();
      });

      it('returns 400 for empty name', async () => {
        // Arrange
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'accessToken=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({ name: '' }),
        });

        // Act
        const response = await POST(request);
        const body = await response.json();

        // Assert
        expect(response.status).toBe(400);
        expect(body.error).toBeDefined();
      });

      it('returns 400 for name exceeding 100 characters', async () => {
        // Arrange
        const longName = 'a'.repeat(101);
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'accessToken=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({ name: longName }),
        });

        // Act
        const response = await POST(request);
        const body = await response.json();

        // Assert
        expect(response.status).toBe(400);
        expect(body.error).toBeDefined();
      });
    });

    describe('authentication', () => {
      it('returns 401 when not authenticated', async () => {
        // Arrange
        const mockError = {
          error: Response.json({ error: 'Unauthorized' }, { status: 401 }),
        };
        (authenticateRequestWithOptions as Mock).mockResolvedValue(mockError);
        (isAuthError as Mock).mockReturnValue(true);

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
            Cookie: 'accessToken=valid-token',
            'X-CSRF-Token': 'valid-csrf-token',
          },
          body: JSON.stringify({ name: 'My Token' }),
        });

        // Act
        await POST(request);

        // Assert
        expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
          request,
          expect.objectContaining({
            requireCSRF: true,
          })
        );
      });
    });
  });

  describe('GET /api/auth/mcp-tokens', () => {
    beforeEach(() => {
      (db.query.mcpTokens.findMany as Mock).mockResolvedValue([
        {
          id: 'token-1',
          name: 'Token 1',
          lastUsed: new Date(),
          createdAt: new Date(),
        },
        {
          id: 'token-2',
          name: 'Token 2',
          lastUsed: null,
          createdAt: new Date(),
        },
      ]);
    });

    describe('successful listing', () => {
      it('returns 200 with list of tokens', async () => {
        // Arrange
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'GET',
          headers: {
            Cookie: 'accessToken=valid-token',
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
            Cookie: 'accessToken=valid-token',
          },
        });

        // Act
        const response = await GET(request);
        const body = await response.json();

        // Assert
        body.forEach((token: { token?: string }) => {
          expect(token.token).toBeUndefined();
        });
      });

      it('includes lastUsed and createdAt timestamps', async () => {
        // Arrange
        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'GET',
          headers: {
            Cookie: 'accessToken=valid-token',
          },
        });

        // Act
        const response = await GET(request);
        const body = await response.json();

        // Assert
        expect(body[0].createdAt).toBeDefined();
        expect(body[0].lastUsed).toBeDefined();
      });
    });

    describe('empty list', () => {
      it('returns empty array when user has no tokens', async () => {
        // Arrange
        (db.query.mcpTokens.findMany as Mock).mockResolvedValue([]);

        const request = new NextRequest('http://localhost/api/auth/mcp-tokens', {
          method: 'GET',
          headers: {
            Cookie: 'accessToken=valid-token',
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
            Cookie: 'accessToken=valid-token',
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
              Cookie: 'accessToken=valid-token',
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
      });

      it('sets revokedAt timestamp instead of deleting', async () => {
        // Arrange
        const request = new NextRequest(
          'http://localhost/api/auth/mcp-tokens/token-123',
          {
            method: 'DELETE',
            headers: {
              Cookie: 'accessToken=valid-token',
              'X-CSRF-Token': 'valid-csrf-token',
            },
          }
        );
        const context = { params: Promise.resolve({ tokenId: 'token-123' }) };

        // Act
        await DELETE(request, context);

        // Assert
        expect(db.update).toHaveBeenCalled();
      });
    });

    describe('token not found', () => {
      it('returns 404 when token does not exist', async () => {
        // Arrange
        (db.update as Mock).mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          }),
        });

        const request = new NextRequest(
          'http://localhost/api/auth/mcp-tokens/nonexistent-token',
          {
            method: 'DELETE',
            headers: {
              Cookie: 'accessToken=valid-token',
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
        // Arrange - token exists but doesn't match userId
        (db.update as Mock).mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          }),
        });

        const request = new NextRequest(
          'http://localhost/api/auth/mcp-tokens/other-user-token',
          {
            method: 'DELETE',
            headers: {
              Cookie: 'accessToken=valid-token',
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
              Cookie: 'accessToken=valid-token',
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
          expect.objectContaining({
            requireCSRF: true,
          })
        );
      });
    });
  });
});
