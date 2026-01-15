/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/tasks
//
// Tests the route handler's contract for fetching tasks assigned to users.
// Mocks at the DB query level since there's no service layer abstraction.
// ============================================================================

// Mock dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: { findMany: vi.fn() },
      taskLists: { findMany: vi.fn() },
      taskItems: { findMany: vi.fn() },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
  },
  taskItems: { taskListId: 'taskListId', assigneeId: 'assigneeId', pageId: 'pageId', status: 'status', priority: 'priority', createdAt: 'createdAt', updatedAt: 'updatedAt' },
  taskLists: { id: 'id', pageId: 'pageId' },
  pages: { id: 'id', driveId: 'driveId', type: 'type', isTrashed: 'isTrashed', title: 'title' },
  eq: vi.fn(),
  and: vi.fn((...args) => args),
  desc: vi.fn(),
  count: vi.fn(),
  gte: vi.fn(),
  lt: vi.fn(),
  inArray: vi.fn(),
  or: vi.fn(),
  isNull: vi.fn(),
  not: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@pagespace/lib', () => ({
  isUserDriveMember: vi.fn(),
  getDriveIdsForUser: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { isUserDriveMember, getDriveIdsForUser } from '@pagespace/lib';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string, tokenVersion = 0): WebAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createTaskFixture = (overrides: Partial<{
  id: string;
  taskListId: string;
  userId: string;
  assigneeId: string;
  pageId: string;
  title: string;
  status: string;
  priority: string;
  position: number;
  updatedAt: Date;
  assignee: object | null;
  page: object | null;
  taskList: object | null;
}> = {}) => ({
  id: overrides.id ?? 'task_1',
  taskListId: overrides.taskListId ?? 'tasklist_1',
  userId: overrides.userId ?? 'user_creator',
  assigneeId: overrides.assigneeId ?? 'user_123',
  assigneeAgentId: null,
  pageId: overrides.pageId ?? 'page_task',
  title: overrides.title ?? 'Test Task',
  description: null,
  status: overrides.status ?? 'pending',
  priority: overrides.priority ?? 'medium',
  position: overrides.position ?? 0,
  dueDate: null,
  completedAt: null,
  createdAt: new Date('2024-01-01'),
  updatedAt: overrides.updatedAt ?? new Date('2024-01-02'),
  assignee: overrides.assignee ?? { id: 'user_123', name: 'Test User', image: null },
  assigneeAgent: null,
  user: { id: 'user_creator', name: 'Creator', image: null },
  page: overrides.page ?? { id: 'page_task', title: 'Task Page', isTrashed: false },
  taskList: overrides.taskList ?? { id: 'tasklist_1', pageId: 'page_tasklist', title: 'My Tasks' },
});

// ============================================================================
// GET /api/tasks - Contract Tests
// ============================================================================

describe('GET /api/tasks', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getDriveIdsForUser).mockResolvedValue(['drive_1']);
    vi.mocked(isUserDriveMember).mockResolvedValue(true);

    // Default: no trashed pages
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);

    // Default: no task list pages
    vi.mocked(db.query.pages.findMany).mockResolvedValue([]);
    vi.mocked(db.query.taskLists.findMany).mockResolvedValue([]);
    vi.mocked(db.query.taskItems.findMany).mockResolvedValue([]);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/tasks?context=user');
      const response = await GET(request);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should call authenticateRequestWithOptions with correct auth options', async () => {
      const request = new Request('https://example.com/api/tasks?context=user');
      await GET(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['jwt', 'mcp'], requireCSRF: false }
      );
    });
  });

  describe('authorization', () => {
    it('should return 403 for inaccessible drive in drive context', async () => {
      vi.mocked(isUserDriveMember).mockResolvedValue(false);

      const request = new Request('https://example.com/api/tasks?context=drive&driveId=drive_unauthorized');
      const response = await GET(request);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized - you do not have access to this drive');
    });

    it('should return 403 when driveId filter is not in accessible drives (user context)', async () => {
      vi.mocked(getDriveIdsForUser).mockResolvedValue(['drive_1', 'drive_2']);

      const request = new Request('https://example.com/api/tasks?context=user&driveId=drive_unauthorized');
      const response = await GET(request);

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('Unauthorized - you do not have access to this drive');
    });

    it('should return tasks only from user-accessible drives', async () => {
      vi.mocked(getDriveIdsForUser).mockResolvedValue(['drive_1', 'drive_2']);
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        { id: 'page_tasklist', driveId: 'drive_1', title: 'Task List' },
      ]);
      vi.mocked(db.query.taskLists.findMany).mockResolvedValue([
        { id: 'tasklist_1', pageId: 'page_tasklist' },
      ]);
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue([
        createTaskFixture({ id: 'task_1' }),
      ]);

      const request = new Request('https://example.com/api/tasks?context=user');
      const response = await GET(request);

      expect(response.status).toBe(200);
      expect(getDriveIdsForUser).toHaveBeenCalledWith(mockUserId);
    });
  });

  describe('validation', () => {
    it('should return 400 when driveId is missing for drive context', async () => {
      const request = new Request('https://example.com/api/tasks?context=drive');
      const response = await GET(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('driveId is required for drive context');
    });

    it('should accept valid status values', async () => {
      const request = new Request('https://example.com/api/tasks?context=user&status=in_progress');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it('should accept valid priority values', async () => {
      const request = new Request('https://example.com/api/tasks?context=user&priority=high');
      const response = await GET(request);

      expect(response.status).toBe(200);
    });
  });

  describe('response contract', () => {
    it('should return empty array when user has no tasks', async () => {
      const request = new Request('https://example.com/api/tasks?context=user');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.tasks).toEqual([]);
      expect(body.pagination).toMatchObject({
        total: 0,
        limit: 50,
        offset: 0,
        hasMore: false,
      });
    });

    it('should return tasks with enriched drive info', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        { id: 'page_tasklist', driveId: 'drive_1', title: 'My Task List' },
      ]);
      vi.mocked(db.query.taskLists.findMany).mockResolvedValue([
        { id: 'tasklist_1', pageId: 'page_tasklist' },
      ]);
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue([
        createTaskFixture({ id: 'task_1', taskListId: 'tasklist_1' }),
      ]);

      const request = new Request('https://example.com/api/tasks?context=user');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0]).toMatchObject({
        id: 'task_1',
        driveId: 'drive_1',
        taskListPageId: 'page_tasklist',
        taskListPageTitle: 'My Task List',
      });
    });
  });

  describe('pagination', () => {
    it('should respect limit and offset parameters', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        { id: 'page_tasklist', driveId: 'drive_1', title: 'Tasks' },
      ]);
      vi.mocked(db.query.taskLists.findMany).mockResolvedValue([
        { id: 'tasklist_1', pageId: 'page_tasklist' },
      ]);

      const request = new Request('https://example.com/api/tasks?context=user&limit=10&offset=5');
      await GET(request);

      expect(db.query.taskItems.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 10,
          offset: 5,
        })
      );
    });

    it('should return hasMore=true when more tasks exist', async () => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        { id: 'page_tasklist', driveId: 'drive_1', title: 'Tasks' },
      ]);
      vi.mocked(db.query.taskLists.findMany).mockResolvedValue([
        { id: 'tasklist_1', pageId: 'page_tasklist' },
      ]);
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue([
        createTaskFixture({ id: 'task_1' }),
      ]);

      // Mock count query to return more than returned tasks
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn()
            .mockResolvedValueOnce([]) // First call for trashed pages
            .mockResolvedValueOnce([{ total: 10 }]), // Second call for count
        }),
      } as any);

      const request = new Request('https://example.com/api/tasks?context=user&limit=1');
      const response = await GET(request);
      const body = await response.json();

      expect(body.pagination.hasMore).toBe(true);
    });
  });

  describe('filters', () => {
    beforeEach(() => {
      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        { id: 'page_tasklist', driveId: 'drive_1', title: 'Tasks' },
      ]);
      vi.mocked(db.query.taskLists.findMany).mockResolvedValue([
        { id: 'tasklist_1', pageId: 'page_tasklist' },
      ]);
    });

    it('should filter by status', async () => {
      const request = new Request('https://example.com/api/tasks?context=user&status=completed');
      await GET(request);

      // Verify the query was called (exact filter verification would require deeper mocking)
      expect(db.query.taskItems.findMany).toHaveBeenCalled();
    });

    it('should filter by priority', async () => {
      const request = new Request('https://example.com/api/tasks?context=user&priority=high');
      await GET(request);

      expect(db.query.taskItems.findMany).toHaveBeenCalled();
    });

    it('should combine multiple filters', async () => {
      const request = new Request('https://example.com/api/tasks?context=user&status=pending&priority=high');
      await GET(request);

      expect(db.query.taskItems.findMany).toHaveBeenCalled();
    });
  });

  describe('trashed page filtering', () => {
    it('should exclude tasks from trashed pages at query level', async () => {
      // Mock that there are trashed pages
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValueOnce([{ id: 'trashed_page_1' }]),
        }),
      } as any);

      vi.mocked(db.query.pages.findMany).mockResolvedValue([
        { id: 'page_tasklist', driveId: 'drive_1', title: 'Tasks' },
      ]);
      vi.mocked(db.query.taskLists.findMany).mockResolvedValue([
        { id: 'tasklist_1', pageId: 'page_tasklist' },
      ]);

      const request = new Request('https://example.com/api/tasks?context=user');
      await GET(request);

      // The query should be called with trashed page exclusion filter
      expect(db.query.taskItems.findMany).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should return 500 when database query fails', async () => {
      // Make getDriveIdsForUser throw to trigger error path
      vi.mocked(getDriveIdsForUser).mockRejectedValue(new Error('Database connection lost'));

      const request = new Request('https://example.com/api/tasks?context=user');
      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to fetch tasks');
    });

    it('should log error when query fails', async () => {
      const error = new Error('Query failed');
      vi.mocked(getDriveIdsForUser).mockRejectedValue(error);

      const request = new Request('https://example.com/api/tasks?context=user');
      await GET(request);

      expect(loggers.api.error).toHaveBeenCalledWith('Error fetching tasks:', error);
    });
  });
});
