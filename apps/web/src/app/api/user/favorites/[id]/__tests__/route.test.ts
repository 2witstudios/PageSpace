/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { DELETE } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/user/favorites/[id]
//
// Tests DELETE handler for removing a favorite by ID.
// Next.js 15: params are Promises (must await context.params).
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    delete: vi.fn(),
    query: {
      favorites: { findFirst: vi.fn() },
    },
  },
  favorites: {
    id: 'id',
    userId: 'userId',
  },
  eq: vi.fn(),
  and: vi.fn(),
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

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

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

const createContext = (id: string) => ({
  params: Promise.resolve({ id }),
});

// ============================================================================
// DELETE /api/user/favorites/[id]
// ============================================================================

describe('DELETE /api/user/favorites/[id]', () => {
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

      const request = new Request('https://example.com/api/user/favorites/fav_1', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext('fav_1'));

      expect(response.status).toBe(401);
    });

    it('should require CSRF for delete operations', async () => {
      vi.mocked(db.query.favorites.findFirst).mockResolvedValue({ id: 'fav_1' } as any);
      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      } as any);

      const request = new Request('https://example.com/api/user/favorites/fav_1', {
        method: 'DELETE',
      });
      await DELETE(request, createContext('fav_1'));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('params handling', () => {
    it('should correctly await async params (Next.js 15)', async () => {
      vi.mocked(db.query.favorites.findFirst).mockResolvedValue({ id: 'fav_abc' } as any);
      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      } as any);

      const request = new Request('https://example.com/api/user/favorites/fav_abc', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext('fav_abc'));

      expect(response.status).toBe(200);
    });
  });

  describe('not found', () => {
    it('should return 404 when favorite does not exist', async () => {
      vi.mocked(db.query.favorites.findFirst).mockResolvedValue(null);

      const request = new Request('https://example.com/api/user/favorites/fav_nonexistent', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext('fav_nonexistent'));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Favorite not found');
    });

    it('should return 404 when favorite belongs to another user', async () => {
      // The query uses AND(eq(id), eq(userId)), so if the userId does not
      // match, findFirst returns null, resulting in a 404.
      vi.mocked(db.query.favorites.findFirst).mockResolvedValue(null);

      const request = new Request('https://example.com/api/user/favorites/fav_other', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext('fav_other'));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Favorite not found');
    });
  });

  describe('success', () => {
    it('should delete the favorite and return success', async () => {
      vi.mocked(db.query.favorites.findFirst).mockResolvedValue({
        id: 'fav_1',
        userId: 'user_123',
      } as any);
      vi.mocked(db.delete).mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      } as any);

      const request = new Request('https://example.com/api/user/favorites/fav_1', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext('fav_1'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database operation fails', async () => {
      vi.mocked(db.query.favorites.findFirst).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/user/favorites/fav_1', {
        method: 'DELETE',
      });
      const response = await DELETE(request, createContext('fav_1'));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to delete favorite');
    });

    it('should log error when operation fails', async () => {
      const error = new Error('DB error');
      vi.mocked(db.query.favorites.findFirst).mockRejectedValue(error);

      const request = new Request('https://example.com/api/user/favorites/fav_1', {
        method: 'DELETE',
      });
      await DELETE(request, createContext('fav_1'));

      expect(loggers.api.error).toHaveBeenCalledWith('Error deleting favorite:', error);
    });
  });
});
