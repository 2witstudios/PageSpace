/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PATCH, DELETE } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/connections/[connectionId]
//
// Tests PATCH (accept/reject/block/unblock) and DELETE handlers.
// Next.js 15: params are Promises (must await context.params).
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  connections: { id: 'id', user1Id: 'user1Id', user2Id: 'user2Id' },
  users: { id: 'id', name: 'name' },
  userProfiles: { userId: 'userId', displayName: 'displayName' },
  eq: vi.fn(),
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
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { createNotification } from '@pagespace/lib';

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

const createContext = (connectionId: string) => ({
  params: Promise.resolve({ connectionId }),
});

const mockConnection = (overrides: Partial<{
  id: string;
  user1Id: string;
  user2Id: string;
  requestedBy: string;
  status: string;
  blockedBy: string | null;
}> = {}) => ({
  id: overrides.id ?? 'conn_1',
  user1Id: overrides.user1Id ?? 'user_123',
  user2Id: overrides.user2Id ?? 'user_456',
  requestedBy: overrides.requestedBy ?? 'user_123',
  status: overrides.status ?? 'PENDING',
  blockedBy: overrides.blockedBy ?? null,
  requestedAt: new Date(),
  acceptedAt: null,
  requestMessage: null,
});

const mockSelectChain = (result: any[]) => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue(result),
    }),
  }),
});

const mockSelectWithJoin = (result: any[]) => ({
  from: vi.fn().mockReturnValue({
    leftJoin: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
      }),
    }),
  }),
});

// ============================================================================
// PATCH /api/connections/[connectionId]
// ============================================================================

describe('PATCH /api/connections/[connectionId]', () => {
  const mockUserId = 'user_456'; // The recipient (non-requester)

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'accept' }),
      });
      const response = await PATCH(request, createContext('conn_1'));

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should return 400 for invalid action', async () => {
      vi.mocked(db.select).mockReturnValue(mockSelectChain([mockConnection()]) as any);

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'invalid' }),
      });
      const response = await PATCH(request, createContext('conn_1'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid action');
    });
  });

  describe('not found', () => {
    it('should return 404 when connection does not exist', async () => {
      vi.mocked(db.select).mockReturnValue(mockSelectChain([]) as any);

      const request = new Request('https://example.com/api/connections/conn_nonexistent', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'accept' }),
      });
      const response = await PATCH(request, createContext('conn_nonexistent'));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Connection not found');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user is not part of the connection', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_999'));
      vi.mocked(db.select).mockReturnValue(
        mockSelectChain([mockConnection({ user1Id: 'user_123', user2Id: 'user_456' })]) as any
      );

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'accept' }),
      });
      const response = await PATCH(request, createContext('conn_1'));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Unauthorized to modify this connection');
    });
  });

  describe('accept action', () => {
    it('should return 400 when requester tries to accept their own request', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_123'));
      vi.mocked(db.select).mockReturnValue(
        mockSelectChain([mockConnection({ requestedBy: 'user_123' })]) as any
      );

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'accept' }),
      });
      const response = await PATCH(request, createContext('conn_1'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Cannot accept your own request');
    });

    it('should return 400 when connection is not pending', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectChain([mockConnection({ status: 'ACCEPTED' })]) as any
      );

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'accept' }),
      });
      const response = await PATCH(request, createContext('conn_1'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Connection is not pending');
    });

    it('should accept a pending connection and send notification', async () => {
      const conn = mockConnection({ status: 'PENDING', requestedBy: 'user_123' });
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectChain([conn]) as any)
        .mockReturnValueOnce(
          mockSelectWithJoin([{ name: 'Recipient', displayName: 'Recipient Display' }]) as any
        );
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...conn, status: 'ACCEPTED' }]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'accept' }),
      });
      const response = await PATCH(request, createContext('conn_1'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.connection.status).toBe('ACCEPTED');
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CONNECTION_ACCEPTED',
          userId: 'user_123',
        })
      );
    });
  });

  describe('reject action', () => {
    it('should return 400 when requester tries to reject their own request', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_123'));
      vi.mocked(db.select).mockReturnValue(
        mockSelectChain([mockConnection({ requestedBy: 'user_123' })]) as any
      );

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'reject' }),
      });
      const response = await PATCH(request, createContext('conn_1'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Cannot reject your own request');
    });

    it('should return 400 when connection is not pending', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectChain([mockConnection({ status: 'ACCEPTED' })]) as any
      );

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'reject' }),
      });
      const response = await PATCH(request, createContext('conn_1'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Connection is not pending');
    });

    it('should reject and delete the connection, sending notification', async () => {
      const conn = mockConnection({ status: 'PENDING', requestedBy: 'user_123' });
      vi.mocked(db.select)
        .mockReturnValueOnce(mockSelectChain([conn]) as any)
        .mockReturnValueOnce(
          mockSelectWithJoin([{ name: 'Rejector', displayName: null }]) as any
        );
      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      } as any);

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'reject' }),
      });
      const response = await PATCH(request, createContext('conn_1'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(db.delete).toHaveBeenCalled();
      expect(createNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'CONNECTION_REJECTED',
          userId: 'user_123',
        })
      );
    });
  });

  describe('block action', () => {
    it('should block the connection', async () => {
      const conn = mockConnection({ status: 'PENDING' });
      vi.mocked(db.select).mockReturnValue(mockSelectChain([conn]) as any);
      vi.mocked(db.update).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...conn, status: 'BLOCKED' }]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'block' }),
      });
      const response = await PATCH(request, createContext('conn_1'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.connection.status).toBe('BLOCKED');
    });
  });

  describe('unblock action', () => {
    it('should return 400 when connection is not blocked', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectChain([mockConnection({ status: 'PENDING' })]) as any
      );

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'unblock' }),
      });
      const response = await PATCH(request, createContext('conn_1'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Connection is not blocked');
    });

    it('should return 400 when non-blocker tries to unblock', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectChain([mockConnection({ status: 'BLOCKED', blockedBy: 'user_123' })]) as any
      );

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'unblock' }),
      });
      const response = await PATCH(request, createContext('conn_1'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Only the blocker can unblock');
    });

    it('should unblock and delete the connection', async () => {
      vi.mocked(db.select).mockReturnValue(
        mockSelectChain([mockConnection({ status: 'BLOCKED', blockedBy: 'user_456' })]) as any
      );
      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      } as any);

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'unblock' }),
      });
      const response = await PATCH(request, createContext('conn_1'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(db.delete).toHaveBeenCalled();
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

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'accept' }),
      });
      const response = await PATCH(request, createContext('conn_1'));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update connection');
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

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'accept' }),
      });
      await PATCH(request, createContext('conn_1'));

      expect(loggers.api.error).toHaveBeenCalledWith('Error updating connection:', error);
    });
  });
});

// ============================================================================
// DELETE /api/connections/[connectionId]
// ============================================================================

describe('DELETE /api/connections/[connectionId]', () => {
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

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext('conn_1'));

      expect(response.status).toBe(401);
    });
  });

  describe('not found', () => {
    it('should return 404 when connection does not exist', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/connections/conn_nonexistent', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext('conn_nonexistent'));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Connection not found');
    });
  });

  describe('authorization', () => {
    it('should return 403 when user is not part of the connection', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_999'));
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              mockConnection({ user1Id: 'user_123', user2Id: 'user_456' }),
            ]),
          }),
        }),
      } as any);

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext('conn_1'));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Unauthorized to delete this connection');
    });
  });

  describe('success', () => {
    it('should delete the connection and return success', async () => {
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              mockConnection({ user1Id: 'user_123', user2Id: 'user_456' }),
            ]),
          }),
        }),
      } as any);
      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      } as any);

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext('conn_1'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(db.delete).toHaveBeenCalled();
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

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext('conn_1'));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to delete connection');
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

      const request = new Request('https://example.com/api/connections/conn_1', {
        method: 'DELETE',
      });
      await DELETE(request, createContext('conn_1'));

      expect(loggers.api.error).toHaveBeenCalledWith('Error deleting connection:', error);
    });
  });
});
