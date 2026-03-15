/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/user/favorites
//
// Tests GET (list favorites) and POST (add favorite) handlers.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    insert: vi.fn(),
    query: {
      favorites: { findMany: vi.fn(), findFirst: vi.fn() },
      pages: { findFirst: vi.fn() },
      drives: { findFirst: vi.fn() },
    },
  },
  favorites: {
    userId: 'userId',
    pageId: 'pageId',
    driveId: 'driveId',
    position: 'position',
    createdAt: 'createdAt',
    id: 'id',
  },
  pages: { id: 'id' },
  drives: { id: 'id' },
  eq: vi.fn(),
  and: vi.fn(),
  desc: vi.fn(),
  asc: vi.fn(),
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
// GET /api/user/favorites
// ============================================================================

describe('GET /api/user/favorites', () => {
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

      const request = new Request('https://example.com/api/user/favorites');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('success', () => {
    it('should return empty favorites array when none exist', async () => {
      vi.mocked(db.query.favorites.findMany).mockResolvedValue([]);

      const request = new Request('https://example.com/api/user/favorites');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.favorites).toEqual([]);
    });

    it('should return page favorites with drive info', async () => {
      vi.mocked(db.query.favorites.findMany).mockResolvedValue([
        {
          id: 'fav_1',
          itemType: 'page',
          position: 0,
          createdAt: new Date('2024-01-01'),
          page: {
            id: 'page_1',
            title: 'My Page',
            type: 'DOCUMENT',
            driveId: 'drive_1',
            drive: { id: 'drive_1', name: 'My Drive' },
          },
          drive: null,
        },
      ] as any);

      const request = new Request('https://example.com/api/user/favorites');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.favorites).toHaveLength(1);
      expect(body.favorites[0]).toMatchObject({
        id: 'fav_1',
        itemType: 'page',
        page: {
          id: 'page_1',
          title: 'My Page',
          type: 'DOCUMENT',
          driveId: 'drive_1',
          driveName: 'My Drive',
        },
      });
    });

    it('should return drive favorites', async () => {
      vi.mocked(db.query.favorites.findMany).mockResolvedValue([
        {
          id: 'fav_2',
          itemType: 'drive',
          position: 0,
          createdAt: new Date('2024-01-01'),
          page: null,
          drive: { id: 'drive_1', name: 'My Drive' },
        },
      ] as any);

      const request = new Request('https://example.com/api/user/favorites');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.favorites).toHaveLength(1);
      expect(body.favorites[0]).toMatchObject({
        id: 'fav_2',
        itemType: 'drive',
        drive: { id: 'drive_1', name: 'My Drive' },
      });
    });

    it('should filter out favorites where the referenced item no longer exists', async () => {
      vi.mocked(db.query.favorites.findMany).mockResolvedValue([
        {
          id: 'fav_1',
          itemType: 'page',
          position: 0,
          createdAt: new Date('2024-01-01'),
          page: null, // page was deleted
          drive: null,
        },
        {
          id: 'fav_2',
          itemType: 'drive',
          position: 1,
          createdAt: new Date('2024-01-01'),
          page: null,
          drive: null, // drive was deleted
        },
      ] as any);

      const request = new Request('https://example.com/api/user/favorites');
      const response = await GET(request);
      const body = await response.json();

      expect(body.favorites).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.query.favorites.findMany).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/user/favorites');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch favorites');
    });

    it('should log error when query fails', async () => {
      const error = new Error('DB error');
      vi.mocked(db.query.favorites.findMany).mockRejectedValue(error);

      const request = new Request('https://example.com/api/user/favorites');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching favorites:', error);
    });
  });
});

// ============================================================================
// POST /api/user/favorites
// ============================================================================

describe('POST /api/user/favorites', () => {
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

      const request = new Request('https://example.com/api/user/favorites', {
        method: 'POST',
        body: JSON.stringify({ itemType: 'page', itemId: 'page_1' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should require CSRF for write operations', async () => {
      vi.mocked(db.query.favorites.findFirst)
        .mockResolvedValueOnce(null)  // existing check
        .mockResolvedValueOnce(null); // max position
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: 'page_1' } as any);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'fav_new' }]),
        }),
      } as any);

      const request = new Request('https://example.com/api/user/favorites', {
        method: 'POST',
        body: JSON.stringify({ itemType: 'page', itemId: 'page_1' }),
      });
      await POST(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('validation', () => {
    it('should return 400 when itemType is missing', async () => {
      const request = new Request('https://example.com/api/user/favorites', {
        method: 'POST',
        body: JSON.stringify({ itemId: 'page_1' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('itemType and itemId are required');
    });

    it('should return 400 when itemId is missing', async () => {
      const request = new Request('https://example.com/api/user/favorites', {
        method: 'POST',
        body: JSON.stringify({ itemType: 'page' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('itemType and itemId are required');
    });

    it('should return 400 when itemType is invalid', async () => {
      const request = new Request('https://example.com/api/user/favorites', {
        method: 'POST',
        body: JSON.stringify({ itemType: 'folder', itemId: 'f_1' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('itemType must be "page" or "drive"');
    });
  });

  describe('conflict detection', () => {
    it('should return 409 when item is already favorited', async () => {
      vi.mocked(db.query.favorites.findFirst).mockResolvedValueOnce({
        id: 'fav_existing',
      } as any);

      const request = new Request('https://example.com/api/user/favorites', {
        method: 'POST',
        body: JSON.stringify({ itemType: 'page', itemId: 'page_1' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.error).toBe('Already favorited');
    });
  });

  describe('item existence checks', () => {
    it('should return 404 when page does not exist', async () => {
      vi.mocked(db.query.favorites.findFirst)
        .mockResolvedValueOnce(null)  // existing check
        .mockResolvedValueOnce(null); // max position
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(null);

      const request = new Request('https://example.com/api/user/favorites', {
        method: 'POST',
        body: JSON.stringify({ itemType: 'page', itemId: 'page_nonexistent' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Page not found');
    });

    it('should return 404 when drive does not exist', async () => {
      vi.mocked(db.query.favorites.findFirst)
        .mockResolvedValueOnce(null)  // existing check
        .mockResolvedValueOnce(null); // max position
      vi.mocked(db.query.drives.findFirst).mockResolvedValue(null);

      const request = new Request('https://example.com/api/user/favorites', {
        method: 'POST',
        body: JSON.stringify({ itemType: 'drive', itemId: 'drive_nonexistent' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });
  });

  describe('success', () => {
    it('should create a page favorite and return 201', async () => {
      const newFavorite = { id: 'fav_new', itemType: 'page', position: 0 };
      vi.mocked(db.query.favorites.findFirst)
        .mockResolvedValueOnce(null)  // existing check
        .mockResolvedValueOnce(null); // max position
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: 'page_1' } as any);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newFavorite]),
        }),
      } as any);

      const request = new Request('https://example.com/api/user/favorites', {
        method: 'POST',
        body: JSON.stringify({ itemType: 'page', itemId: 'page_1' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.favorite).toEqual(newFavorite);
    });

    it('should create a drive favorite and return 201', async () => {
      const newFavorite = { id: 'fav_new', itemType: 'drive', position: 0 };
      vi.mocked(db.query.favorites.findFirst)
        .mockResolvedValueOnce(null)  // existing check
        .mockResolvedValueOnce(null); // max position
      vi.mocked(db.query.drives.findFirst).mockResolvedValue({ id: 'drive_1' } as any);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newFavorite]),
        }),
      } as any);

      const request = new Request('https://example.com/api/user/favorites', {
        method: 'POST',
        body: JSON.stringify({ itemType: 'drive', itemId: 'drive_1' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.favorite).toEqual(newFavorite);
    });

    it('should assign next position based on existing favorites', async () => {
      vi.mocked(db.query.favorites.findFirst)
        .mockResolvedValueOnce(null) // existing check
        .mockResolvedValueOnce({ position: 3 } as any); // max position = 3, so next = 4
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: 'page_1' } as any);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'fav_new', position: 4 }]),
        }),
      } as any);

      const request = new Request('https://example.com/api/user/favorites', {
        method: 'POST',
        body: JSON.stringify({ itemType: 'page', itemId: 'page_1' }),
      });
      const response = await POST(request);

      expect(response.status).toBe(201);
      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return 500 when database operation fails', async () => {
      vi.mocked(db.query.favorites.findFirst).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/user/favorites', {
        method: 'POST',
        body: JSON.stringify({ itemType: 'page', itemId: 'page_1' }),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to add favorite');
    });

    it('should log error when operation fails', async () => {
      const error = new Error('DB error');
      vi.mocked(db.query.favorites.findFirst).mockRejectedValue(error);

      const request = new Request('https://example.com/api/user/favorites', {
        method: 'POST',
        body: JSON.stringify({ itemType: 'page', itemId: 'page_1' }),
      });
      await POST(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error adding favorite:', error);
    });
  });
});
