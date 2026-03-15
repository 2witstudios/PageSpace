/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { PATCH } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/user/favorites/reorder
//
// Tests PATCH handler for reordering favorites by updating positions.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    update: vi.fn(),
    transaction: vi.fn(),
    query: {
      favorites: { findMany: vi.fn() },
    },
  },
  favorites: {
    id: 'id',
    userId: 'userId',
    position: 'position',
  },
  eq: vi.fn(),
  and: vi.fn(),
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

// ============================================================================
// PATCH /api/user/favorites/reorder
// ============================================================================

describe('PATCH /api/user/favorites/reorder', () => {
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

      const request = new Request('https://example.com/api/user/favorites/reorder', {
        method: 'PATCH',
        body: JSON.stringify({ orderedIds: ['fav_1', 'fav_2'] }),
      });
      const response = await PATCH(request);

      expect(response.status).toBe(401);
    });

    it('should require CSRF for write operations', async () => {
      vi.mocked(db.query.favorites.findMany).mockResolvedValue([
        { id: 'fav_1' },
        { id: 'fav_2' },
      ] as any);
      vi.mocked(db.transaction).mockImplementation(async (cb: any) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        };
        return cb(tx);
      });

      const request = new Request('https://example.com/api/user/favorites/reorder', {
        method: 'PATCH',
        body: JSON.stringify({ orderedIds: ['fav_1', 'fav_2'] }),
      });
      await PATCH(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('validation', () => {
    it('should return 400 when orderedIds is not an array', async () => {
      const request = new Request('https://example.com/api/user/favorites/reorder', {
        method: 'PATCH',
        body: JSON.stringify({ orderedIds: 'fav_1' }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('orderedIds must be an array');
    });

    it('should return 400 when orderedIds is missing', async () => {
      const request = new Request('https://example.com/api/user/favorites/reorder', {
        method: 'PATCH',
        body: JSON.stringify({}),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('orderedIds must be an array');
    });
  });

  describe('authorization', () => {
    it('should return 403 when some IDs do not belong to the user', async () => {
      // User only owns fav_1, not fav_2
      vi.mocked(db.query.favorites.findMany).mockResolvedValue([
        { id: 'fav_1' },
      ] as any);

      const request = new Request('https://example.com/api/user/favorites/reorder', {
        method: 'PATCH',
        body: JSON.stringify({ orderedIds: ['fav_1', 'fav_2'] }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Some favorite IDs do not belong to this user');
    });
  });

  describe('success', () => {
    it('should reorder favorites using a transaction', async () => {
      vi.mocked(db.query.favorites.findMany).mockResolvedValue([
        { id: 'fav_1' },
        { id: 'fav_2' },
        { id: 'fav_3' },
      ] as any);

      const mockTxUpdate = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });
      vi.mocked(db.transaction).mockImplementation(async (cb: any) => {
        return cb({ update: mockTxUpdate });
      });

      const request = new Request('https://example.com/api/user/favorites/reorder', {
        method: 'PATCH',
        body: JSON.stringify({ orderedIds: ['fav_3', 'fav_1', 'fav_2'] }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      // Should update position for each favorite
      expect(mockTxUpdate).toHaveBeenCalledTimes(3);
    });

    it('should handle empty orderedIds array', async () => {
      vi.mocked(db.query.favorites.findMany).mockResolvedValue([] as any);
      vi.mocked(db.transaction).mockImplementation(async (cb: any) => {
        return cb({
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        });
      });

      const request = new Request('https://example.com/api/user/favorites/reorder', {
        method: 'PATCH',
        body: JSON.stringify({ orderedIds: [] }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database operation fails', async () => {
      vi.mocked(db.query.favorites.findMany).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/user/favorites/reorder', {
        method: 'PATCH',
        body: JSON.stringify({ orderedIds: ['fav_1'] }),
      });
      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to reorder favorites');
    });

    it('should log error when operation fails', async () => {
      const error = new Error('DB error');
      vi.mocked(db.query.favorites.findMany).mockRejectedValue(error);

      const request = new Request('https://example.com/api/user/favorites/reorder', {
        method: 'PATCH',
        body: JSON.stringify({ orderedIds: ['fav_1'] }),
      });
      await PATCH(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error reordering favorites:', error);
    });
  });
});
