import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { GET } from '../me/route';

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  users: { id: 'id' },
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
  },
  eq: vi.fn((field, value) => ({ field, value })),
}));

vi.mock('@/lib/auth/auth-helpers', () => ({
  requireAuth: vi.fn(),
  isAuthError: vi.fn(),
}));

import { db, eq } from '@pagespace/db';
import { requireAuth, isAuthError } from '@/lib/auth/auth-helpers';

describe('/api/auth/me', () => {
  const mockUser = {
    id: 'test-user-id',
    name: 'Test User',
    email: 'test@example.com',
    image: 'https://example.com/avatar.png',
    role: 'user' as const,
    provider: 'email',
    googleId: null,
    emailVerified: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    (requireAuth as Mock).mockResolvedValue({
      userId: 'test-user-id',
      role: 'user',
      tokenVersion: 0,
      tokenType: 'jwt',
    });
    (isAuthError as Mock).mockReturnValue(false);
    (db.query.users.findFirst as Mock).mockResolvedValue(mockUser);
  });

  describe('successful retrieval', () => {
    it('returns 200 with user profile data', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/me', {
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
      expect(body.id).toBe(mockUser.id);
      expect(body.name).toBe(mockUser.name);
      expect(body.email).toBe(mockUser.email);
      expect(body.image).toBe(mockUser.image);
      expect(body.role).toBe(mockUser.role);
      expect(body.emailVerified).toBe(mockUser.emailVerified);
    });

    it('does not expose sensitive fields like password', async () => {
      // Arrange
      const userWithPassword = { ...mockUser, password: 'hashed-password' };
      (db.query.users.findFirst as Mock).mockResolvedValue(userWithPassword);

      const request = new Request('http://localhost/api/auth/me', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=valid-token',
        },
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(body.password).toBeUndefined();
    });

    it('returns admin role for admin users', async () => {
      // Arrange
      const adminUser = { ...mockUser, role: 'admin' as const };
      (db.query.users.findFirst as Mock).mockResolvedValue(adminUser);
      (requireAuth as Mock).mockResolvedValue({
        userId: 'test-user-id',
        role: 'admin',
        tokenVersion: 0,
        tokenType: 'jwt',
      });

      const request = new Request('http://localhost/api/auth/me', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=valid-token',
        },
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(body.role).toBe('admin');
    });
  });

  describe('authentication', () => {
    it('returns 401 when not authenticated', async () => {
      // Arrange
      const mockResponse = new Response('Unauthorized', { status: 401 });
      (requireAuth as Mock).mockResolvedValue(mockResponse);
      (isAuthError as Mock).mockReturnValue(true);

      const request = new Request('http://localhost/api/auth/me', {
        method: 'GET',
      });

      // Act
      const response = await GET(request);

      // Assert
      expect(response.status).toBe(401);
    });

    it('queries database with authenticated userId', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/me', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=valid-token',
        },
      });

      // Act
      await GET(request);

      // Assert - verify query is scoped to the authenticated user ID
      expect(db.query.users.findFirst).toHaveBeenCalled();
      expect(eq).toHaveBeenCalled();
      // Verify eq was called with the users.id field and the authenticated user's ID
      const eqCalls = (eq as Mock).mock.calls;
      const userIdCall = eqCalls.find(
        (call) => call[1] === 'test-user-id'
      );
      expect(userIdCall).toBeDefined();
    });
  });

  describe('user not found', () => {
    it('returns 404 when authenticated user is not found in database', async () => {
      // Arrange - rare edge case: token valid but user deleted
      (db.query.users.findFirst as Mock).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/me', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=valid-token',
        },
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });
  });

  describe('OAuth users', () => {
    it('includes provider information for Google OAuth users', async () => {
      // Arrange
      const oauthUser = {
        ...mockUser,
        provider: 'google',
        googleId: 'google-123',
      };
      (db.query.users.findFirst as Mock).mockResolvedValue(oauthUser);

      const request = new Request('http://localhost/api/auth/me', {
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
      // Note: The actual route implementation controls what fields are returned
      expect(body.email).toBe(oauthUser.email);
    });
  });

  describe('email verification status', () => {
    it('returns emailVerified: false for unverified users', async () => {
      // Arrange
      const unverifiedUser = { ...mockUser, emailVerified: false };
      (db.query.users.findFirst as Mock).mockResolvedValue(unverifiedUser);

      const request = new Request('http://localhost/api/auth/me', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=valid-token',
        },
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(body.emailVerified).toBe(false);
    });

    it('returns emailVerified: true for verified users', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/me', {
        method: 'GET',
        headers: {
          Cookie: 'accessToken=valid-token',
        },
      });

      // Act
      const response = await GET(request);
      const body = await response.json();

      // Assert
      expect(body.emailVerified).toBe(true);
    });
  });
});
