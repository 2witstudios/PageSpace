import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GET, POST } from '../route';
import { computeHasContent } from '../task-utils';
import { reorderTaskPeers } from '@/lib/ai/tools/task-helpers';
import { NextResponse } from 'next/server';

// Mock dependencies
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
  canPrincipalViewPage: async (auth: { userId: string }, pageId: string) => {
    const { canUserViewPage } = await import('@pagespace/lib/permissions/permissions');
    return canUserViewPage(auth.userId, pageId);
  },
  canPrincipalEditPage: async (auth: { userId: string }, pageId: string) => {
    const { canUserEditPage } = await import('@pagespace/lib/permissions/permissions');
    return canUserEditPage(auth.userId, pageId);
  },
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn(),
  canUserEditPage: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/utils/enums', () => ({
    PageType: {
    DOCUMENT: 'DOCUMENT',
    FOLDER: 'FOLDER',
    TASK_LIST: 'TASK_LIST',
  },
}));
vi.mock('@pagespace/lib/content/page-types.config', () => ({
    getDefaultContent: vi.fn(() => '{}'),
    getCreatablePageTypes: vi.fn(() => ['FOLDER', 'DOCUMENT', 'CHANNEL', 'AI_CHAT', 'CANVAS', 'SHEET', 'TASK_LIST', 'CODE']),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => {
  const child = vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
  const mkLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child });
  return {
    loggers: {
      api: mkLogger(),
      ai: mkLogger(),
      auth: mkLogger(),
      security: mkLogger(),
    },
    logger: { child },
  };
});

vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ name: 'Test User', email: 'test@test.com' }),
  logPageActivity: vi.fn(),
}));

// The route delegates an explicit `position` to the shared task move, which reads and
// writes pages.position — the single ordering rail (#2143).
vi.mock('@/lib/ai/tools/task-helpers', () => ({
  reorderTaskPeers: vi.fn().mockResolvedValue({ index: 0, position: 0 }),
}));

// Track mock values for transaction
let transactionPageResult = [{ id: 'mock-page-id', title: 'Mock Page' }];
let transactionTaskResult = [{ id: 'mock-task-id', title: 'Mock Task' }];

// REVIEW: Deep ORM chain mocks (db.insert().values().returning(), db.transaction(tx => ...))
// are used here because the route directly calls Drizzle ORM with no service layer.
// The ORM IS the system boundary for this route. Extracting a service seam is a production refactor.
vi.mock('@pagespace/db/db', () => {
  const mockInsert = vi.fn(() => ({
    values: vi.fn(() => ({
      returning: vi.fn(),
    })),
  }));
  // Supports three select patterns in the route:
  // 1. childPages: await db.select().from(pages).where(...)           — thenable chain
  // 2. triggerRows: await db.select().from(triggers).where().groupBy()
  // 3. subTaskRows: await db.select().from(items).innerJoin().where().groupBy()
  const makeSelectChain = (result: unknown[] = [{ id: 'child-page-id', pageId: 'child-page-id' }]) => {
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
      catch: (reject: (e: unknown) => unknown) => Promise.resolve(result).catch(reject),
    };
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.groupBy = vi.fn().mockResolvedValue([]);
    chain.limit = vi.fn(() => chain);
    chain.offset = vi.fn(() => chain);
    return chain;
  };
  const mockSelect = vi.fn(() => makeSelectChain());
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
      select: mockSelect,
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
  };
});
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field, value) => ({ field, value })),
  and: vi.fn((...conditions) => conditions),
  asc: vi.fn((col) => ({ type: 'asc', col })),
  desc: vi.fn((col) => ({ type: 'desc', col })),
  inArray: vi.fn((col, values) => ({ type: 'inArray', col, values })),
  count: vi.fn(() => ({ type: 'count' })),
  isNotNull: vi.fn((col) => ({ type: 'isNotNull', col })),
  ilike: vi.fn((col, pattern) => ({ type: 'ilike', col, pattern })),
  sql: vi.fn((strings, ...values) => ({ type: 'sql', strings, values })),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: {},
}));
vi.mock('@pagespace/db/schema/workflows', () => ({
  workflows: { taskItemId: 'taskItemId-col', isEnabled: 'isEnabled-col', triggerType: 'triggerType-col' },
}));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskLists: {},
  taskItems: {},
  taskStatusConfigs: {},
  taskAssignees: {},
  DEFAULT_TASK_STATUSES: [
      { slug: 'pending', name: 'To Do', color: 'bg-slate-100 text-slate-700', group: 'todo', position: 0 },
      { slug: 'in_progress', name: 'In Progress', color: 'bg-amber-100 text-amber-700', group: 'in_progress', position: 1 },
      { slug: 'blocked', name: 'Blocked', color: 'bg-red-100 text-red-700', group: 'in_progress', position: 2 },
      { slug: 'completed', name: 'Done', color: 'bg-green-100 text-green-700', group: 'done', position: 3 },
    ],
}));

vi.mock('@/lib/websocket', () => ({
  broadcastTaskEvent: vi.fn(),
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn(() => ({})),
}));

const mockCreateMentionNotification = vi.fn().mockResolvedValue(undefined);
vi.mock('@pagespace/lib/notifications/notifications', () => ({
  createMentionNotification: (...args: unknown[]) => mockCreateMentionNotification(...args),
}));

vi.mock('@/lib/workflows/task-trigger-helpers', () => ({
  createTaskTriggerWorkflow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/ai/core/personalization-utils', () => ({
  getUserTimezone: vi.fn().mockResolvedValue(undefined),
}));

import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/permissions/permissions'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { createTaskTriggerWorkflow } from '@/lib/workflows/task-trigger-helpers';
import { getUserTimezone } from '@/lib/ai/core/personalization-utils';
import { db } from '@pagespace/db/db';
import { inArray, ilike } from '@pagespace/db/operators';
import { broadcastTaskEvent } from '@/lib/websocket';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

describe('computeHasContent', () => {
  it('null content', () => {
    assert({ given: 'null', should: 'return false', actual: computeHasContent(null), expected: false });
  });
  it('undefined content', () => {
    assert({ given: 'undefined', should: 'return false', actual: computeHasContent(undefined), expected: false });
  });
  it('empty string', () => {
    assert({ given: 'empty string', should: 'return false', actual: computeHasContent(''), expected: false });
  });
  it('HTML with no visible text', () => {
    assert({ given: '<p></p>', should: 'return false', actual: computeHasContent('<p></p>'), expected: false });
  });
  it('HTML with whitespace only', () => {
    assert({ given: '<p>   </p>', should: 'return false', actual: computeHasContent('<p>   </p>'), expected: false });
  });
  it('HTML with real text content', () => {
    assert({ given: '<p>Hello</p>', should: 'return true', actual: computeHasContent('<p>Hello</p>'), expected: true });
  });
  it('nested HTML with text', () => {
    assert({ given: '<h1>Title</h1><p>Body</p>', should: 'return true', actual: computeHasContent('<h1>Title</h1><p>Body</p>'), expected: true });
  });
});

describe('Task API Routes', () => {
  const mockUserId = 'user-123';
  const mockPageId = 'page-456';
  const mockTaskListId = 'tasklist-789';

  // Build a thenable select chain that resolves to `result`
  const makeSelectChain = (result: unknown[] = [{ id: 'child-page-id', pageId: 'child-page-id' }]) => {
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
      catch: (reject: (e: unknown) => unknown) => Promise.resolve(result).catch(reject),
    };
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.groupBy = vi.fn().mockResolvedValue([]);
    chain.limit = vi.fn(() => chain);
    chain.offset = vi.fn(() => chain);
    return chain;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    // vi.resetAllMocks() clears mockCreateMentionNotification's implementation,
    // making .catch() throw TypeError and silently hide the success path.
    mockCreateMentionNotification.mockResolvedValue(undefined);
    // Reset default mock for taskStatusConfigs.findMany
    vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);
    vi.mocked(isAuthError).mockImplementation((result: unknown) => result != null && typeof result === 'object' && 'error' in result);
    vi.mocked(checkMCPPageScope).mockResolvedValue(null);
    vi.mocked(auditRequest).mockReturnValue(undefined);
    // resetAllMocks() also wipes the @pagespace/db/operators factory mocks; inArray's
    // return value is inspected directly by the bounded-query regression test below.
    vi.mocked(inArray).mockImplementation(((col: unknown, values: unknown) => ({ type: 'inArray', col, values })) as never);
    // Re-set up db.insert to default chain
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn(),
      })),
    } as never);
    // Re-set up db.select to support all three select patterns in the route
    vi.mocked(db.select).mockImplementation(() => makeSelectChain() as never);
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
        { id: 'task-1', status: 'pending', page: { id: 'p-1', title: 'Task 1', isTrashed: false, position: 0 } },
        { id: 'task-2', status: 'completed', page: { id: 'p-2', title: 'Task 2', isTrashed: false, position: 1 } },
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

      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(200);
    });

    it('sorts tasks in descending order when sortOrder is desc', async () => {
      const mockTasks = [
        { id: 'task-1', position: 0, page: { id: 'p-1', title: 'First', position: 0, isTrashed: false } },
        { id: 'task-2', position: 1, page: { id: 'p-2', title: 'Second', position: 1, isTrashed: false } },
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
      // isTrashed filtering is DB-side: the childPages query only returns non-trashed
      // page IDs, so task-2 (trashed) is never included in taskItems.findMany results.
      const activeTask = { id: 'task-1', position: 0, page: { id: 'p-1', title: 'Active', position: 0, isTrashed: false } };
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      // childPages query returns only the non-trashed page (DB filters isTrashed=false).
      // The same shape feeds the self-heal existence check (reads pageId) so it's a no-op.
      vi.mocked(db.select).mockImplementation(() => makeSelectChain([{ id: 'p-1', pageId: 'p-1' }]) as never);
      // taskItems.findMany only receives p-1 in its inArray clause, returns the active task
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue([activeTask] as never);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].title).toBe('Active');
    });

    it('sorts a task whose page failed to hydrate last rather than to slot 0 (#2143)', async () => {
      // pages.position is the only ordering rail; a task row carries no position of
      // its own, so a missing page means no position at all — it must not be coerced
      // to 0 and jump the list.
      const mockTasks = [
        { id: 'task-1', page: null },
        { id: 'task-2', page: { id: 'p-2', title: 'Has Page', position: 2, isTrashed: false } },
      ];
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue(mockTasks as never);

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.tasks[0].id).toBe('task-2');
      expect(body.tasks[1].id).toBe('task-1');
      // And the position it reports comes from the page, not from a task row field.
      expect(body.tasks[0].position).toBe(2);
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
      expect(db.insert).toHaveBeenCalledTimes(1);
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
        values: vi.fn().mockRejectedValueOnce(new Error('unique constraint violation')),
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
        values: vi.fn().mockRejectedValueOnce(new Error('connection refused')),
      } as never);

      await expect(GET(createRequest(), { params: mockParams })).rejects.toThrow('connection refused');
    });


    it('filters tasks by search query (phase-1 bounded query narrows by ilike on page.title)', async () => {
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };
      const childPageRows = [
        { id: 'p-1', pageId: 'p-1' },
        { id: 'p-2', pageId: 'p-2' },
      ];
      // Stands in for the phase-1 query already applying ilike(pages.title, '%groceries%') —
      // only p-1's task matches, so only its id reaches phase 2.
      const boundedIdRows = [{ id: 'task-1' }];
      const allTasks = [
        { id: 'task-1', position: 0, page: { id: 'p-1', title: 'Buy groceries', isTrashed: false, position: 0 } },
        { id: 'task-2', position: 1, page: { id: 'p-2', title: 'Call mom', isTrashed: false, position: 1 } },
      ];

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);

      vi.mocked(db.select)
        .mockImplementationOnce(() => makeSelectChain(childPageRows) as never) // childPages
        .mockImplementationOnce(() => makeSelectChain(childPageRows) as never) // backfill existingRows
        .mockImplementationOnce(() => makeSelectChain(boundedIdRows) as never) // phase 1: search-filtered ids
        .mockImplementation(() => makeSelectChain([]) as never); // trigger / sub-task counts

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(db.query.taskItems.findMany).mockImplementation(((args: any) => {
        const ids: string[] = args?.where?.values ?? [];
        return Promise.resolve(allTasks.filter(t => ids.includes(t.id)));
      }) as never);

      const response = await GET(createRequest('?search=groceries'), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].title).toBe('Buy groceries');
    });

    it('escapes LIKE metacharacters in the search term before building the ilike pattern (regression: over-matching fix)', async () => {
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue([] as never);

      // A task titled "100% done" contains a literal '%' — if it reaches ilike()
      // unescaped, Postgres reads it as a wildcard instead of a literal character.
      const response = await GET(createRequest(`?search=${encodeURIComponent('100% done')}`), { params: mockParams });

      expect(response.status).toBe(200);
      expect(vi.mocked(ilike).mock.calls[0]?.[1]).toBe('%100\\% done%');
    });

    it('tiebreaks the phase-1 order by taskItems.id (regression: non-deterministic paging when positions collide)', async () => {
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };
      // A read-then-write race in POST's nextPosition, or a backfilled page that never got
      // a distinct position, can leave two tasks sharing the same page.position — without a
      // secondary sort key, LIMIT/OFFSET has no guaranteed stable order across repeated calls.
      const phase1Chain = makeSelectChain([{ id: 'task-1' }]);

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskItems.findMany).mockResolvedValue([] as never);

      vi.mocked(db.select)
        .mockImplementationOnce(() => makeSelectChain([{ id: 'p-1', pageId: 'p-1' }]) as never) // childPages
        .mockImplementationOnce(() => makeSelectChain([{ id: 'p-1', pageId: 'p-1' }]) as never) // backfill existingRows
        .mockImplementationOnce(() => phase1Chain as never) // phase 1: the query under test
        .mockImplementation(() => makeSelectChain([]) as never); // trigger / sub-task counts

      const response = await GET(createRequest(), { params: mockParams });

      expect(response.status).toBe(200);
      expect(phase1Chain.orderBy).toHaveBeenCalledTimes(1);
      // Primary sort key (pages.position) plus a taskItems.id tiebreaker.
      expect((phase1Chain.orderBy as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(2);
    });

    it('caps the result to the requested limit and hydrates only the bounded ids (regression: OOM crash fix)', async () => {
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };
      // 5 TASK_LIST children — more than the ?limit=2 requested below.
      const childPageRows = [
        { id: 'p-1', pageId: 'p-1' },
        { id: 'p-2', pageId: 'p-2' },
        { id: 'p-3', pageId: 'p-3' },
        { id: 'p-4', pageId: 'p-4' },
        { id: 'p-5', pageId: 'p-5' },
      ];
      // Stands in for the phase-1 bounded+ordered join query already applying LIMIT 2
      // at the DB level — the crash-prevention behavior under test.
      const boundedIdRows = [{ id: 'task-2' }, { id: 'task-1' }];
      const allTasks = [
        { id: 'task-1', position: 0, page: { id: 'p-1', title: 'Task One', isTrashed: false, position: 0 } },
        { id: 'task-2', position: 1, page: { id: 'p-2', title: 'Task Two', isTrashed: false, position: 1 } },
        { id: 'task-3', position: 2, page: { id: 'p-3', title: 'Task Three', isTrashed: false, position: 2 } },
        { id: 'task-4', position: 3, page: { id: 'p-4', title: 'Task Four', isTrashed: false, position: 3 } },
        { id: 'task-5', position: 4, page: { id: 'p-5', title: 'Task Five', isTrashed: false, position: 4 } },
      ];

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);

      vi.mocked(db.select)
        .mockImplementationOnce(() => makeSelectChain(childPageRows) as never) // childPages
        .mockImplementationOnce(() => makeSelectChain(childPageRows) as never) // backfill existingRows (nothing missing)
        .mockImplementationOnce(() => makeSelectChain(boundedIdRows) as never) // phase 1: bounded + ordered ids
        .mockImplementation(() => makeSelectChain([]) as never); // trigger / sub-task counts

      // Simulates the phase-2 relational hydration: only ids present in the phase-1
      // result ever reach this query, so filtering here proves the cap actually narrows
      // what gets hydrated instead of the route re-deriving the limit in JS.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(db.query.taskItems.findMany).mockImplementation(((args: any) => {
        const ids: string[] = args?.where?.values ?? [];
        return Promise.resolve(allTasks.filter(t => ids.includes(t.id)));
      }) as never);

      const response = await GET(createRequest('?limit=2'), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.tasks).toHaveLength(2);
      expect(body.tasks.map((t: { id: string }) => t.id)).toEqual(['task-1', 'task-2']);
      // Defense-in-depth: the hydrate call itself carries an explicit `limit`, not just
      // an `inArray` scoped to an already-bounded id list.
      expect(vi.mocked(db.query.taskItems.findMany).mock.calls[0]?.[0]).toMatchObject({ limit: 2 });
    });

    it('sets hasMore=true when the phase-1 query returns more than the requested limit (frontend Load More signal)', async () => {
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };
      const childPageRows = [
        { id: 'p-1', pageId: 'p-1' },
        { id: 'p-2', pageId: 'p-2' },
        { id: 'p-3', pageId: 'p-3' },
      ];
      // Requests limit+1 rows under the hood to detect a next page without an extra COUNT(*)
      // query — 3 rows come back for a ?limit=2 request, so one is beyond the page.
      const boundedIdRowsPlusOne = [{ id: 'task-1' }, { id: 'task-2' }, { id: 'task-3' }];
      const allTasks = [
        { id: 'task-1', position: 0, page: { id: 'p-1', title: 'Task One', isTrashed: false, position: 0 } },
        { id: 'task-2', position: 1, page: { id: 'p-2', title: 'Task Two', isTrashed: false, position: 1 } },
        { id: 'task-3', position: 2, page: { id: 'p-3', title: 'Task Three', isTrashed: false, position: 2 } },
      ];

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);

      vi.mocked(db.select)
        .mockImplementationOnce(() => makeSelectChain(childPageRows) as never) // childPages
        .mockImplementationOnce(() => makeSelectChain(childPageRows) as never) // backfill existingRows
        .mockImplementationOnce(() => makeSelectChain(boundedIdRowsPlusOne) as never) // phase 1
        .mockImplementation(() => makeSelectChain([]) as never); // trigger / sub-task counts

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(db.query.taskItems.findMany).mockImplementation(((args: any) => {
        const ids: string[] = args?.where?.values ?? [];
        return Promise.resolve(allTasks.filter(t => ids.includes(t.id)));
      }) as never);

      const response = await GET(createRequest('?limit=2'), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.tasks).toHaveLength(2);
      expect(body.hasMore).toBe(true);
    });

    it('sets hasMore=false when the phase-1 query returns no more than the requested limit', async () => {
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };
      const childPageRows = [
        { id: 'p-1', pageId: 'p-1' },
        { id: 'p-2', pageId: 'p-2' },
      ];
      const boundedIdRows = [{ id: 'task-1' }, { id: 'task-2' }];
      const allTasks = [
        { id: 'task-1', position: 0, page: { id: 'p-1', title: 'Task One', isTrashed: false, position: 0 } },
        { id: 'task-2', position: 1, page: { id: 'p-2', title: 'Task Two', isTrashed: false, position: 1 } },
      ];

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);

      vi.mocked(db.select)
        .mockImplementationOnce(() => makeSelectChain(childPageRows) as never) // childPages
        .mockImplementationOnce(() => makeSelectChain(childPageRows) as never) // backfill existingRows
        .mockImplementationOnce(() => makeSelectChain(boundedIdRows) as never) // phase 1
        .mockImplementation(() => makeSelectChain([]) as never); // trigger / sub-task counts

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(db.query.taskItems.findMany).mockImplementation(((args: any) => {
        const ids: string[] = args?.where?.values ?? [];
        return Promise.resolve(allTasks.filter(t => ids.includes(t.id)));
      }) as never);

      const response = await GET(createRequest('?limit=2'), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.tasks).toHaveLength(2);
      expect(body.hasMore).toBe(false);
    });

    it('reports hasMore=false on the empty-tasks response (no TASK_LIST children)', async () => {
      const mockTaskList = { id: mockTaskListId, title: 'My Tasks', status: 'pending', updatedAt: new Date() };

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.select).mockImplementation(() => makeSelectChain([]) as never); // no child pages

      const response = await GET(createRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.tasks).toEqual([]);
      expect(body.hasMore).toBe(false);
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
      const eventArg = vi.mocked(broadcastTaskEvent).mock.calls[0][0];
      expect(eventArg.type).toBe('task_added');
      expect(eventArg.taskId).toBe('new-task');
      expect(eventArg.pageId).toBe(mockPageId);
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


    it('does not notify the task creator even when self-mentioned in description', async () => {
      const mockTaskList = { id: mockTaskListId };
      const mockNewTask = { id: 'new-task', title: 'Task', status: 'pending', priority: 'medium', position: 0 };
      const mockNewPage = { id: 'new-page', title: 'Task', type: 'DOCUMENT' };

      transactionPageResult = [mockNewPage];
      transactionTaskResult = [mockNewTask];

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.pages.findFirst)
        .mockResolvedValueOnce({ id: mockPageId, driveId: 'drive-123' } as never)
        .mockResolvedValueOnce(null as never);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);
      vi.mocked(db.query.taskItems.findFirst)
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce({ ...mockNewTask, assignee: null, user: null, assignees: [] } as never);

      const response = await POST(
        createRequest({ title: 'Task', description: `CC @[Me](${mockUserId}:user)` }),
        { params: mockParams },
      );

      expect(response.status).toBe(201);
      expect(mockCreateMentionNotification).not.toHaveBeenCalledWith(
        mockUserId,
        expect.anything(),
        expect.anything(),
      );
    });

    it('does not notify a @mentioned user who cannot view the task page', async () => {
      const mockTaskList = { id: mockTaskListId };
      const mockNewTask = { id: 'new-task', title: 'Task', status: 'pending', priority: 'medium', position: 0 };
      const mockNewPage = { id: 'new-page', title: 'Task', type: 'DOCUMENT' };

      transactionPageResult = [mockNewPage];
      transactionTaskResult = [mockNewTask];

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
      vi.mocked(canUserViewPage).mockResolvedValue(false);
      vi.mocked(db.query.pages.findFirst)
        .mockResolvedValueOnce({ id: mockPageId, driveId: 'drive-123' } as never)
        .mockResolvedValueOnce(null as never);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);
      vi.mocked(db.query.taskItems.findFirst)
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce({ ...mockNewTask, assignee: null, user: null, assignees: [] } as never);

      const response = await POST(
        createRequest({ title: 'Task', description: 'Hey @[Outsider](user-outsider:user)' }),
        { params: mockParams },
      );

      expect(response.status).toBe(201);
      expect(mockCreateMentionNotification).not.toHaveBeenCalled();
    });

    it('returns 201 even when createMentionNotification throws during task creation', async () => {
      const mockTaskList = { id: mockTaskListId };
      const mockNewTask = { id: 'new-task', title: 'Task', status: 'pending', priority: 'medium', position: 0 };
      const mockNewPage = { id: 'new-page', title: 'Task', type: 'DOCUMENT' };

      transactionPageResult = [mockNewPage];
      transactionTaskResult = [mockNewTask];

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      vi.mocked(db.query.pages.findFirst)
        .mockResolvedValueOnce({ id: mockPageId, driveId: 'drive-123' } as never)
        .mockResolvedValueOnce(null as never);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);
      vi.mocked(db.query.taskItems.findFirst)
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce({ ...mockNewTask, assignee: null, user: null, assignees: [] } as never);
      mockCreateMentionNotification.mockRejectedValue(new Error('notification service down'));

      const response = await POST(
        createRequest({ title: 'Task', description: 'Hey @[Alice](user-alice:user)' }),
        { params: mockParams },
      );

      expect(response.status).toBe(201);
    });

    it('stores note in task metadata on create', async () => {
      const mockTaskList = { id: mockTaskListId };
      const mockNewTask = { id: 'new-task', title: 'Task', status: 'pending', priority: 'medium', position: 0 };
      const mockNewPage = { id: 'new-page', title: 'Task', type: 'DOCUMENT' };

      transactionPageResult = [mockNewPage];
      transactionTaskResult = [mockNewTask];

      let capturedTaskInsert: Record<string, unknown> | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vi.mocked(db.transaction) as any).mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => {
        let insertCallCount = 0;
        const tx = {
          insert: vi.fn(() => ({
            values: vi.fn((vals: Record<string, unknown>) => {
              insertCallCount++;
              if (insertCallCount === 2) capturedTaskInsert = vals;
              return {
                returning: vi.fn().mockResolvedValue(insertCallCount === 1 ? transactionPageResult : transactionTaskResult),
              };
            }),
          })),
        };
        return callback(tx);
      });

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
      vi.mocked(db.query.pages.findFirst)
        .mockResolvedValueOnce({ id: mockPageId, driveId: 'drive-123' } as never) // taskListPage
        .mockResolvedValueOnce(null as never); // lastChildPage
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);
      vi.mocked(db.query.taskItems.findFirst)
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce({ ...mockNewTask, assignee: null, user: null, assignees: [] } as never);

      const response = await POST(createRequest({ title: 'Task', note: 'remember this' }), { params: mockParams });

      expect(response.status).toBe(201);
      expect(capturedTaskInsert).toMatchObject({ metadata: { note: 'remember this' } });
    });

    it('applies an explicit position by moving the created page, not by writing a task-row position (#2143)', async () => {
      const mockTaskList = { id: mockTaskListId };
      const mockNewTask = { id: 'new-task', title: 'Task', status: 'pending', priority: 'medium' };
      const mockNewPage = { id: 'new-page', title: 'Task', type: 'DOCUMENT', position: 1 };
      vi.mocked(reorderTaskPeers).mockResolvedValueOnce({ index: 7, position: 7.5 });

      transactionPageResult = [mockNewPage];
      transactionTaskResult = [mockNewTask];

      let capturedTaskInsert: Record<string, unknown> | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vi.mocked(db.transaction) as any).mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => {
        let insertCallCount = 0;
        const tx = {
          insert: vi.fn(() => ({
            values: vi.fn((vals: Record<string, unknown>) => {
              insertCallCount++;
              if (insertCallCount === 2) capturedTaskInsert = vals;
              return {
                returning: vi.fn().mockResolvedValue(insertCallCount === 1 ? transactionPageResult : transactionTaskResult),
              };
            }),
          })),
        };
        return callback(tx);
      });

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
      vi.mocked(db.query.pages.findFirst)
        .mockResolvedValueOnce({ id: mockPageId, driveId: 'drive-123' } as never) // taskListPage
        .mockResolvedValueOnce(null as never); // lastChildPage
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);
      vi.mocked(db.query.taskItems.findFirst)
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce({ ...mockNewTask, assignee: null, user: null, assignees: [] } as never);

      const response = await POST(createRequest({ title: 'Task', position: 7 }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(201);
      // The task row carries no position at all — order lives on the linked page.
      expect(capturedTaskInsert).not.toHaveProperty('position');
      expect(reorderTaskPeers).toHaveBeenCalledWith(mockPageId, 'new-task', 7, { userId: mockUserId });
      // ...and the response reports the position actually written to that rail.
      expect(body.position).toBe(7.5);
    });

    it('leaves a task created without an explicit position at the end of the list', async () => {
      const mockTaskList = { id: mockTaskListId };
      const mockNewTask = { id: 'new-task', title: 'Task', status: 'pending', priority: 'medium' };
      const mockNewPage = { id: 'new-page', title: 'Task', type: 'DOCUMENT', position: 4 };

      transactionPageResult = [mockNewPage];
      transactionTaskResult = [mockNewTask];

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
      vi.mocked(db.query.pages.findFirst)
        .mockResolvedValueOnce({ id: mockPageId, driveId: 'drive-123' } as never) // taskListPage
        .mockResolvedValueOnce({ position: 3 } as never); // lastChildPage
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);
      vi.mocked(db.query.taskItems.findFirst)
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce({ ...mockNewTask, assignee: null, user: null, assignees: [] } as never);

      const response = await POST(createRequest({ title: 'Task' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(reorderTaskPeers).not.toHaveBeenCalled();
      expect(body.position).toBe(4);
    });

    it('uses the request body timezone for the agent trigger workflow', async () => {
      const mockTaskList = { id: mockTaskListId };
      const mockNewTask = { id: 'new-task', title: 'Task', status: 'pending', priority: 'medium', position: 0 };
      const mockNewPage = { id: 'new-page', title: 'Task', type: 'DOCUMENT' };

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
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce({ ...mockNewTask, assignee: null, user: null, assignees: [] } as never);

      const response = await POST(createRequest({
        title: 'Task',
        dueDate: '2025-12-31',
        timezone: 'America/Chicago',
        agentTrigger: { agentPageId: 'agent-1', prompt: 'go' },
      }), { params: mockParams });

      expect(response.status).toBe(201);
      expect(createTaskTriggerWorkflow).toHaveBeenCalledWith(expect.objectContaining({ timezone: 'America/Chicago' }));
      expect(getUserTimezone).not.toHaveBeenCalled();
    });

    it('falls back to the user profile timezone for the agent trigger workflow when body omits it', async () => {
      const mockTaskList = { id: mockTaskListId };
      const mockNewTask = { id: 'new-task', title: 'Task', status: 'pending', priority: 'medium', position: 0 };
      const mockNewPage = { id: 'new-page', title: 'Task', type: 'DOCUMENT' };

      transactionPageResult = [mockNewPage];
      transactionTaskResult = [mockNewTask];

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
      vi.mocked(getUserTimezone).mockResolvedValue('Europe/Berlin');
      vi.mocked(db.query.pages.findFirst)
        .mockResolvedValueOnce({ id: mockPageId, driveId: 'drive-123' } as never) // taskListPage
        .mockResolvedValueOnce(null as never); // lastChildPage
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);
      vi.mocked(db.query.taskItems.findFirst)
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce({ ...mockNewTask, assignee: null, user: null, assignees: [] } as never);

      const response = await POST(createRequest({
        title: 'Task',
        dueDate: '2025-12-31',
        agentTrigger: { agentPageId: 'agent-1', prompt: 'go' },
      }), { params: mockParams });

      expect(response.status).toBe(201);
      expect(getUserTimezone).toHaveBeenCalledWith(mockUserId);
      expect(createTaskTriggerWorkflow).toHaveBeenCalledWith(expect.objectContaining({ timezone: 'Europe/Berlin' }));
    });

    it('creates task page as TASK_LIST type with empty content', async () => {
      const mockTaskList = { id: mockTaskListId };
      const mockNewTask = { id: 'new-task', title: 'New Task', status: 'pending', priority: 'medium', position: 0 };
      const mockNewPage = { id: 'new-page', title: 'New Task', type: 'TASK_LIST' };

      transactionPageResult = [mockNewPage];
      transactionTaskResult = [mockNewTask];

      let capturedPageInsert: Record<string, unknown> | null = null;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (vi.mocked(db.transaction) as any).mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => {
        let insertCallCount = 0;
        const tx = {
          insert: vi.fn(() => ({
            values: vi.fn((vals: Record<string, unknown>) => {
              insertCallCount++;
              if (insertCallCount === 1) capturedPageInsert = vals;
              return {
                returning: vi.fn().mockResolvedValue(insertCallCount === 1 ? transactionPageResult : transactionTaskResult),
              };
            }),
          })),
        };
        return callback(tx);
      });

      vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId: mockUserId } as never);
      vi.mocked(canUserEditPage).mockResolvedValue(true);
      vi.mocked(db.query.pages.findFirst)
        .mockResolvedValueOnce({ id: mockPageId, driveId: 'drive-123' } as never)
        .mockResolvedValueOnce(null as never);
      vi.mocked(db.query.taskLists.findFirst).mockResolvedValue(mockTaskList as never);
      vi.mocked(db.query.taskStatusConfigs.findMany).mockResolvedValue([] as never);
      vi.mocked(db.query.taskItems.findFirst)
        .mockResolvedValueOnce(null as never)
        .mockResolvedValueOnce({ ...mockNewTask, assignee: null, user: null, assignees: [] } as never);

      const response = await POST(createRequest({ title: 'New Task' }), { params: mockParams });

      expect(response.status).toBe(201);
      expect(capturedPageInsert).toMatchObject({
        type: 'TASK_LIST',
        content: '',
      });
    });
  });
});
