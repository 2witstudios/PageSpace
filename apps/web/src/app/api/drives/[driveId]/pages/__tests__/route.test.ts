import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for GET /api/drives/[driveId]/pages
//
// The route has no service-seam abstraction, so we mock at the DB layer
// and the auth/utility boundaries.
// ============================================================================

// ---------- hoisted mocks (safe for vi.mock factories) ----------

const {
  mockFindFirst,
  mockFindMany,
  mockSelectDistinctWhere,
  mockSelectWhere,
  mockSelectLimit,
  mockExecute,
} = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockFindMany: vi.fn(),
  mockSelectDistinctWhere: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockSelectLimit: vi.fn(),
  mockExecute: vi.fn(),
}));

// ---------- vi.mock declarations ----------

vi.mock('@pagespace/db', () => {
  const eq = vi.fn((_col: unknown, _val: unknown) => ({ type: 'eq' }));
  const and = vi.fn((..._args: unknown[]) => ({ type: 'and' }));
  const inArray = vi.fn((_col: unknown, _vals: unknown[]) => ({ type: 'inArray' }));
  const asc = vi.fn((_col: unknown) => ({ type: 'asc' }));
  const isNotNull = vi.fn((_col: unknown) => ({ type: 'isNotNull' }));
  const sql = Object.assign(
    (strings: TemplateStringsArray, ..._values: unknown[]) => ({ strings, _values, type: 'sql' }),
    { join: vi.fn(() => ({ type: 'sql.join' })) }
  );

  const selectDistinctChain = {
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: mockSelectDistinctWhere,
  };

  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: mockSelectWhere.mockReturnThis(),
    limit: mockSelectLimit,
  };

  return {
    db: {
      query: {
        drives: { findFirst: mockFindFirst },
        pages: { findMany: mockFindMany },
      },
      selectDistinct: vi.fn().mockReturnValue(selectDistinctChain),
      select: vi.fn().mockReturnValue(selectChain),
      execute: mockExecute,
    },
    pages: { id: 'pages.id', driveId: 'pages.driveId', isTrashed: 'pages.isTrashed', parentId: 'pages.parentId', position: 'pages.position' },
    drives: { id: 'drives.id', ownerId: 'drives.ownerId' },
    pagePermissions: { pageId: 'pp.pageId', userId: 'pp.userId', canView: 'pp.canView' },
    driveMembers: { driveId: 'dm.driveId', userId: 'dm.userId', role: 'dm.role', id: 'dm.id' },
    taskItems: { pageId: 'ti.pageId', taskListId: 'ti.taskListId' },
    taskLists: { id: 'tl.id', pageId: 'tl.pageId' },
    eq,
    and,
    inArray,
    asc,
    isNotNull,
    sql,
  };
});

vi.mock('@pagespace/lib/server', () => ({
  buildTree: vi.fn((items: unknown[]) => items),
  auditRequest: vi.fn(),
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/utils/api-utils', () => ({
  jsonResponse: vi.fn((data: unknown) => NextResponse.json(data, { status: 200 })),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  checkMCPDriveScope: vi.fn(),
}));

// ---------- imports (after mocks) ----------

import { GET } from '../route';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope } from '@/lib/auth';
import { buildTree } from '@pagespace/lib/content/tree-utils'
import { loggers } from '@pagespace/lib/logging/logger-config';

// ---------- helpers ----------

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthErrorResponse = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createContext = (driveId: string) => ({
  params: Promise.resolve({ driveId }),
});

const createRequest = (driveId = 'drive_abc') =>
  new Request(`https://example.com/api/drives/${driveId}/pages`);

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/drives/[driveId]/pages', () => {
  const mockUserId = 'user_123';
  const mockDriveId = 'drive_abc';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(checkMCPDriveScope).mockReturnValue(null);

    // Default: drive found, user is owner
    mockFindFirst.mockResolvedValue({ id: mockDriveId, ownerId: mockUserId, name: 'Test Drive' });

    // Default: pages query returns empty
    mockFindMany.mockResolvedValue([]);

    // Default: selectDistinct returns empty (task-linked pages, permitted pages)
    mockSelectDistinctWhere.mockResolvedValue([]);

    // Default: select chain (admin membership check) returns empty
    mockSelectLimit.mockResolvedValue([]);

    // Default: execute (ancestor query, unread activity query) returns empty rows
    mockExecute.mockResolvedValue({ rows: [] });

    // buildTree pass-through
    vi.mocked(buildTree).mockImplementation((items: unknown[]) => items as ReturnType<typeof buildTree>);
  });

  // ---------- Authentication ----------

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthErrorResponse(401));

      const response = await GET(createRequest() as never, createContext(mockDriveId));

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with correct auth options', async () => {
      const request = createRequest();
      await GET(request as never, createContext(mockDriveId));

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(request, {
        allow: ['session', 'mcp'],
        requireCSRF: false,
      });
    });
  });

  // ---------- MCP Scope ----------

  describe('MCP scope checking', () => {
    it('should return scope error when MCP token lacks drive access', async () => {
      const scopeError = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      vi.mocked(checkMCPDriveScope).mockReturnValue(scopeError);

      const response = await GET(createRequest() as never, createContext(mockDriveId));

      expect(response.status).toBe(403);
      const scopeArgs = vi.mocked(checkMCPDriveScope).mock.calls[0];
      expect(scopeArgs[0]).toEqual(mockWebAuth(mockUserId));
      expect(scopeArgs[1]).toBe(mockDriveId);
    });

    it('should proceed when checkMCPDriveScope returns null', async () => {
      vi.mocked(checkMCPDriveScope).mockReturnValue(null);

      const response = await GET(createRequest() as never, createContext(mockDriveId));

      expect(response.status).toBe(200);
    });
  });

  // ---------- Drive not found ----------

  describe('drive lookup', () => {
    it('should return 404 when drive not found', async () => {
      mockFindFirst.mockResolvedValue(undefined);

      const response = await GET(createRequest() as never, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Drive not found');
    });
  });

  // ---------- Owner path ----------

  describe('owner access', () => {
    it('should fetch all pages when user is drive owner', async () => {
      const pageData = [
        { id: 'page_1', parentId: null, position: 0 },
        { id: 'page_2', parentId: 'page_1', position: 1 },
      ];
      mockFindMany.mockResolvedValue(pageData);

      const response = await GET(createRequest() as never, createContext(mockDriveId));

      expect(response.status).toBe(200);
      expect(mockFindMany).toHaveBeenCalledWith({
        where: { type: 'and' },
        orderBy: [{ type: 'asc' }],
      });
    });
  });

  // ---------- Admin path ----------

  describe('admin access', () => {
    it('should fetch all pages when user is admin (not owner)', async () => {
      // User is NOT owner
      mockFindFirst.mockResolvedValue({ id: mockDriveId, ownerId: 'other_owner', name: 'Test' });

      // User IS admin - admin check returns a membership record
      mockSelectLimit.mockResolvedValue([{ id: 'membership_1' }]);

      mockFindMany.mockResolvedValue([{ id: 'page_1', parentId: null, position: 0 }]);

      const response = await GET(createRequest() as never, createContext(mockDriveId));

      expect(response.status).toBe(200);
      expect(mockFindMany).toHaveBeenCalledWith({
        where: { type: 'and' },
        orderBy: [{ type: 'asc' }],
      });
    });
  });

  // ---------- Non-owner, non-admin (permitted pages) path ----------

  describe('member access (permitted pages)', () => {
    beforeEach(() => {
      // Not owner
      mockFindFirst.mockResolvedValue({ id: mockDriveId, ownerId: 'other_owner', name: 'Test' });
      // Not admin
      mockSelectLimit.mockResolvedValue([]);
    });

    it('should return empty tree when member has no page permissions', async () => {
      // selectDistinct for permitted pages returns empty
      mockSelectDistinctWhere.mockResolvedValue([]);

      const response = await GET(createRequest() as never, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual([]);
    });

    it('should fetch permitted pages and ancestors when member has some permissions', async () => {
      // First selectDistinct call: permitted page IDs
      // Second selectDistinct call: task-linked pages
      mockSelectDistinctWhere
        .mockResolvedValueOnce([{ id: 'page_2' }])  // permitted pages
        .mockResolvedValueOnce([]);                    // task-linked pages

      // execute: first for ancestor query, second for unread activity
      mockExecute
        .mockResolvedValueOnce({ rows: [{ id: 'page_1' }, { id: 'page_2' }] })  // ancestors
        .mockResolvedValueOnce({ rows: [] });  // unread activity

      // findMany for the permitted + ancestor pages
      mockFindMany.mockResolvedValue([
        { id: 'page_1', parentId: null, position: 0 },
        { id: 'page_2', parentId: 'page_1', position: 1 },
      ]);

      const response = await GET(createRequest() as never, createContext(mockDriveId));

      expect(response.status).toBe(200);
      expect(mockFindMany).toHaveBeenCalledWith({
        where: { type: 'and' },
        orderBy: [{ type: 'asc' }],
      });
      const executeArgs = mockExecute.mock.calls[0];
      expect(executeArgs[0]).toHaveProperty('type', 'sql');
    });
  });

  // ---------- Task-linked & hasChanges flags ----------

  describe('page flags', () => {
    it('should add isTaskLinked flag to pages', async () => {
      const pageData = [
        { id: 'page_1', parentId: null, position: 0 },
        { id: 'page_2', parentId: null, position: 1 },
      ];
      mockFindMany.mockResolvedValue(pageData);

      // Task-linked: page_1 is linked
      mockSelectDistinctWhere.mockResolvedValue([{ pageId: 'page_1' }]);

      // Unread activity
      mockExecute.mockResolvedValue({ rows: [] });

      let receivedPages: Array<Record<string, unknown>> = [];
      vi.mocked(buildTree).mockImplementation((items: unknown[]) => {
        receivedPages = items as Array<Record<string, unknown>>;
        return items as ReturnType<typeof buildTree>;
      });

      await GET(createRequest() as never, createContext(mockDriveId));

      expect(receivedPages[0].isTaskLinked).toBe(true);
      expect(receivedPages[1].isTaskLinked).toBe(false);
    });

    it('should add hasChanges flag based on activity logs', async () => {
      const pageData = [
        { id: 'page_1', parentId: null, position: 0 },
        { id: 'page_2', parentId: null, position: 1 },
      ];
      mockFindMany.mockResolvedValue(pageData);

      // Task-linked: none
      mockSelectDistinctWhere.mockResolvedValue([]);

      // Unread activity: page_2 has changes
      mockExecute.mockResolvedValue({ rows: [{ page_id: 'page_2' }] });

      let receivedPages: Array<Record<string, unknown>> = [];
      vi.mocked(buildTree).mockImplementation((items: unknown[]) => {
        receivedPages = items as Array<Record<string, unknown>>;
        return items as ReturnType<typeof buildTree>;
      });

      await GET(createRequest() as never, createContext(mockDriveId));

      expect(receivedPages[0].hasChanges).toBe(false);
      expect(receivedPages[1].hasChanges).toBe(true);
    });

    it('should skip unread activity query when no pages exist', async () => {
      mockFindMany.mockResolvedValue([]);
      mockSelectDistinctWhere.mockResolvedValue([]);

      await GET(createRequest() as never, createContext(mockDriveId));

      // execute should NOT be called when pageIds is empty
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  // ---------- Response ----------

  describe('response contract', () => {
    it('should call buildTree with flagged pages and return result via jsonResponse', async () => {
      const pageData = [{ id: 'page_1', parentId: null, position: 0 }];
      mockFindMany.mockResolvedValue(pageData);
      mockSelectDistinctWhere.mockResolvedValue([]);

      const response = await GET(createRequest() as never, createContext(mockDriveId));

      expect(response.status).toBe(200);
      expect(buildTree).toHaveBeenCalledWith([
        { id: 'page_1', parentId: null, position: 0, isTaskLinked: false, hasChanges: false },
      ]);
    });
  });

  // ---------- Error handling ----------

  describe('error handling', () => {
    it('should return 500 when an error is thrown', async () => {
      mockFindFirst.mockRejectedValueOnce(new Error('Database failure'));

      const response = await GET(createRequest() as never, createContext(mockDriveId));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch pages');
    });

    it('should log error when an error is thrown', async () => {
      const error = new Error('Database failure');
      mockFindFirst.mockRejectedValueOnce(error);

      await GET(createRequest() as never, createContext(mockDriveId));

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching pages:', error);
    });
  });
});
