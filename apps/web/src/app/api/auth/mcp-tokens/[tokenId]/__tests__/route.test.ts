import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock @/lib/auth
const { mockAuthenticateRequest, mockIsAuthError } = vi.hoisted(() => ({
  mockAuthenticateRequest: vi.fn(),
  mockIsAuthError: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: mockAuthenticateRequest,
  isAuthError: mockIsAuthError,
}));

// Mock @pagespace/db
const { mockDbUpdateReturning } = vi.hoisted(() => ({
  mockDbUpdateReturning: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: mockDbUpdateReturning,
        })),
      })),
    })),
  },
  mcpTokens: {},
  eq: vi.fn(),
  and: vi.fn(),
}));

// Mock @pagespace/lib/server
const { mockLoggerError } = vi.hoisted(() => ({
  mockLoggerError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      error: mockLoggerError,
    },
  },
}));

// Import after mocks
import { DELETE } from '../route';

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string): WebAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create DELETE request
const createDeleteRequest = (tokenId: string, headers?: Record<string, string>) => {
  return new NextRequest(`https://example.com/api/auth/mcp-tokens/${tokenId}`, {
    method: 'DELETE',
    headers: {
      ...headers,
    },
  });
};

describe('DELETE /api/auth/mcp-tokens/[tokenId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default auth success
    mockAuthenticateRequest.mockResolvedValue(mockWebAuth('user_123'));
    mockIsAuthError.mockReturnValue(false);

    // Default successful revocation
    mockDbUpdateReturning.mockResolvedValue([{ id: 'token_123' }]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication', () => {
    it('should return 401 when not authenticated', async () => {
      mockIsAuthError.mockReturnValue(true);
      mockAuthenticateRequest.mockResolvedValue(mockAuthError(401));

      const request = createDeleteRequest('token_123');
      const context = { params: Promise.resolve({ tokenId: 'token_123' }) };
      const response = await DELETE(request, context);

      expect(response.status).toBe(401);
    });

    it('should require CSRF token', async () => {
      const request = createDeleteRequest('token_123');
      const context = { params: Promise.resolve({ tokenId: 'token_123' }) };
      await DELETE(request, context);

      expect(mockAuthenticateRequest).toHaveBeenCalledWith(
        request,
        { allow: ['jwt'], requireCSRF: true }
      );
    });
  });

  describe('Token Revocation', () => {
    it('should return 200 on successful revocation', async () => {
      const request = createDeleteRequest('token_123');
      const context = { params: Promise.resolve({ tokenId: 'token_123' }) };
      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.message).toBe('Token revoked successfully');
    });

    it('should return 404 when token not found', async () => {
      mockDbUpdateReturning.mockResolvedValue([]);

      const request = createDeleteRequest('nonexistent_token');
      const context = { params: Promise.resolve({ tokenId: 'nonexistent_token' }) };
      const response = await DELETE(request, context);

      expect(response.status).toBe(404);
    });

    it('should return 404 when token belongs to another user', async () => {
      // No token returned means token doesn't belong to user or doesn't exist
      mockDbUpdateReturning.mockResolvedValue([]);

      const request = createDeleteRequest('other_users_token');
      const context = { params: Promise.resolve({ tokenId: 'other_users_token' }) };
      const response = await DELETE(request, context);

      expect(response.status).toBe(404);
    });
  });

  describe('Error Handling', () => {
    it('should return 500 on database error', async () => {
      mockDbUpdateReturning.mockRejectedValue(new Error('Database error'));

      const request = createDeleteRequest('token_123');
      const context = { params: Promise.resolve({ tokenId: 'token_123' }) };
      const response = await DELETE(request, context);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to revoke MCP token');
    });

    it('should log error on failure', async () => {
      mockDbUpdateReturning.mockRejectedValue(new Error('Database error'));

      const request = createDeleteRequest('token_123');
      const context = { params: Promise.resolve({ tokenId: 'token_123' }) };
      await DELETE(request, context);

      expect(mockLoggerError).toHaveBeenCalled();
    });
  });

  describe('Next.js 15 Async Params', () => {
    it('should await params before destructuring', async () => {
      const request = createDeleteRequest('async_token_123');
      const paramsPromise = Promise.resolve({ tokenId: 'async_token_123' });
      const context = { params: paramsPromise };

      const response = await DELETE(request, context);

      expect(response.status).toBe(200);
    });
  });
});
