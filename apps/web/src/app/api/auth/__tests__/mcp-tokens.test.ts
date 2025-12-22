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
        findFirst: vi.fn().mockResolvedValue({ id: 'token-123', name: 'Test Token' }),
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

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ email: 'test@example.com' }),
  logTokenActivity: vi.fn(),
}));

import { db } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

describe('/api/auth/mcp-tokens', () => {
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
  });

  describe('POST /api/auth/mcp-tokens', () => {
    describe('successful token creation', () => {
      it('returns 200 with new token data', async () => {
        // Arrange - capture the values passed to insert
        let capturedValues: Record<string, unknown> | undefined;
        const mockValues = vi.fn().mockImplementation((vals) => {
          capturedValues = vals;
          return {
            returning: vi.fn().mockResolvedValue([
              {
                id: 'new-mcp-token-id',
                name: vals.name,
                token: vals.token,
                createdAt: new Date(),
              },
            ]),
          };
        });
        (db.insert as unknown as Mock).mockReturnValue({ values: mockValues });

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

        // Assert - verify response matches input
        expect(response.status).toBe(200);
        expect(body.id).toBe('new-mcp-token-id');
        expect(body.name).toBe('My API Token'); // Should match input, not hardcoded mock
        expect(body.token).toMatch(/^mcp_/); // Token should have mcp_ prefix
        expect(body.createdAt).toBeDefined();

        // Assert - verify correct values were passed to insert
        expect(capturedValues).toBeDefined();
        expect(capturedValues!.name).toBe('My API Token');
        expect(capturedValues!.userId).toBe('test-user-id');
      });

      it('generates token with mcp_ prefix', async () => {
        // Arrange - capture the token value
        let capturedToken: string | undefined;
        const mockValues = vi.fn().mockImplementation((vals) => {
          capturedToken = vals.token;
          return {
            returning: vi.fn().mockResolvedValue([
              { id: 'id', name: vals.name, token: vals.token, createdAt: new Date() },
            ]),
          };
        });
        (db.insert as Mock).mockReturnValue({ values: mockValues });

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

        // Assert - verify token has mcp_ prefix
        expect(db.insert).toHaveBeenCalled();
        expect(capturedToken).toBeDefined();
        expect(capturedToken).toMatch(/^mcp_/);
      });

      it('associates token with authenticated user', async () => {
        // Arrange - capture userId
        let capturedUserId: string | undefined;
        const mockValues = vi.fn().mockImplementation((vals) => {
          capturedUserId = vals.userId;
          return {
            returning: vi.fn().mockResolvedValue([
              { id: 'id', name: vals.name, token: vals.token, createdAt: new Date() },
            ]),
          };
        });
        (db.insert as Mock).mockReturnValue({ values: mockValues });

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

        // Assert - verify token is associated with authenticated user
        expect(db.insert).toHaveBeenCalled();
        expect(capturedUserId).toBe('test-user-id');
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
        (authenticateRequestWithOptions as unknown as Mock).mockResolvedValue(mockError);
        (isAuthError as unknown as Mock).mockReturnValue(true);

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
      (db.query.mcpTokens.findMany as unknown as Mock).mockResolvedValue([
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
        // Arrange - capture the values passed to set()
        let capturedSetValues: Record<string, unknown> | undefined;
        const mockSet = vi.fn().mockImplementation((vals) => {
          capturedSetValues = vals;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: 'token-123' }]),
            }),
          };
        });
        (db.update as unknown as Mock).mockReturnValue({ set: mockSet });

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

        // Assert - verify update was called and revokedAt was set to a non-null Date
        expect(db.update).toHaveBeenCalled();
        expect(mockSet).toHaveBeenCalled();
        expect(capturedSetValues).toBeDefined();
        expect(capturedSetValues!.revokedAt).toBeInstanceOf(Date);
      });
    });

    describe('token not found', () => {
      it('returns 404 when token does not exist', async () => {
        // Arrange - findFirst returns undefined when token doesn't exist
        (db.query.mcpTokens.findFirst as Mock).mockResolvedValueOnce(undefined);

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
        // Arrange - findFirst returns undefined when token doesn't match userId
        (db.query.mcpTokens.findFirst as Mock).mockResolvedValueOnce(undefined);

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
