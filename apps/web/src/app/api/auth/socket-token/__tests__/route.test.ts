import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Contract tests for GET /api/auth/socket-token
 *
 * Creates short-lived tokens for Socket.IO authentication.
 *
 * Contract:
 *   Request: GET with valid session cookie
 *   Response:
 *     200: { token: string, expiresAt: string } with no-cache headers
 *     401: Unauthorized (plain text) when auth fails
 *
 * Dependencies mocked at service seam:
 *   - @/lib/auth/auth-helpers: requireAuth, isAuthError
 *   - @pagespace/db: db.insert for token storage
 *   - crypto is NOT mocked (pure utility, real implementation used)
 */

// @scaffold - ORM chain mocks (db.insert().values())
const mockInsertValues = vi.fn().mockResolvedValue(undefined);
const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

vi.mock('@/lib/auth/auth-helpers', () => ({
  requireAuth: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
  },
  socketTokens: Symbol('socketTokens'),
}));

import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';
import { socketTokens } from '@pagespace/db';
import { GET } from '../route';

describe('/api/auth/socket-token', () => {
  const mockAuthUser = {
    userId: 'test-user-id',
    role: 'user' as const,
    sessionId: 'test-session-id',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T10:00:00.000Z'));

    // Default: authenticated user
    vi.mocked(requireAuth).mockResolvedValue(mockAuthUser as never);
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('successful token creation', () => {
    it('GET_withValidSession_returns200WithTokenAndExpiry', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/socket-token', {
        method: 'GET',
        headers: { Cookie: 'session=valid-token' },
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(200);
      expect(body.token).toMatch(/^ps_sock_/);
      expect(body.expiresAt).toBe(
        new Date(Date.now() + 5 * 60 * 1000).toISOString()
      );
    });

    it('GET_withValidSession_insertsHashedTokenInDB', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/socket-token', {
        method: 'GET',
        headers: { Cookie: 'session=valid-token' },
      });

      // Act
      await GET(request);

      // Assert: token hash is stored (not the plaintext token)
      expect(mockInsert).toHaveBeenCalledWith(socketTokens);
      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'test-user-id',
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        })
      );
      // The stored hash should be a hex string (SHA-256 output), not the token itself
      const storedValues = mockInsertValues.mock.calls[0][0];
      expect(storedValues.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('GET_withValidSession_storesHashNotPlaintext', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/socket-token', {
        method: 'GET',
        headers: { Cookie: 'session=valid-token' },
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert: the stored hash differs from the returned token
      const storedValues = mockInsertValues.mock.calls[0][0];
      expect(storedValues.tokenHash).not.toBe(body.token);
    });

    it('GET_withValidSession_setsCacheControlHeaders', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/socket-token', {
        method: 'GET',
        headers: { Cookie: 'session=valid-token' },
      });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.headers.get('Cache-Control')).toBe(
        'no-store, no-cache, must-revalidate'
      );
      expect(response.headers.get('Vary')).toBe('Cookie');
    });

    it('GET_withValidSession_callsRequireAuth', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/socket-token', {
        method: 'GET',
        headers: { Cookie: 'session=valid-token' },
      });

      // Act
      await GET(request);

      // Assert
      expect(requireAuth).toHaveBeenCalledWith(request);
    });
  });

  describe('authentication errors', () => {
    it('GET_withoutAuth_returns401', async () => {
      // Arrange: requireAuth returns a NextResponse error
      const unauthorizedResponse = new Response('Unauthorized', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      });
      vi.mocked(requireAuth).mockResolvedValue(unauthorizedResponse as never);
      vi.mocked(isAuthError).mockReturnValue(true);

      const request = new Request('http://localhost/api/auth/socket-token', {
        method: 'GET',
      });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(401);
    });

    it('GET_withInvalidSession_returns401AndSkipsInsert', async () => {
      // Arrange: requireAuth returns an auth error response
      const unauthorizedResponse = new Response('Unauthorized', {
        status: 401,
        headers: { 'Content-Type': 'text/plain' },
      });
      vi.mocked(requireAuth).mockResolvedValue(unauthorizedResponse as never);
      vi.mocked(isAuthError).mockReturnValue(true);

      const request = new Request('http://localhost/api/auth/socket-token', {
        method: 'GET',
        headers: { Cookie: 'session=invalid-token' },
      });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(401);
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });
});
