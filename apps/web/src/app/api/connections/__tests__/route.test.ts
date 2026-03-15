/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/connections
//
// Tests GET (list connections) and POST (send connection request) handlers.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
  connections: {
    id: 'id',
    user1Id: 'user1Id',
    user2Id: 'user2Id',
    status: 'status',
    requestedBy: 'requestedBy',
    requestedAt: 'requestedAt',
    acceptedAt: 'acceptedAt',
    requestMessage: 'requestMessage',
  },
  users: { id: 'id', name: 'name', email: 'email', image: 'image' },
  userProfiles: {
    userId: 'userId',
    username: 'username',
    displayName: 'displayName',
    bio: 'bio',
    avatarUrl: 'avatarUrl',
  },
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  isEmailVerified: vi.fn(),
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { createNotification, isEmailVerified } from '@pagespace/lib';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// ============================================================================
// GET /api/connections
// ============================================================================

describe('GET /api/connections', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/connections');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });

    it('should use session-only read auth options', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/connections');
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: false }
      );
    });
  });

  describe('success', () => {
    it('should return empty connections array when none exist', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/connections');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.connections).toEqual([]);
    });

    it('should return connections with user details', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockResolvedValue([
                {
                  id: 'conn_1',
                  status: 'ACCEPTED',
                  user1Id: 'user_123',
                  user2Id: 'user_456',
                  requestedBy: 'user_123',
                  requestedAt: new Date(),
                  acceptedAt: new Date(),
                  requestMessage: null,
                },
              ]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                {
                  id: 'user_456',
                  name: 'Other User',
                  email: 'other@test.com',
                  image: null,
                  username: 'otheruser',
                  displayName: 'Other User',
                  bio: null,
                  avatarUrl: null,
                },
              ]),
            }),
          }),
        } as any);

      const request = new Request('https://example.com/api/connections');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.connections).toHaveLength(1);
      expect(body.connections[0].user.id).toBe('user_456');
      expect(body.connections[0].isRequester).toBe(true);
    });

    it('should default status to ACCEPTED when not specified', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/connections');
      await GET(request);

      // Status defaults to 'ACCEPTED' - no specific param needed
      expect(db.select).toHaveBeenCalled();
    });

    it('should filter by status query parameter', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/connections?status=PENDING');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockRejectedValue(new Error('DB error')),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/connections');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch connections');
    });

    it('should log error when query fails', async () => {
      const error = new Error('DB error');
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockRejectedValue(error),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/connections');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching connections:', error);
    });
  });
});

// ============================================================================
// POST /api/connections
// ============================================================================

describe('POST /api/connections', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(isEmailVerified).mockResolvedValue(true);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/connections', {
        method: 'POST',
        body: JSON.stringify({ targetUserId: 'user_456' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should require CSRF for write operations', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ name: 'Test User', displayName: null }]),
              }),
            }),
          }),
        } as any);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'conn_new' }]),
        }),
      } as any);

      const request = new Request('https://example.com/api/connections', {
        method: 'POST',
        body: JSON.stringify({ targetUserId: 'user_456' }),
      });
      await POST(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('email verification', () => {
    it('should return 403 when email is not verified', async () => {
      vi.mocked(isEmailVerified).mockResolvedValue(false);

      const request = new Request('https://example.com/api/connections', {
        method: 'POST',
        body: JSON.stringify({ targetUserId: 'user_456' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.requiresEmailVerification).toBe(true);
    });
  });

  describe('validation', () => {
    it('should return 400 when targetUserId is missing', async () => {
      const request = new Request('https://example.com/api/connections', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Target user ID is required');
    });

    it('should return 400 when trying to connect with yourself', async () => {
      const request = new Request('https://example.com/api/connections', {
        method: 'POST',
        body: JSON.stringify({ targetUserId: 'user_123' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Cannot connect with yourself');
    });
  });

  describe('existing connection checks', () => {
    it('should return 400 when already connected', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ status: 'ACCEPTED' }]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/connections', {
        method: 'POST',
        body: JSON.stringify({ targetUserId: 'user_456' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Already connected with this user');
    });

    it('should return 400 when connection is already pending', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ status: 'PENDING' }]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/connections', {
        method: 'POST',
        body: JSON.stringify({ targetUserId: 'user_456' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Connection request already pending');
    });

    it('should return 400 when connection is blocked', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ status: 'BLOCKED' }]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/connections', {
        method: 'POST',
        body: JSON.stringify({ targetUserId: 'user_456' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Cannot send connection request');
    });
  });

  describe('success', () => {
    it('should create a new connection request and send notification', async () => {
      const newConnection = { id: 'conn_new', status: 'PENDING' };
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            leftJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([{ name: 'Test User', displayName: 'TestDisplay' }]),
              }),
            }),
          }),
        } as any);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newConnection]),
        }),
      } as any);

      const request = new Request('https://example.com/api/connections', {
        method: 'POST',
        body: JSON.stringify({ targetUserId: 'user_456', message: 'Hello!' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.connection).toEqual(newConnection);
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user_456',
          type: 'CONNECTION_REQUEST',
        })
      );
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

      const request = new Request('https://example.com/api/connections', {
        method: 'POST',
        body: JSON.stringify({ targetUserId: 'user_456' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to create connection request');
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

      const request = new Request('https://example.com/api/connections', {
        method: 'POST',
        body: JSON.stringify({ targetUserId: 'user_456' }),
      });
      await POST(request);

      expect(loggers.api.error).toHaveBeenCalledWith(
        'Error creating connection request:',
        error
      );
    });
  });
});
