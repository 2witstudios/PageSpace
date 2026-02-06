import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { GET, POST } from '../route';
import { NextResponse } from 'next/server';

// Mock dependencies
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
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

import { authenticateRequestWithOptions } from '@/lib/auth';
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/server';
import { db } from '@pagespace/db';
import { broadcastTaskEvent } from '@/lib/websocket';

describe('Task API Routes', () => {
  const mockUserId = 'user-123';
  const mockPageId = 'page-456';
  const mockTaskListId = 'tasklist-789';

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mock for taskStatusConfigs.findMany
    (db.query.taskStatusConfigs.findMany as Mock).mockResolvedValue([]);
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
      (authenticateRequestWithOptions as Mock).mockResolvedValue({ error: mockAuthError });

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(401);
    });

    it('returns 403 when user lacks view permission', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue({ userId: mockUserId });
      (canUserViewPage as Mock).mockResolvedValue(false);

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

      (authenticateRequestWithOptions as Mock).mockResolvedValue({ userId: mockUserId });
      (canUserViewPage as Mock).mockResolvedValue(true);
      (db.query.taskLists.findFirst as Mock).mockResolvedValue(mockTaskList);
      (db.query.taskItems.findMany as Mock).mockResolvedValue(mockTasks);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.taskList.id).toBe(mockTaskListId);
      expect(body.tasks).toHaveLength(2);
    });

    it('creates task list if it does not exist', async () => {
      const mockInsertedTaskList = { id: 'new-tasklist', title: 'Task List', status: 'pending', updatedAt: new Date() };

      (authenticateRequestWithOptions as Mock).mockResolvedValue({ userId: mockUserId });
      (canUserViewPage as Mock).mockResolvedValue(true);
      (db.query.taskLists.findFirst as Mock).mockResolvedValue(null);
      // When task list doesn't exist, getOrCreateTaskListForPage uses db.transaction
      // The transaction mock creates it and returns the result
      (db.transaction as Mock).mockImplementationOnce(async (callback) => {
        const tx = {
          insert: vi.fn(() => ({
            values: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([mockInsertedTaskList]),
            })),
          })),
        };
        return callback(tx);
      });
      (db.query.taskItems.findMany as Mock).mockResolvedValue([]);

      const response = await GET(createRequest(), { params: mockParams });

      expect(db.transaction).toHaveBeenCalled();
      expect(response.status).toBe(200);
    });

    it('filters tasks by search query', async () => {
      const mockTasks = [
        { id: 'task-1', title: 'Buy groceries', description: 'Milk, bread', status: 'pending' },
        { id: 'task-2', title: 'Call mom', description: null, status: 'pending' },
      ];
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };

      (authenticateRequestWithOptions as Mock).mockResolvedValue({ userId: mockUserId });
      (canUserViewPage as Mock).mockResolvedValue(true);
      (db.query.taskLists.findFirst as Mock).mockResolvedValue(mockTaskList);
      (db.query.taskItems.findMany as Mock).mockResolvedValue(mockTasks);

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
      (authenticateRequestWithOptions as Mock).mockResolvedValue({ error: mockAuthError });

      const response = await POST(createRequest({ title: 'New Task' }), { params: mockParams });

      expect(response.status).toBe(401);
    });

    it('returns 403 when user lacks edit permission', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue({ userId: mockUserId });
      (canUserEditPage as Mock).mockResolvedValue(false);

      const response = await POST(createRequest({ title: 'New Task' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('You need edit permission to add tasks');
    });

    it('returns 400 when title is missing', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue({ userId: mockUserId });
      (canUserEditPage as Mock).mockResolvedValue(true);

      const response = await POST(createRequest({}), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Title is required');
    });

    it('returns 400 when title is empty', async () => {
      (authenticateRequestWithOptions as Mock).mockResolvedValue({ userId: mockUserId });
      (canUserEditPage as Mock).mockResolvedValue(true);

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

      (authenticateRequestWithOptions as Mock).mockResolvedValue({ userId: mockUserId });
      (canUserEditPage as Mock).mockResolvedValue(true);
      (db.query.pages.findFirst as Mock).mockResolvedValue({ id: mockPageId, driveId: 'drive-123' });
      (db.query.taskLists.findFirst as Mock).mockResolvedValue(mockTaskList);
      // taskStatusConfigs.findMany returns empty (no status validation needed for default 'pending')
      (db.query.taskStatusConfigs.findMany as Mock).mockResolvedValue([]);
      (db.query.taskItems.findFirst as Mock)
        .mockResolvedValueOnce(null) // For position calculation (lastTask)
        .mockResolvedValueOnce({ ...mockNewTask, assignee: null, user: null, assignees: [] }); // For returning with relations

      // pages.findFirst is also called for lastChildPage via Promise.all - set up correct mock chain
      // First call: taskListPage lookup, Second call: (from query) finding task with relations
      // Actually pages.findFirst is called once for taskListPage, then db.query.pages.findFirst for lastChildPage
      (db.query.pages.findFirst as Mock)
        .mockResolvedValueOnce({ id: mockPageId, driveId: 'drive-123' }) // taskListPage
        .mockResolvedValueOnce(null); // lastChildPage (no existing children)

      const response = await POST(createRequest({ title: 'New Task' }), { params: mockParams });

      expect(response.status).toBe(201);
      expect(broadcastTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'task_added',
        taskId: 'new-task',
        pageId: mockPageId,
      }));
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

      (authenticateRequestWithOptions as Mock).mockResolvedValue({ userId: mockUserId });
      (canUserEditPage as Mock).mockResolvedValue(true);
      // Status validation: return configs with in_progress as valid
      (db.query.taskStatusConfigs.findMany as Mock).mockResolvedValue([
        { slug: 'pending' },
        { slug: 'in_progress' },
        { slug: 'completed' },
      ]);
      (db.query.pages.findFirst as Mock)
        .mockResolvedValueOnce({ id: mockPageId, driveId: 'drive-123' }) // taskListPage
        .mockResolvedValueOnce(null); // lastChildPage
      (db.query.taskLists.findFirst as Mock).mockResolvedValue(mockTaskList);
      (db.query.taskItems.findFirst as Mock)
        .mockResolvedValueOnce({ position: 0 }) // lastTask for position calculation
        .mockResolvedValueOnce({ ...mockNewTask, assignee: { id: 'user-456', name: 'Assignee' }, user: null, assignees: [] });

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
