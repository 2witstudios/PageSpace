/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET } from '../route';

// ============================================================================
// Contract Tests for /api/connections/search
//
// Tests GET handler for searching users by email to connect with.
// Uses verifyAuth instead of authenticateRequestWithOptions.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
  },
  users: { id: 'id', name: 'name', email: 'email', image: 'image' },
  userProfiles: {
    userId: 'userId',
    displayName: 'displayName',
    bio: 'bio',
    avatarUrl: 'avatarUrl',
  },
  connections: {
    user1Id: 'user1Id',
    user2Id: 'user2Id',
    status: 'status',
  },
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { verifyAuth } from '@/lib/auth';

const mockUser = (id: string) => ({ id, name: 'Test User' });

// ============================================================================
// GET /api/connections/search
// ============================================================================

describe('GET /api/connections/search', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue(mockUser(mockUserId) as any);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(verifyAuth).mockResolvedValue(null);

      const request = new Request('https://example.com/api/connections/search?email=test@test.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('no email provided', () => {
    it('should return null user when no email param', async () => {
      const request = new Request('https://example.com/api/connections/search');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.user).toBeNull();
    });
  });

  describe('self-search prevention', () => {
    it('should return error when searching for own email', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ email: 'me@test.com' }]),
            }),
          }),
        } as any);

      const request = new Request('https://example.com/api/connections/search?email=me@test.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.user).toBeNull();
      expect(body.error).toBe('Cannot connect with yourself');
    });
  });

  describe('user not found', () => {
    it('should return error when no user matches the email', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ email: 'me@test.com' }]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        } as any);

      const request = new Request('https://example.com/api/connections/search?email=unknown@test.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.user).toBeNull();
      expect(body.error).toBe('No user found with this email address');
    });
  });

  describe('existing connection checks', () => {
    const setupSearchMocks = (connectionStatus: string) => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ email: 'me@test.com' }]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{
                  id: 'user_456',
                  name: 'Other User',
                  email: 'other@test.com',
                  displayName: 'Other',
                  bio: null,
                  avatarUrl: null,
                }]),
              }),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ status: connectionStatus }]),
            }),
          }),
        } as any);
    };

    it('should return error when already connected', async () => {
      setupSearchMocks('ACCEPTED');

      const request = new Request('https://example.com/api/connections/search?email=other@test.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.user).toBeNull();
      expect(body.error).toBe('Already connected with this user');
    });

    it('should return error when connection is pending', async () => {
      setupSearchMocks('PENDING');

      const request = new Request('https://example.com/api/connections/search?email=other@test.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.user).toBeNull();
      expect(body.error).toBe('Connection request already pending');
    });

    it('should return error when connection is blocked', async () => {
      setupSearchMocks('BLOCKED');

      const request = new Request('https://example.com/api/connections/search?email=other@test.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.user).toBeNull();
      expect(body.error).toBe('Cannot send connection request to this user');
    });
  });

  describe('success', () => {
    it('should return user details when no existing connection', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ email: 'me@test.com' }]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{
                  id: 'user_456',
                  name: 'Other User',
                  email: 'other@test.com',
                  displayName: 'Other Display',
                  bio: 'A bio',
                  avatarUrl: 'https://example.com/avatar.jpg',
                }]),
              }),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        } as any);

      const request = new Request('https://example.com/api/connections/search?email=other@test.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.user).toMatchObject({
        id: 'user_456',
        name: 'Other User',
        email: 'other@test.com',
        displayName: 'Other Display',
        bio: 'A bio',
        avatarUrl: 'https://example.com/avatar.jpg',
      });
    });

    it('should use name as displayName fallback', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ email: 'me@test.com' }]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{
                  id: 'user_456',
                  name: 'Fallback Name',
                  email: 'other@test.com',
                  displayName: null,
                  bio: null,
                  avatarUrl: null,
                }]),
              }),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        } as any);

      const request = new Request('https://example.com/api/connections/search?email=other@test.com');
      const response = await GET(request);
      const body = await response.json();

      expect(body.user.displayName).toBe('Fallback Name');
    });
  });

  describe('error handling', () => {
    it('should return 500 when database operation fails', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockRejectedValue(new Error('DB error')),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/connections/search?email=test@test.com');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to search user');
    });

    it('should log error when operation fails', async () => {
      const error = new Error('DB error');
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockRejectedValue(error),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/connections/search?email=test@test.com');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error searching for user:', error);
    });
  });
});
