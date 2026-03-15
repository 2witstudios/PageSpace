import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, POST } from '../route';
import { NextResponse } from 'next/server';

// Mock dependencies
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
}));

vi.mock('@pagespace/lib/server', () => ({
  canUserViewPage: vi.fn(),
  canUserEditPage: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  PageType: {
    DOCUMENT: 'DOCUMENT',
    FOLDER: 'FOLDER',
    TASK_LIST: 'TASK_LIST',
  },
  getDefaultContent: vi.fn(() => '{}'),
  logger: {
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ name: 'Test User', email: 'test@test.com' }),
  logPageActivity: vi.fn(),
}));

// Track mock values for transaction
let transactionPageResult = [{ id: 'mock-page-id', title: 'Mock Page' }];
let transactionTaskResult = [{ id: 'mock-task-id', title: 'Mock Task' }];

// REVIEW: Deep ORM chain mocks (db.insert().values().returning(), db.transaction(tx => ...))
// are used here because the route directly calls Drizzle ORM with no service layer.
// The ORM IS the system boundary for this route. Extracting a service seam is a production refactor.
vi.mock('@pagespace/db', () => {
  const mockInsert = vi.fn(() => ({
    values: vi.fn(() => ({
      returning: vi.fn(),
    })),
  }));

  return {
    db: {
      query: {
        taskLists: {
          findFirst: vi.fn(),
        },
        taskItems: {
          findFirst: vi.fn(),
          findMany: vi.fn(),
        },
        taskStatusConfigs: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        pages: {
          findFirst: vi.fn(),
        },
      },
      insert: mockInsert,
      transaction: vi.fn(async (callback) => {
        let insertCallCount = 0;
        // Create a tx object that mimics the transaction context
        const tx = {
          insert: vi.fn(() => ({
            values: vi.fn(() => ({
              returning: vi.fn().mockImplementation(() => {
                insertCallCount++;
                // First insert is for pages, second is for taskItems
                return Promise.resolve(insertCallCount === 1 ? transactionPageResult : transactionTaskResult);
              }),
            })),
          })),
        };
        return callback(tx);
      }),
    },
    taskLists: {},
    taskItems: {},
    taskStatusConfigs: {},
    taskAssignees: {},
    pages: {},
    DEFAULT_TASK_STATUSES: [
      { slug: 'pending', name: 'To Do', color: 'bg-slate-100 text-slate-700', group: 'todo', position: 0 },
      { slug: 'in_progress', name: 'In Progress', color: 'bg-amber-100 text-amber-700', group: 'in_progress', position: 1 },
      { slug: 'blocked', name: 'Blocked', color: 'bg-red-100 text-red-700', group: 'in_progress', position: 2 },
      { slug: 'completed', name: 'Done', color: 'bg-green-100 text-green-700', group: 'done', position: 3 },
    ],
    eq: vi.fn((field, value) => ({ field, value })),
    and: vi.fn((...conditions) => conditions),
    asc: vi.fn((col) => ({ type: 'asc', col })),
    desc: vi.fn((col) => ({ type: 'desc', col })),
  };
});

vi.mock('@/lib/websocket', () => ({
  broadcastTaskEvent: vi.fn(),
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn(() => ({})),
}));

import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/server';
import { db } from '@pagespace/db';
import { broadcastTaskEvent } from '@/lib/websocket';

describe('Task API Routes', () => {
  const mockUserId = 'user-123';
  const mockPageId = 'page-456';
  const mockTaskListId = 'tasklist-789';

  beforeEach(() => {
    vi.resetAllMocks();
    // Reset default mock for taskStatusConfigs.findMany
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);
    vi.mocked(isAuthError).mockImplementation((result: unknown) => result != null && typeof result === 'object' && 'error' in result);
    vi.mocked(checkMCPPageScope).mockResolvedValue(null);
    // Re-set up db.insert to default chain
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn(),
      })),
    } as never);
    // Re-set up db.transaction
    // @ts-expect-error - partial mock data
    vi.mocked(db.transaction).mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      let insertCallCount = 0;
      const tx = {
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            returning: vi.fn().mockImplementation(() => {
              insertCallCount++;
              return Promise.resolve(insertCallCount === 1 ? transactionPageResult : transactionTaskResult);
            }),
          })),
        })),
      };
      return callback(tx);
    });
  });

  describe('GET /api/pages/[pageId]/tasks', () => {
    const createRequest = (searchParams = '') => {
      return new Request(`https://example.com/api/pages/${mockPageId}/tasks${searchParams}`, {
        method: 'GET',
      });
    };

    const mockParams = Promise.resolve({ pageId: mockPageId });

    it('returns 401 when user is not authenticated', async () => {
      const mockAuthError = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error: mockAuthError } as never);

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(401);
    });

    it('returns 403 when user lacks view permission', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('You need view permission to access this task list');
    });

    it('returns tasks when user has view permission', async () => {
      const mockTasks = [
        { id: 'task-1', title: 'Task 1', status: 'pending' },
        { id: 'task-2', title: 'Task 2', status: 'completed' },
      ];
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue(mockTasks as never);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.taskList.id).toBe(mockTaskListId);
      expect(body.tasks).toHaveLength(2);
    });

    it('creates task list if it does not exist', async () => {
      const mockInsertedTaskList = { id: 'new-tasklist', title: 'Task List', status: 'pending', updatedAt: new Date() };

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(null as never);
      // When task list doesn't exist, getOrCreateTaskListForPage uses db.transaction
      // The transaction mock creates it and returns the result
      vi.mocked(db.transaction).mockImplementationOnce(async (callback) => {
        const tx = {
          insert: vi.fn(() => ({
            values: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([mockInsertedTaskList]),
            })),
          })),
        };
        return callback(tx as never);
      });
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue([] as never);

      const response = await GET(createRequest(), { params: mockParams });

      expect(db.transaction).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it('sorts tasks in descending order when sortOrder is desc', async () => {
      const mockTasks = [
        { id: 'task-1', title: 'First', position: 0, page: { position: 0, isTrashed: false } },
        { id: 'task-2', title: 'Second', position: 1, page: { position: 1, isTrashed: false } },
      ];
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue(mockTasks as never);

      const response = await GET(createRequest('?sortOrder=desc'), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      // In desc order, task-2 (position 1) should come first
      expect(body.tasks[0].id).toBe('task-2');
      expect(body.tasks[1].id).toBe('task-1');
    });

    it('filters out trashed tasks', async () => {
      const mockTasks = [
        { id: 'task-1', title: 'Active', position: 0, page: { position: 0, isTrashed: false } },
        { id: 'task-2', title: 'Trashed', position: 1, page: { position: 1, isTrashed: true } },
      ];
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue(mockTasks as never);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].title).toBe('Active');
    });

    it('uses task.position as fallback when page.position is undefined', async () => {
      const mockTasks = [
        { id: 'task-1', title: 'No Page', position: 5, page: null },
        { id: 'task-2', title: 'Has Page', position: 3, page: { position: 2, isTrashed: false } },
      ];
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue(mockTasks as never);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      // task-2 has page.position 2, task-1 has no page so uses task.position 5
      expect(body.tasks[0].id).toBe('task-2');
      expect(body.tasks[1].id).toBe('task-1');
    });

    it('inserts default status configs when existing task list has none (migration path)', async () => {
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskStatusConfigs.findMany)
        .mockResolvedValueOnce([] as never)  // existingConfigs check returns empty
        .mockResolvedValueOnce([] as never); // statusConfigs for response
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue([] as never);

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(200);
      // db.insert should have been called to create default status configs
      expect(db.insert).toHaveBeenCalled();
    });

    it('swallows duplicate key errors during status config migration', async () => {
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskStatusConfigs.findMany)
        .mockResolvedValueOnce([] as never)  // existingConfigs check returns empty
        .mockResolvedValueOnce([] as never); // statusConfigs for response
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue([] as never);

      // Simulate duplicate key error
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockRejectedValue(new Error('unique constraint violation')),
      } as never);

      const response = await GET(createRequest(), { params: mockParams });

      // Should not throw - error is swallowed
      expect(response.status).toBe(200);
    });

    it('rethrows non-duplicate errors during status config migration', async () => {
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskStatusConfigs.findMany)
        .mockResolvedValueOnce([] as never);
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue([] as never);

      // Simulate a real error (not duplicate key)
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockRejectedValue(new Error('connection refused')),
      } as never);

      await expect(GET(createRequest(), { params: mockParams })).rejects.toThrow('connection refused');
    });

    it('searches by description', async () => {
      const mockTasks = [
        { id: 'task-1', title: 'Generic', description: 'Buy groceries', status: 'pending' },
        { id: 'task-2', title: 'Call mom', description: null, status: 'pending' },
      ];
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue(mockTasks as never);

      const response = await GET(createRequest('?search=groceries'), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].id).toBe('task-1');
    });

    it('filters tasks by search query', async () => {
      const mockTasks = [
        { id: 'task-1', title: 'Buy groceries', description: 'Milk, bread', status: 'pending' },
        { id: 'task-2', title: 'Call mom', description: null, status: 'pending' },
      ];
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue(mockTasks as never);

      const response = await GET(createRequest('?search=groceries'), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].title).toBe('Buy groceries');
    });
  });

  describe('POST /api/pages/[pageId]/tasks', () => {
    const createRequest = (body: Record<string, unknown>) => {
      return new Request(`https://example.com/api/pages/${mockPageId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    };

    const mockParams = Promise.resolve({ pageId: mockPageId });

    it('returns 401 when user is not authenticated', async () => {
      const mockAuthError = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error: mockAuthError } as never);

      const response = await POST(createRequest({ title: 'New Task' }), { params: mockParams });

      expect(response.status).toBe(401);
    });

    it('returns 403 when user lacks edit permission', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(false);

      const response = await POST(createRequest({ title: 'New Task' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('You need edit permission to add tasks');
    });

    it('returns 400 when title is missing', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);

      const response = await POST(createRequest({}), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Title is required');
    });

    it('returns 400 when title is empty', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);

      const response = await POST(createRequest({ title: '   ' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Title is required');
    });

    it('creates task with required fields only', async () => {
      const mockTaskList = { id: mockTaskListId };
      const mockNewTask = {
        id: 'new-task',
        title: 'New Task',
        status: 'pending',
        priority: 'medium',
        position: 0,
      };
      const mockNewPage = {
        id: 'new-page',
        title: 'New Task',
        type: 'DOCUMENT',
      };

      // Configure transaction to return expected values
      transactionPageResult = [mockNewPage];
      transactionTaskResult = [mockNewTask];

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: mockPageId, driveId: 'drive-123' } as never);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      // taskStatusConfigs.findMany returns empty (no status validation needed for default 'pending')
      vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);
      vi.mocked(db.query.taskItems.findFirst)
        .mockResolvedValueOnce(null as never) // For position calculation (lastTask)
        .mockResolvedValueOnce({ ...mockNewTask, assignee: null, user: null, assignees: [] } as never); // For returning with relations

      // pages.findFirst is also called for lastChildPage via Promise.all - set up correct mock chain
      // First call: taskListPage lookup, Second call: (from query) finding task with relations
      // Actually pages.findFirst is called once for taskListPage, then db.query.pages.findFirst for lastChildPage
      vi.mocked(db.query.pages.findFirst)
        .mockResolvedValueOnce({ id: mockPageId, driveId: 'drive-123' } as never) // taskListPage
        .mockResolvedValueOnce(null as never); // lastChildPage (no existing children)

      const response = await POST(createRequest({ title: 'New Task' }), { params: mockParams });

      expect(response.status).toBe(201);
      expect(broadcastTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'task_added',
        taskId: 'new-task',
        pageId: mockPageId,
      }));
    });

    it('returns 404 when task list page not found', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue(null as never);

      const response = await POST(createRequest({ title: 'New Task' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Task list page not found');
    });

    it('returns 400 when title is not a string', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);

      const response = await POST(createRequest({ title: 123 }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Title is required');
    });

    it('returns 400 when status is invalid', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
      vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: mockPageId, driveId: 'drive-123' } as never);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue({ id: mockTaskListId } as never);
      vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([
        { slug: 'pending' },
        { slug: 'completed' },
      ] as never);

      const response = await POST(createRequest({ title: 'Task', status: 'invalid_status' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid status');
    });

    it('returns 400 when assigneeAgentId is invalid', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
      vi.mocked(db.query.pages.findFirst)
        .mockResolvedValueOnce({ id: mockPageId, driveId: 'drive-123' } as never) // taskListPage
        .mockResolvedValueOnce(null as never); // agentPage not found

      const response = await POST(createRequest({ title: 'Task', assigneeAgentId: 'bad-agent' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Invalid agent ID - must be an AI agent page');
    });

    it('returns 400 when assigneeAgentId is in different drive', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
      vi.mocked(db.query.pages.findFirst)
        .mockResolvedValueOnce({ id: mockPageId, driveId: 'drive-123' } as never) // taskListPage
        .mockResolvedValueOnce({ id: 'agent-page', driveId: 'different-drive' } as never); // agentPage in different drive

      const response = await POST(createRequest({ title: 'Task', assigneeAgentId: 'agent-page' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Agent must be in the same drive as the task list');
    });

    it('creates task with assigneeIds array (multi-assignee)', async () => {
      const mockTaskList = { id: mockTaskListId };
      const mockNewTask = {
        id: 'new-task',
        title: 'Multi Task',
        status: 'pending',
        priority: 'medium',
        position: 0,
      };
      const mockNewPage = {
        id: 'new-page',
        title: 'Multi Task',
        type: 'DOCUMENT',
      };

      transactionPageResult = [mockNewPage];
      transactionTaskResult = [mockNewTask];

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
      vi.mocked(db.query.pages.findFirst)
        .mockResolvedValueOnce({ id: mockPageId, driveId: 'drive-123' } as never) // taskListPage
        .mockResolvedValueOnce(null as never); // lastChildPage
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);
      vi.mocked(db.query.taskItems.findFirst)
        .mockResolvedValueOnce(null as never) // lastTask
        .mockResolvedValueOnce({ ...mockNewTask, assignee: null, user: null, assignees: [] } as never);

      const response = await POST(createRequest({
        title: 'Multi Task',
        assigneeIds: [
          { type: 'user', id: 'user-a' },
          { type: 'agent', id: 'agent-b' },
        ],
      }), { params: mockParams });

      expect(response.status).toBe(201);
    });

    it('creates task with legacy single assigneeAgentId (backward compat)', async () => {
      const mockTaskList = { id: mockTaskListId };
      const mockNewTask = {
        id: 'new-task',
        title: 'Agent Task',
        status: 'pending',
        priority: 'medium',
        position: 0,
      };
      const mockNewPage = {
        id: 'new-page',
        title: 'Agent Task',
        type: 'DOCUMENT',
      };

      transactionPageResult = [mockNewPage];
      transactionTaskResult = [mockNewTask];

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
      vi.mocked(db.query.pages.findFirst)
        .mockResolvedValueOnce({ id: mockPageId, driveId: 'drive-123' } as never) // taskListPage
        .mockResolvedValueOnce({ id: 'agent-page', driveId: 'drive-123' } as never) // agentPage valid
        .mockResolvedValueOnce(null as never); // lastChildPage
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);
      vi.mocked(db.query.taskItems.findFirst)
        .mockResolvedValueOnce(null as never) // lastTask
        .mockResolvedValueOnce({ ...mockNewTask, assignee: null, user: null, assignees: [] } as never);

      const response = await POST(createRequest({
        title: 'Agent Task',
        assigneeAgentId: 'agent-page',
      }), { params: mockParams });

      expect(response.status).toBe(201);
    });

    it('creates task with all optional fields', async () => {
      const mockTaskList = { id: mockTaskListId };
      const mockNewTask = {
        id: 'new-task',
        title: 'Complete Task',
        description: 'With description',
        status: 'in_progress',
        priority: 'high',
        position: 1,
        dueDate: '2024-12-31',
        assigneeId: 'user-456',
      };
      const mockNewPage = {
        id: 'new-page',
        title: 'Complete Task',
        type: 'DOCUMENT',
      };

      // Configure transaction to return expected values
      transactionPageResult = [mockNewPage];
      transactionTaskResult = [mockNewTask];

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
      // Status validation: return configs with in_progress as valid
      vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([
        { slug: 'pending' },
        { slug: 'in_progress' },
        { slug: 'completed' },
      ] as never);
      vi.mocked(db.query.pages.findFirst)
        .mockResolvedValueOnce({ id: mockPageId, driveId: 'drive-123' } as never) // taskListPage
        .mockResolvedValueOnce(null as never); // lastChildPage
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskItems.findFirst)
        .mockResolvedValueOnce({ position: 0 } as never) // lastTask for position calculation
        .mockResolvedValueOnce({ ...mockNewTask, assignee: { id: 'user-456', name: 'Assignee' }, user: null, assignees: [] } as never);

      const response = await POST(createRequest({
        title: 'Complete Task',
        description: 'With description',
        status: 'in_progress',
        priority: 'high',
        dueDate: '2024-12-31',
        assigneeId: 'user-456',
      }), { params: mockParams });

      expect(response.status).toBe(201);
    });
  });
});
