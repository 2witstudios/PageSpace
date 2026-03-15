/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/user/recents
//
// Tests GET handler for fetching recently viewed pages.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      userPageViews: { findMany: vi.fn() },
    },
  },
  userPageViews: {
    userId: 'userId',
    viewedAt: 'viewedAt',
  },
  eq: vi.fn(),
  desc: vi.fn(),
}));

vi.mock('@pagespace/lib/client-safe', () => ({
  PageType: {
    FOLDER: 'FOLDER',
    DOCUMENT: 'DOCUMENT',
    CHANNEL: 'CHANNEL',
    AI_CHAT: 'AI_CHAT',
    CANVAS: 'CANVAS',
    FILE: 'FILE',
    SHEET: 'SHEET',
    TASK_LIST: 'TASK_LIST',
    CODE: 'CODE',
  },
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

const createRecentView = (overrides: Partial<{
  pageId: string;
  title: string;
  type: string;
  driveId: string;
  driveName: string;
  isTrashed: boolean;
  driveIsTrashed: boolean;
  viewedAt: Date;
}> = {}) => ({
  userId: 'user_123',
  pageId: overrides.pageId ?? 'page_1',
  viewedAt: overrides.viewedAt ?? new Date('2024-01-01'),
  page: {
    id: overrides.pageId ?? 'page_1',
    title: overrides.title ?? 'Test Page',
    type: overrides.type ?? 'DOCUMENT',
    driveId: overrides.driveId ?? 'drive_1',
    isTrashed: overrides.isTrashed ?? false,
    drive: {
      id: overrides.driveId ?? 'drive_1',
      name: overrides.driveName ?? 'My Drive',
      isTrashed: overrides.driveIsTrashed ?? false,
    },
  },
});

// ============================================================================
// GET /api/user/recents
// ============================================================================

describe('GET /api/user/recents', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(db.query.userPageViews.findMany).mockResolvedValue([]);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/user/recents');
      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('success', () => {
    it('should return empty recents array when no views exist', async () => {
      const request = new Request('https://example.com/api/user/recents');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.recents).toEqual([]);
    });

    it('should return recent pages with drive info', async () => {
      vi.mocked(db.query.userPageViews.findMany).mockResolvedValue([
        createRecentView({
          pageId: 'page_1',
          title: 'My Document',
          type: 'DOCUMENT',
          driveId: 'drive_1',
          driveName: 'Work Drive',
          viewedAt: new Date('2024-06-15T12:00:00Z'),
        }),
      ] as any);

      const request = new Request('https://example.com/api/user/recents');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.recents).toHaveLength(1);
      expect(body.recents[0]).toMatchObject({
        id: 'page_1',
        title: 'My Document',
        type: 'DOCUMENT',
        driveId: 'drive_1',
        driveName: 'Work Drive',
      });
    });

    it('should filter out trashed pages', async () => {
      vi.mocked(db.query.userPageViews.findMany).mockResolvedValue([
        createRecentView({ pageId: 'page_1', isTrashed: true }),
        createRecentView({ pageId: 'page_2', isTrashed: false }),
      ] as any);

      const request = new Request('https://example.com/api/user/recents');
      const response = await GET(request);
      const body = await response.json();

      expect(body.recents).toHaveLength(1);
      expect(body.recents[0].id).toBe('page_2');
    });

    it('should filter out pages from trashed drives', async () => {
      vi.mocked(db.query.userPageViews.findMany).mockResolvedValue([
        createRecentView({ pageId: 'page_1', driveIsTrashed: true }),
        createRecentView({ pageId: 'page_2', driveIsTrashed: false }),
      ] as any);

      const request = new Request('https://example.com/api/user/recents');
      const response = await GET(request);
      const body = await response.json();

      expect(body.recents).toHaveLength(1);
      expect(body.recents[0].id).toBe('page_2');
    });

    it('should filter out views where page is null', async () => {
      vi.mocked(db.query.userPageViews.findMany).mockResolvedValue([
        { userId: 'user_123', pageId: 'page_deleted', viewedAt: new Date(), page: null },
        createRecentView({ pageId: 'page_2' }),
      ] as any);

      const request = new Request('https://example.com/api/user/recents');
      const response = await GET(request);
      const body = await response.json();

      expect(body.recents).toHaveLength(1);
      expect(body.recents[0].id).toBe('page_2');
    });

    it('should filter out unknown page types', async () => {
      vi.mocked(db.query.userPageViews.findMany).mockResolvedValue([
        createRecentView({ pageId: 'page_1', type: 'UNKNOWN_TYPE' }),
        createRecentView({ pageId: 'page_2', type: 'DOCUMENT' }),
      ] as any);

      const request = new Request('https://example.com/api/user/recents');
      const response = await GET(request);
      const body = await response.json();

      expect(body.recents).toHaveLength(1);
      expect(body.recents[0].id).toBe('page_2');
    });
  });

  describe('limit parameter', () => {
    it('should default to 8 when no limit specified', async () => {
      const request = new Request('https://example.com/api/user/recents');
      await GET(request);

      // The route fetches limit * 2 to account for filtering
      expect(db.query.userPageViews.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 16 })
      );
    });

    it('should respect custom limit parameter', async () => {
      const request = new Request('https://example.com/api/user/recents?limit=5');
      await GET(request);

      expect(db.query.userPageViews.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10 })
      );
    });

    it('should cap limit at 50', async () => {
      const request = new Request('https://example.com/api/user/recents?limit=100');
      await GET(request);

      expect(db.query.userPageViews.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 })
      );
    });

    it('should use minimum limit of 1', async () => {
      const request = new Request('https://example.com/api/user/recents?limit=0');
      await GET(request);

      expect(db.query.userPageViews.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 2 })
      );
    });

    it('should handle non-numeric limit gracefully', async () => {
      const request = new Request('https://example.com/api/user/recents?limit=abc');
      await GET(request);

      // NaN falls back to 8
      expect(db.query.userPageViews.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 16 })
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      vi.mocked(db.query.userPageViews.findMany).mockRejectedValue(new Error('DB error'));

      const request = new Request('https://example.com/api/user/recents');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch recent pages');
    });

    it('should log error when query fails', async () => {
      const error = new Error('DB error');
      vi.mocked(db.query.userPageViews.findMany).mockRejectedValue(error);

      const request = new Request('https://example.com/api/user/recents');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching recent pages:', error);
    });
  });
});
