/**
 * Contract tests for GET /api/pages/[pageId]/children
 *
 * Tests verify:
 * - Authentication via authenticateRequestWithOptions
 * - Authorization via canUserViewPage
 * - Database query for children with task-linked info
 * - Error handling (500 on db failure)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock external boundaries BEFORE imports
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => {
    return result !== null && typeof result === 'object' && 'error' in result;
  }),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserViewPage: vi.fn(),
  loggers: {
    api: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: { findMany: vi.fn() },
    },
    selectDistinct: vi.fn(),
  },
  pages: { parentId: 'parentId', isTrashed: 'isTrashed', position: 'position', id: 'id' },
  taskItems: { pageId: 'taskItems.pageId' },
  and: vi.fn((...args: unknown[]) => args),
  eq: vi.fn((a: unknown, b: unknown) => [a, b]),
  asc: vi.fn((col: unknown) => col),
  isNotNull: vi.fn((col: unknown) => col),
}));

vi.mock('@pagespace/lib/api-utils', () => ({
  jsonResponse: vi.fn((data: unknown) => NextResponse.json(data)),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/server';
import { db } from '@pagespace/db';

// Test helpers
const mockUserId = 'user_123';
const mockPageId = 'page_abc';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createRequest = () =>
  new Request(`https://example.com/api/pages/${mockPageId}/children`, { method: 'GET' });

const mockParams = { params: Promise.resolve({ pageId: mockPageId }) };

describe('GET /api/pages/[pageId]/children', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(canUserViewPage).mockResolvedValue(true);

    // Default: return children
    vi.mocked(db.query.pages.findMany).mockResolvedValue([
      // @ts-expect-error - partial mock data
      { id: 'child_1', title: 'Child 1', parentId: mockPageId, isTrashed: false, position: 0 },
      // @ts-expect-error - partial mock data
      { id: 'child_2', title: 'Child 2', parentId: mockPageId, isTrashed: false, position: 1 },
    ]);

    // Default: selectDistinct chain
    const fromMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ pageId: 'child_1' }]) });
    vi.mocked(db.selectDistinct).mockReturnValue({ from: fromMock } as never);
  });

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await GET(createRequest(), mockParams);

      expect(response.status).toBe(401);
      expect(canUserViewPage).not.toHaveBeenCalled();
    });
  });

  describe('authorization', () => {
    it('returns 403 when user cannot view the page', async () => {
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const response = await GET(createRequest(), mockParams);

      expect(response.status).toBe(403);
    });

    it('checks permissions with correct userId and pageId', async () => {
      await GET(createRequest(), mockParams);

      expect(canUserViewPage).toHaveBeenCalledWith(mockUserId, mockPageId);
    });
  });

  describe('children retrieval', () => {
    it('returns children with isTaskLinked flag', async () => {
      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveLength(2);
      expect(body[0].isTaskLinked).toBe(true);  // child_1 is in task-linked set
      expect(body[1].isTaskLinked).toBe(false); // child_2 is not
    });

    it('returns empty array when no children exist', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([]);
      const fromMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
      vi.mocked(db.selectDistinct).mockReturnValue({ from: fromMock } as never);

      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveLength(0);
    });

    it('marks all children as not task-linked when no tasks exist', async () => {
      const fromMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
      vi.mocked(db.selectDistinct).mockReturnValue({ from: fromMock } as never);

      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(body[0].isTaskLinked).toBe(false);
      expect(body[1].isTaskLinked).toBe(false);
    });
  });

  describe('error handling', () => {
    it('returns 500 when database query throws', async () => {
      vi.mocked(db.query.pages.findMany).mockRejectedValueOnce(new Error('DB error'));

      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });

    it('returns 500 when task items query throws', async () => {
      const fromMock = vi.fn().mockReturnValue({
        where: vi.fn().mockRejectedValueOnce(new Error('Task query failed')),
      });
      vi.mocked(db.selectDistinct).mockReturnValue({ from: fromMock } as never);

      const response = await GET(createRequest(), mockParams);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toMatch(/failed/i);
    });
  });
});
