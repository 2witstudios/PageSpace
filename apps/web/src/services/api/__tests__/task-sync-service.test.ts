import { describe, it, expect, vi, beforeEach } from 'vitest';

// Schema tables are opaque markers in these tests; the mock tx ignores them.
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'pages.id', parentId: 'pages.parentId', isTrashed: 'pages.isTrashed', position: 'pages.position', type: 'pages.type' } }));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskLists: { pageId: 'taskLists.pageId' },
  taskItems: { pageId: 'taskItems.pageId' },
  taskStatusConfigs: {},
  DEFAULT_TASK_STATUSES: [
    { slug: 'pending', name: 'To Do', color: 'c', group: 'todo', position: 0 },
  ],
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ['eq', a, b]),
  and: vi.fn((...c) => ['and', ...c]),
  desc: vi.fn((c) => ['desc', c]),
  inArray: vi.fn((c, v) => ['inArray', c, v]),
}));

// The shells import `db` only as a type; provide a stub so the module loads.
vi.mock('@pagespace/db/db', () => ({ db: {} }));

import {
  ensureTaskItemForPage,
  ensureTaskListForPage,
  seedDefaultTaskStatusConfigs,
  syncTaskItemOnMove,
  backfillMissingTaskItems,
} from '../task-sync-service';

/**
 * Build a mock transaction context.
 *
 * @param config.pageTypes        map of pageId -> type, consulted by getPageType
 * @param config.existingItems    set of pageIds that already have a task_items row
 * @param config.existingTaskList whether the parent already has a task_lists row
 * @param config.lastPosition     position of the last child page (for new item position)
 */
function makeTx(config: {
  pageTypes?: Record<string, string>;
  existingItems?: Set<string>;
  existingTaskList?: boolean;
  lastPosition?: number | null;
} = {}) {
  const {
    pageTypes = {},
    existingItems = new Set<string>(),
    existingTaskList = true,
    lastPosition = null,
  } = config;

  const taskItemInserts: Array<Record<string, unknown>> = [];
  const taskListInserts: Array<Record<string, unknown>> = [];
  const taskStatusConfigInserts: Array<Record<string, unknown>> = [];
  const deletedPageIds: string[] = [];

  // getPageType: tx.select(...).from(pages).where(eq(pages.id, X)).limit(1)
  // The where condition we built is ['eq', 'pages.id', X]; pull X back out.
  const selectChain = {
    from: () => selectChain,
    where: (cond: unknown[]) => {
      const id = cond?.[2] as string;
      return { limit: () => Promise.resolve(id in pageTypes ? [{ type: pageTypes[id] }] : []) };
    },
  };

  const tx = {
    select: vi.fn(() => selectChain),
    delete: vi.fn(() => ({ where: (cond: unknown[]) => { deletedPageIds.push(cond?.[2] as string); return Promise.resolve(); } })),
    insert: vi.fn((table: { pageId?: string }) => ({
      values: (vals: Record<string, unknown> | Record<string, unknown>[]) => {
        const isTaskItems = table?.pageId === 'taskItems.pageId';
        if (isTaskItems) taskItemInserts.push(vals as Record<string, unknown>);
        else if (table?.pageId === 'taskLists.pageId') taskListInserts.push(vals as Record<string, unknown>);
        else taskStatusConfigInserts.push(...(Array.isArray(vals) ? vals : [vals]));
        // taskItems insert is awaited via .onConflictDoNothing(); taskLists via .returning().
        return { onConflictDoNothing: () => Promise.resolve(), returning: () => Promise.resolve([{ id: 'tasklist-1' }]) };
      },
    })),
    query: {
      taskLists: { findFirst: vi.fn(async () => (existingTaskList ? { id: 'tasklist-1' } : undefined)) },
      taskItems: { findFirst: vi.fn(async (args: { where: unknown[] }) => {
        const id = args.where?.[2] as string;
        return existingItems.has(id) ? { id: 'item-1', pageId: id } : undefined;
      }) },
      pages: { findFirst: vi.fn(async () => (lastPosition === null ? undefined : { position: lastPosition })) },
    },
  };

  return { tx, taskItemInserts, taskListInserts, taskStatusConfigInserts, deletedPageIds };
}

describe('seedDefaultTaskStatusConfigs', () => {
  it('inserts the 4 default status configs linked to the given task_lists id', async () => {
    const { tx, taskStatusConfigInserts } = makeTx();
    await seedDefaultTaskStatusConfigs(tx as never, 'list-1');
    expect(taskStatusConfigInserts).toEqual([
      { taskListId: 'list-1', slug: 'pending', name: 'To Do', color: 'c', group: 'todo', position: 0 },
    ]);
  });

  it('swallows a unique-constraint violation (concurrent caller already seeded this list)', async () => {
    const { taskStatusConfigInserts } = makeTx();
    const tx = {
      insert: vi.fn(() => ({
        values: () => Promise.reject(new Error('duplicate key value violates unique constraint "task_status_configs_task_list_slug"')),
      })),
    };
    await expect(seedDefaultTaskStatusConfigs(tx as never, 'list-1')).resolves.toBeUndefined();
    expect(taskStatusConfigInserts).toHaveLength(0);
  });

  it('rethrows an unrelated error', async () => {
    const tx = {
      insert: vi.fn(() => ({
        values: () => Promise.reject(new Error('connection reset')),
      })),
    };
    await expect(seedDefaultTaskStatusConfigs(tx as never, 'list-1')).rejects.toThrow('connection reset');
  });
});

describe('ensureTaskListForPage', () => {
  it('is a no-op when a task_lists row already exists for the page', async () => {
    const { tx, taskListInserts, taskStatusConfigInserts } = makeTx({ existingTaskList: true });
    const result = await ensureTaskListForPage(tx as never, { pageId: 'page-1', title: 'My List', userId: 'u' });
    expect(result).toEqual({ id: 'tasklist-1' });
    expect(taskListInserts).toHaveLength(0);
    expect(taskStatusConfigInserts).toHaveLength(0);
  });

  it('seeds task_lists AND the default task_status_configs when none exist', async () => {
    const { tx, taskListInserts, taskStatusConfigInserts } = makeTx({ existingTaskList: false });
    const result = await ensureTaskListForPage(tx as never, { pageId: 'page-1', title: 'My List', userId: 'u' });

    expect(result).toEqual({ id: 'tasklist-1' });
    expect(taskListInserts).toEqual([
      { userId: 'u', pageId: 'page-1', title: 'My List', status: 'pending' },
    ]);
    // This is the crux of the bug fix: previously only task_lists was seeded and
    // task_status_configs was left empty, which is what crashes the Kanban UI.
    expect(taskStatusConfigInserts).toEqual([
      { taskListId: 'tasklist-1', slug: 'pending', name: 'To Do', color: 'c', group: 'todo', position: 0 },
    ]);
  });

  it('passes through optional metadata on the new task_lists row', async () => {
    const { tx, taskListInserts } = makeTx({ existingTaskList: false });
    await ensureTaskListForPage(tx as never, {
      pageId: 'page-1',
      title: 'My List',
      userId: 'u',
      metadata: { autoCreated: true },
    });
    expect(taskListInserts[0]).toMatchObject({ metadata: { autoCreated: true } });
  });
});

describe('ensureTaskItemForPage', () => {
  it('does nothing for a non-TASK_LIST page (no parent lookup, no insert)', async () => {
    const { tx, taskItemInserts } = makeTx({ pageTypes: { parent: 'TASK_LIST' } });
    await ensureTaskItemForPage(tx as never, { pageId: 'doc', pageType: 'DOCUMENT', parentId: 'parent', userId: 'u' });
    expect(tx.select).not.toHaveBeenCalled();
    expect(taskItemInserts).toHaveLength(0);
  });

  it('does nothing for a root TASK_LIST (no parent)', async () => {
    const { tx, taskItemInserts } = makeTx();
    await ensureTaskItemForPage(tx as never, { pageId: 'list', pageType: 'TASK_LIST', parentId: null, userId: 'u' });
    expect(taskItemInserts).toHaveLength(0);
  });

  it('does nothing when the parent is not a TASK_LIST', async () => {
    const { tx, taskItemInserts } = makeTx({ pageTypes: { parent: 'FOLDER' } });
    await ensureTaskItemForPage(tx as never, { pageId: 'list', pageType: 'TASK_LIST', parentId: 'parent', userId: 'u' });
    expect(taskItemInserts).toHaveLength(0);
  });

  it('creates a task_items row for a TASK_LIST nested under a TASK_LIST', async () => {
    const { tx, taskItemInserts } = makeTx({ pageTypes: { parent: 'TASK_LIST' }, lastPosition: 2 });
    await ensureTaskItemForPage(tx as never, { pageId: 'list', pageType: 'TASK_LIST', parentId: 'parent', userId: 'u' });
    // No position: task order lives on the linked page's pages.position (#2143).
    expect(taskItemInserts).toEqual([
      { userId: 'u', pageId: 'list', status: 'pending', priority: 'medium' },
    ]);
  });

  it('is idempotent — skips insert when the row already exists', async () => {
    const { tx, taskItemInserts } = makeTx({ pageTypes: { parent: 'TASK_LIST' }, existingItems: new Set(['list']) });
    await ensureTaskItemForPage(tx as never, { pageId: 'list', pageType: 'TASK_LIST', parentId: 'parent', userId: 'u' });
    expect(taskItemInserts).toHaveLength(0);
  });

  it('creates the parent task_lists row first when it is missing', async () => {
    const { tx, taskItemInserts, taskListInserts } = makeTx({ pageTypes: { parent: 'TASK_LIST' }, existingTaskList: false });
    await ensureTaskItemForPage(tx as never, { pageId: 'list', pageType: 'TASK_LIST', parentId: 'parent', userId: 'u' });
    expect(taskListInserts).toHaveLength(1);
    expect(taskItemInserts).toHaveLength(1);
  });
});

describe('syncTaskItemOnMove', () => {
  it('no-ops for non-TASK_LIST pages', async () => {
    const { tx, taskItemInserts, deletedPageIds } = makeTx();
    await syncTaskItemOnMove(tx as never, { movedPageId: 'd', movedPageType: 'DOCUMENT', oldParentId: 'a', newParentId: 'b', userId: 'u' });
    expect(taskItemInserts).toHaveLength(0);
    expect(deletedPageIds).toHaveLength(0);
  });

  it('removes from old list and adds to new list when moving between TASK_LISTs', async () => {
    const { tx, taskItemInserts, deletedPageIds } = makeTx({ pageTypes: { old: 'TASK_LIST', new: 'TASK_LIST' } });
    await syncTaskItemOnMove(tx as never, { movedPageId: 'list', movedPageType: 'TASK_LIST', oldParentId: 'old', newParentId: 'new', userId: 'u' });
    expect(deletedPageIds).toEqual(['list']);
    expect(taskItemInserts).toHaveLength(1);
    expect(taskItemInserts[0]).toMatchObject({ pageId: 'list' });
    expect(taskItemInserts[0]).not.toHaveProperty('position');
  });

  it('only removes when moving out of a TASK_LIST into a non-TASK_LIST', async () => {
    const { tx, taskItemInserts, deletedPageIds } = makeTx({ pageTypes: { old: 'TASK_LIST', new: 'FOLDER' } });
    await syncTaskItemOnMove(tx as never, { movedPageId: 'list', movedPageType: 'TASK_LIST', oldParentId: 'old', newParentId: 'new', userId: 'u' });
    expect(deletedPageIds).toEqual(['list']);
    expect(taskItemInserts).toHaveLength(0);
  });

  it('only adds when moving from root into a TASK_LIST', async () => {
    const { tx, taskItemInserts, deletedPageIds } = makeTx({ pageTypes: { new: 'TASK_LIST' } });
    await syncTaskItemOnMove(tx as never, { movedPageId: 'list', movedPageType: 'TASK_LIST', oldParentId: null, newParentId: 'new', userId: 'u' });
    expect(deletedPageIds).toHaveLength(0);
    expect(taskItemInserts).toHaveLength(1);
  });
});

describe('backfillMissingTaskItems', () => {
  function makeDb(existingPageIds: string[], txParts: ReturnType<typeof makeTx>) {
    const selectChain = {
      from: () => selectChain,
      where: () => Promise.resolve(existingPageIds.map(pageId => ({ pageId }))),
    };
    return {
      select: vi.fn(() => selectChain),
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<void>) => cb(txParts.tx)),
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it('does nothing when there are no children', async () => {
    const parts = makeTx();
    const database = makeDb([], parts);
    await backfillMissingTaskItems(database as never, { parentId: 'p', childPageIds: [], userId: 'u' });
    expect(database.select).not.toHaveBeenCalled();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('does not open a transaction when every child already has a task item', async () => {
    const parts = makeTx({ pageTypes: { p: 'TASK_LIST' } });
    const database = makeDb(['a', 'b'], parts);
    await backfillMissingTaskItems(database as never, { parentId: 'p', childPageIds: ['a', 'b'], userId: 'u' });
    expect(database.select).toHaveBeenCalledTimes(1);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(parts.taskItemInserts).toHaveLength(0);
  });

  it('backfills only the children missing a task item', async () => {
    const parts = makeTx({ pageTypes: { p: 'TASK_LIST' } });
    const database = makeDb(['a'], parts);
    await backfillMissingTaskItems(database as never, { parentId: 'p', childPageIds: ['a', 'b', 'c'], userId: 'u' });
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(parts.taskItemInserts.map(r => r.pageId)).toEqual(['b', 'c']);
  });
});
