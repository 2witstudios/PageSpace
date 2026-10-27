import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assert } from '@/hooks/__tests__/riteway';

// Schema tables are opaque markers in these tests; the mock tx ignores them.
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'pages.id', driveId: 'pages.driveId', parentId: 'pages.parentId', isTrashed: 'pages.isTrashed', position: 'pages.position', type: 'pages.type' } }));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskLists: { pageId: 'taskLists.pageId' },
  taskItems: { pageId: 'taskItems.pageId', id: 'taskItems.id', assigneeAgentId: 'taskItems.assigneeAgentId', completedAt: 'taskItems.completedAt', status: 'taskItems.status' },
  taskAssignees: { taskId: 'taskAssignees.taskId', agentPageId: 'taskAssignees.agentPageId' },
  // Real identifiers: the vocabulary probes filter on group and order by
  // position, and a bare {} makes every one of those conditions read as
  // undefined — so the mock cannot tell them apart.
  taskStatusConfigs: {
    taskListId: 'taskStatusConfigs.taskListId',
    slug: 'taskStatusConfigs.slug',
    group: 'taskStatusConfigs.group',
    position: 'taskStatusConfigs.position',
  },
  DEFAULT_TASK_STATUSES: [
    { slug: 'pending', name: 'To Do', color: 'c', group: 'todo', position: 0 },
  ],
}));
vi.mock('@pagespace/db/schema/task-triggers', () => ({
  taskTriggers: { taskItemId: 'taskTriggers.taskItemId', workflowId: 'taskTriggers.workflowId' },
}));
vi.mock('@pagespace/db/schema/workflows', () => ({
  workflows: { id: 'workflows.id', driveId: 'workflows.driveId', agentPageId: 'workflows.agentPageId', instructionPageId: 'workflows.instructionPageId' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ['eq', a, b]),
  and: vi.fn((...c) => ['and', ...c]),
  asc: vi.fn((c) => ['asc', c]),
  isNotNull: vi.fn((c) => ['isNotNull', c]),
  ne: vi.fn((a, b) => ['ne', a, b]),
  desc: vi.fn((c) => ['desc', c]),
  inArray: vi.fn((c, v) => ['inArray', c, v]),
}));

// The shells import `db` only as a type; provide a stub so the module loads.
vi.mock('@pagespace/db/db', () => ({ db: {} }));

import { taskItems as taskItemsTable, taskAssignees as taskAssigneesTable } from '@pagespace/db/schema/tasks';
import { workflows as workflowsTable } from '@pagespace/db/schema/workflows';

/** Identity of the mocked table objects, so delete() can be labelled unambiguously. */
const schemaTables = {
  taskItems: taskItemsTable as unknown as Record<string, string>,
  taskAssignees: taskAssigneesTable as unknown as Record<string, string>,
  workflows: workflowsTable as unknown as Record<string, string>,
};

import {
  ensureTaskItemForPage,
  ensureTaskListForPage,
  resolveSeedCompletedAt,
  resolveSeedStatus,
  type SeedCache,
  syncTaskItemOnMove,
  backfillMissingTaskItems,
  scrubDriveScopedTaskAssociations,
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
  /** task_items ids the scrub should find, and the workflow ids their triggers name. */
  scrubTaskItemIds?: string[];
  scrubWorkflowIds?: string[];
  /** Agent each trigger workflow runs, which is set independently of the assignee. */
  triggerAgentByWorkflow?: Record<string, string>;
  /** Runbook page each trigger workflow reads, and pages that travelled to the target. */
  instructionPageByWorkflow?: Record<string, string>;
  pagesInTargetDrive?: string[];
  /** task_items ids the remove branch's pre-delete trigger sweep should find. */
  removeBranchTaskItemIds?: string[];
  /** Agent page referenced by each found task item, and agents already in the target drive. */
  scrubAgentIdByItem?: Record<string, string>;
  scrubAssigneeAgentIds?: string[];
  agentsInTargetDrive?: string[];
  /** Status carried by the preserved task_items row, and the destination's vocabulary. */
  existingItemStatus?: string;
  existingItemCompletedAt?: Date | null;
  destinationStatusConfigs?: Array<{ slug: string; group: string; position: number }>;
  /** Rows the post-seed vocabulary sweep should find already in the list. */
  existingTaskRows?: Array<{ id: string; status: string; completedAt: Date | null }>;
} = {}) {
  const {
    pageTypes = {},
    existingItems = new Set<string>(),
    existingTaskList = true,
    lastPosition = null,
    scrubTaskItemIds = [],
    scrubWorkflowIds = [],
    triggerAgentByWorkflow = {},
    instructionPageByWorkflow = {},
    pagesInTargetDrive = [],
    removeBranchTaskItemIds = [],
    scrubAgentIdByItem = {},
    scrubAssigneeAgentIds = [],
    agentsInTargetDrive = [],
    existingItemStatus = 'pending',
    existingItemCompletedAt = null,
    destinationStatusConfigs = [],
    existingTaskRows = [],
  } = config;

  const taskItemUpdates: Array<Record<string, unknown>> = [];

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

  const scrubSelects: unknown[][] = [];
  const deletedTables: string[] = [];
  const deleteConditions: Array<{ table: string; cond: unknown }> = [];
  const statusConfigProbes: Array<{ taskListId: string; slug: string }> = [];
  const workflowDriveUpdates: unknown[] = [];

  const tx = {
    // Dispatch on the PROJECTION SHAPE, not call order: order-based dispatch would let
    // two swapped selects — or a query against the wrong column — pass unnoticed.
    select: vi.fn((projection?: Record<string, unknown>) => {
      // Keyed on the projection's VALUES, which are the table-qualified column names in
      // these mocks. Keying on the key NAMES collided: { id: taskItems.id } and
      // { id: pages.id } are both 'id', so a task_items-by-page lookup was
      // indistinguishable from a pages-by-drive one and wiring them to each other
      // passed silently.
      const shape = projection ? Object.values(projection).sort().join(',') : '';
      const result =
        shape === 'taskItems.assigneeAgentId,taskItems.id'
          ? scrubTaskItemIds.map((id) => ({ id, assigneeAgentId: scrubAgentIdByItem[id] ?? null }))
        : shape === 'taskAssignees.agentPageId' ? scrubAssigneeAgentIds.map((agentPageId) => ({ agentPageId }))
        : shape === 'taskTriggers.workflowId' ? scrubWorkflowIds.map((workflowId) => ({ workflowId }))
        : shape === 'taskTriggers.workflowId,workflows.agentPageId,workflows.instructionPageId'
          ? scrubWorkflowIds.map((workflowId) => ({
              workflowId,
              agentPageId: triggerAgentByWorkflow[workflowId] ?? 'agent-left-behind',
              instructionPageId: instructionPageByWorkflow[workflowId] ?? null,
            }))
        : shape === 'pages.id'
          ? [...agentsInTargetDrive, ...pagesInTargetDrive].map((id) => ({ id }))
        : shape === 'taskItems.id' ? removeBranchTaskItemIds.map((id) => ({ id }))
        : null;
      // The post-seed sweep: select(id,status,completedAt).from(taskItems)
      //   .innerJoin(pages).where(...).limit(N)
      if (shape === 'taskItems.completedAt,taskItems.id,taskItems.status') {
        const sweep = { where: () => ({ limit: () => Promise.resolve(existingTaskRows) }) };
        return { from: () => ({ ...sweep, innerJoin: () => sweep }) };
      }
      if (result === null) return selectChain;
      const terminal = {
        where: (cond: unknown[]) => {
          scrubSelects.push(cond);
          return Promise.resolve(result);
        },
      };
      return { from: () => ({ ...terminal, innerJoin: () => terminal }) };
    }),
    // Label by the table's OWN identity, not by which keys it happens to expose —
    // taskItems and workflows both carry `id`, and keying off that silently labelled
    // every taskItems delete as 'workflows', making the preserve-the-row assertion
    // impossible to fail.
    delete: vi.fn((table: Record<string, string>) => ({
      where: (cond: unknown[]) => {
        const label =
          table === schemaTables.taskAssignees ? 'taskAssignees'
          : table === schemaTables.workflows ? 'workflows'
          : table === schemaTables.taskItems ? 'taskItems'
          : 'unknown';
        deletedTables.push(label);
        // Captured so an assertion can check WHICH rows a delete targeted; discarding
        // it let "deletes the stale workflow" pass even against a zero-row predicate.
        deleteConditions.push({ table: label, cond });
        deletedPageIds.push(cond?.[2] as string);
        return Promise.resolve();
      },
    })),
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
        return existingItems.has(id)
          ? { id: 'item-1', pageId: id, status: existingItemStatus, completedAt: existingItemCompletedAt }
          : undefined;
      }) },
      taskStatusConfigs: {
        // where: ['and', ['eq','taskStatusConfigs.taskListId', id], ['eq','taskStatusConfigs.slug', slug]]
        findFirst: vi.fn(async (args: { where: unknown[]; orderBy?: unknown[] }) => {
          const listCond = args.where?.[1] as unknown[];
          const slugCond = args.where?.[2] as unknown[];
          // The seed and the repairs no longer page the vocabulary — nothing caps
          // how many statuses a list defines — so they ask for the pieces they
          // need directly: the first config by position, and the first of a given
          // group. Those queries have no slug term, and the group ones carry an
          // 'eq'/'ne' on taskStatusConfigs.group.
          const ordered = [...destinationStatusConfigs].sort((a, b) => a.position - b.position);
          const descending = JSON.stringify(args.orderBy ?? []).includes('desc');
          // A bare `eq(taskListId, …)` — no second condition — is the "first (or
          // last) config by position" probe.
          if (args.where?.[0] === 'eq') {
            return descending ? ordered[ordered.length - 1] : ordered[0];
          }
          if (Array.isArray(slugCond) && slugCond[1] === 'taskStatusConfigs.group') {
            const op = slugCond[0] as string;
            const group = slugCond[2] as string;
            const candidates = descending ? [...ordered].reverse() : ordered;
            return candidates.find((c) => (op === 'ne' ? c.group !== group : c.group === group));
          }
          statusConfigProbes.push({ taskListId: listCond?.[2] as string, slug: slugCond?.[2] as string });
          return destinationStatusConfigs.find((c) => c.slug === slugCond?.[2]);
        }),
        findMany: vi.fn(async () => destinationStatusConfigs),
      },
      pages: { findFirst: vi.fn(async () => (lastPosition === null ? undefined : { position: lastPosition })) },
    },
    update: vi.fn((table: Record<string, string>) => ({
      set: (vals: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          if (table === schemaTables.workflows) workflowDriveUpdates.push({ vals, cond });
          else taskItemUpdates.push(vals);
          return Promise.resolve();
        },
      }),
    })),
  };

  return { tx, taskItemInserts, taskListInserts, taskStatusConfigInserts, deletedPageIds, taskItemUpdates, deletedTables, scrubSelects, deleteConditions, workflowDriveUpdates, statusConfigProbes };
}


describe('resolveSeedCompletedAt', () => {
  // A done-group status with a null completedAt reads as complete to the UI
  // while every count that asks the database (`completedAt IS NOT NULL`) says
  // otherwise — the row looks finished AND blocks its parent.
  const txWithConfig = (group?: 'todo' | 'in_progress' | 'done') => ({
    query: {
      taskStatusConfigs: {
        findFirst: vi.fn().mockResolvedValue(group ? { group } : undefined),
      },
    },
  });

  it('stamps a done-group slug', async () => {
    assert({
      given: 'a seed status the list defines as done',
      should: 'be stamped complete',
      actual: (await resolveSeedCompletedAt(txWithConfig('done') as never, 'l', 'shipped')) instanceof Date,
      expected: true,
    });
  });

  it('leaves an open slug unstamped', async () => {
    assert({
      given: 'a seed status in the todo group',
      should: 'not be stamped',
      actual: await resolveSeedCompletedAt(txWithConfig('todo') as never, 'l', 'icebox'),
      expected: null,
    });
  });

  it('resolves once per list when a backfill loop shares a cache', async () => {
    const tx = txWithConfig('done');
    const cache: SeedCache = new Map();
    const seed = await resolveSeedStatus(tx as never, 'l', cache);
    // Counted from HERE: resolveSeedStatus's own probes vary with the shape of
    // the vocabulary, and this is about the completion rule, not the seed.
    const afterSeed = tx.query.taskStatusConfigs.findFirst.mock.calls.length;
    await resolveSeedCompletedAt(tx as never, 'l', seed, cache);
    await resolveSeedCompletedAt(tx as never, 'l', seed, cache);
    assert({
      given: 'the same list and seed status twice, through a shared cache',
      should: 'query the vocabulary once for the completion rule, not twice',
      actual: tx.query.taskStatusConfigs.findFirst.mock.calls.length - afterSeed,
      expected: 1,
    });
  });

  it('does not reuse a cached answer for a different status', async () => {
    // POST passes an explicit status, which the cached slug did not come from.
    const tx = txWithConfig('done');
    const cache: SeedCache = new Map([['l', { slug: 'shipped', completedAt: new Date() }]]);
    assert({
      given: 'a cache holding the completion answer for a DIFFERENT slug',
      should: 'ask the database rather than reuse it',
      actual: (await resolveSeedCompletedAt(tx as never, 'l', 'icebox', cache)) instanceof Date
        && tx.query.taskStatusConfigs.findFirst.mock.calls.length === 1,
      expected: true,
    });
  });

  it("falls back to the built-in rule when the list has no vocabulary", async () => {
    assert({
      given: 'no config for the slug, on a list with no custom statuses',
      should: "stamp only the built-in 'completed'",
      actual: [
        (await resolveSeedCompletedAt(txWithConfig() as never, 'l', 'completed')) instanceof Date,
        await resolveSeedCompletedAt(txWithConfig() as never, 'l', 'pending'),
      ],
      expected: [true, null],
    });
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
      { userId: 'u', pageId: 'list', status: 'pending', priority: 'medium', completedAt: null },
    ]);
  });

  it('stamps completedAt when the seed status the list forces is a done one', async () => {
    // Not hypothetical: the statuses PUT validates each group but never requires
    // one per group, so a list CAN end up all-done, and resolveSeedStatus then
    // has nothing but a done slug to fall back to. Every seeding path has to
    // apply the same rule as POST or the row reads complete to the client while
    // every `completedAt IS NOT NULL` counter says it is not.
    const { tx, taskItemInserts } = makeTx({
      pageTypes: { parent: 'TASK_LIST' },
      destinationStatusConfigs: [{ slug: 'shipped', group: 'done', position: 0 }],
    });
    await ensureTaskItemForPage(tx as never, { pageId: 'list', pageType: 'TASK_LIST', parentId: 'parent', userId: 'u' });
    expect(taskItemInserts).toHaveLength(1);
    expect(taskItemInserts[0]).toMatchObject({ status: 'shipped' });
    expect(taskItemInserts[0].completedAt).toBeInstanceOf(Date);
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

  // Previously this asserted a delete + re-insert. That was silent data loss: the
  // delete cascades task_assignees away and the re-insert carries bare defaults, so
  // a task dragged between two lists lost its status, priority, due date, metadata
  // and every assignee. Membership derives from pages.parentId and the row has no
  // list pointer, so it was valid under the new parent throughout.
  it('backfills without deleting when moving between TASK_LISTs and no row exists', async () => {
    const { tx, taskItemInserts, deletedPageIds } = makeTx({ pageTypes: { old: 'TASK_LIST', new: 'TASK_LIST' } });
    await syncTaskItemOnMove(tx as never, { movedPageId: 'list', movedPageType: 'TASK_LIST', oldParentId: 'old', newParentId: 'new', userId: 'u' });
    expect(deletedPageIds).toHaveLength(0);
    expect(taskItemInserts).toHaveLength(1);
    expect(taskItemInserts[0]).toMatchObject({ pageId: 'list' });
    expect(taskItemInserts[0]).not.toHaveProperty('position');
  });

  // The case the old behavior destroyed: an EXISTING row survives a list-to-list
  // move untouched — no delete, and no insert to overwrite it.
  it('leaves an existing task_items row completely untouched on a list-to-list move', async () => {
    const { tx, taskItemInserts, deletedPageIds } = makeTx({
      pageTypes: { old: 'TASK_LIST', new: 'TASK_LIST' },
      existingItems: new Set(['list']),
    });
    await syncTaskItemOnMove(tx as never, { movedPageId: 'list', movedPageType: 'TASK_LIST', oldParentId: 'old', newParentId: 'new', userId: 'u' });
    expect(deletedPageIds).toHaveLength(0);
    expect(taskItemInserts).toHaveLength(0);
  });

  // task_items.status is a bare slug resolved against the OWNING list's configs, so a
  // preserved row can arrive carrying a status its new list does not define. Left alone
  // it lands in the board's first column regardless of meaning, renders its raw slug,
  // and drops out of status-filtered queries.
  it('remaps a status the destination list does not define', async () => {
    const { tx, taskItemUpdates } = makeTx({
      pageTypes: { old: 'TASK_LIST', new: 'TASK_LIST' },
      existingItems: new Set(['list']),
      existingItemStatus: 'in_review',
      destinationStatusConfigs: [
        { slug: 'pending', group: 'todo', position: 0 },
        { slug: 'done', group: 'done', position: 1 },
      ],
    });
    await syncTaskItemOnMove(tx as never, { movedPageId: 'list', movedPageType: 'TASK_LIST', oldParentId: 'old', newParentId: 'new', userId: 'u' });
    expect(taskItemUpdates).toEqual([{ status: 'pending' }]);
  });

  // completedAt lives on the row and is list-independent, so a finished task stays
  // finished — otherwise the checkbox and the parent's progress count disagree.
  it('remaps a completed task into the destination\'s done group', async () => {
    const { tx, taskItemUpdates } = makeTx({
      pageTypes: { old: 'TASK_LIST', new: 'TASK_LIST' },
      existingItems: new Set(['list']),
      existingItemStatus: 'shipped',
      existingItemCompletedAt: new Date('2026-01-01'),
      destinationStatusConfigs: [
        { slug: 'pending', group: 'todo', position: 0 },
        { slug: 'complete', group: 'done', position: 1 },
      ],
    });
    await syncTaskItemOnMove(tx as never, { movedPageId: 'list', movedPageType: 'TASK_LIST', oldParentId: 'old', newParentId: 'new', userId: 'u' });
    expect(taskItemUpdates).toEqual([{ status: 'complete' }]);
  });

  it('leaves a status the destination already defines untouched', async () => {
    const { tx, taskItemUpdates } = makeTx({
      pageTypes: { old: 'TASK_LIST', new: 'TASK_LIST' },
      existingItems: new Set(['list']),
      existingItemStatus: 'pending',
      destinationStatusConfigs: [{ slug: 'pending', group: 'todo', position: 0 }],
    });
    await syncTaskItemOnMove(tx as never, { movedPageId: 'list', movedPageType: 'TASK_LIST', oldParentId: 'old', newParentId: 'new', userId: 'u' });
    expect(taskItemUpdates).toHaveLength(0);
  });

  // PUT /tasks/statuses validates each config's group but never guarantees a list keeps
  // one of each, so a naive `?? configs[0]` could drop an unfinished task onto a done
  // slug — ticked and struck through while every completedAt-based count still calls it
  // incomplete.
  it('never remaps an unfinished task onto a done-group status', async () => {
    const { tx, taskItemUpdates } = makeTx({
      pageTypes: { old: 'TASK_LIST', new: 'TASK_LIST' },
      existingItems: new Set(['list']),
      existingItemStatus: 'foreign',
      destinationStatusConfigs: [
        { slug: 'shipped', group: 'done', position: 0 },
        { slug: 'doing', group: 'in_progress', position: 1 },
      ],
    });
    await syncTaskItemOnMove(tx as never, { movedPageId: 'list', movedPageType: 'TASK_LIST', oldParentId: 'old', newParentId: 'new', userId: 'u' });
    expect(taskItemUpdates).toEqual([{ status: 'doing' }]);
  });

  it('keeps a completed task in a done status even when the list has no todo group', async () => {
    const { tx, taskItemUpdates } = makeTx({
      pageTypes: { old: 'TASK_LIST', new: 'TASK_LIST' },
      existingItems: new Set(['list']),
      existingItemStatus: 'foreign',
      existingItemCompletedAt: new Date('2026-01-01'),
      destinationStatusConfigs: [
        { slug: 'doing', group: 'in_progress', position: 0 },
        { slug: 'shipped', group: 'done', position: 1 },
      ],
    });
    await syncTaskItemOnMove(tx as never, { movedPageId: 'list', movedPageType: 'TASK_LIST', oldParentId: 'old', newParentId: 'new', userId: 'u' });
    expect(taskItemUpdates).toEqual([{ status: 'shipped' }]);
  });

  // A slug match alone is not proof the status still means the same thing: slugs come
  // from slugify(name) and each list picks its own group, so "Review" can be `done` in
  // one list and `in_progress` in another. Carrying it over unchanged leaves the row's
  // group disagreeing with its own completedAt.
  // A slug the destination DOES define is left completely alone, even when its group
  // disagrees with completedAt. Rewriting the status would reverse a deliberate regroup;
  // rewriting completedAt would fabricate a completion time (bypassing the sub-task guard
  // and disabling the due-date trigger) or destroy a real one nothing else records. The
  // disagreement is already reachable inside a single list, so a move must not pay for it.
  it('leaves a defined slug untouched even when its group disagrees with completedAt', async () => {
    const { tx, taskItemUpdates } = makeTx({
      pageTypes: { old: 'TASK_LIST', new: 'TASK_LIST' },
      existingItems: new Set(['list']),
      existingItemStatus: 'review',
      existingItemCompletedAt: new Date('2026-01-01'),
      destinationStatusConfigs: [
        { slug: 'review', group: 'in_progress', position: 0 },
        { slug: 'shipped', group: 'done', position: 1 },
      ],
    });
    await syncTaskItemOnMove(tx as never, { movedPageId: 'list', movedPageType: 'TASK_LIST', oldParentId: 'old', newParentId: 'new', userId: 'u' });
    expect(taskItemUpdates).toHaveLength(0);
  });

  it('probes the destination list for the task\'s own slug, not a hardcoded one', async () => {
    const { tx, statusConfigProbes } = makeTx({
      pageTypes: { old: 'TASK_LIST', new: 'TASK_LIST' },
      existingItems: new Set(['list']),
      existingItemStatus: 'review',
      destinationStatusConfigs: [{ slug: 'review', group: 'todo', position: 0 }],
    });
    await syncTaskItemOnMove(tx as never, { movedPageId: 'list', movedPageType: 'TASK_LIST', oldParentId: 'old', newParentId: 'new', userId: 'u' });
    expect(statusConfigProbes).toEqual([{ taskListId: 'tasklist-1', slug: 'review' }]);
  });

  // A list whose owner deleted 'pending' (permitted, via migrateToSlug) would otherwise
  // get a brand-new task seeded with a status it does not define — the very defect
  // normalizeStatusForList exists to prevent, reintroduced on the insert path.
  it('seeds a new task with a status the destination list actually defines', async () => {
    const { tx, taskItemInserts } = makeTx({
      pageTypes: { old: 'FOLDER', new: 'TASK_LIST' },
      destinationStatusConfigs: [{ slug: 'backlog', group: 'todo', position: 0 }],
    });
    await syncTaskItemOnMove(tx as never, { movedPageId: 'list', movedPageType: 'TASK_LIST', oldParentId: 'old', newParentId: 'new', userId: 'u' });
    expect(taskItemInserts[0]).toMatchObject({ status: 'backlog' });
  });

  // ...while the destination list is still seeded, which is why shouldAdd stays true.
  it('still seeds the destination task list on a list-to-list move', async () => {
    const { tx, taskListInserts } = makeTx({
      pageTypes: { old: 'TASK_LIST', new: 'TASK_LIST' },
      existingItems: new Set(['list']),
      existingTaskList: false,
    });
    await syncTaskItemOnMove(tx as never, { movedPageId: 'list', movedPageType: 'TASK_LIST', oldParentId: 'old', newParentId: 'new', userId: 'u' });
    expect(taskListInserts).toHaveLength(1);
  });

  // The remove branch must clear the trigger workflows BEFORE deleting the row:
  // task_triggers.taskItemId cascades from task_items, so the other order strands them.
  it('deletes trigger workflows before deleting the row it is removing', async () => {
    const { tx, deletedTables } = makeTx({
      pageTypes: { old: 'TASK_LIST', new: 'FOLDER' },
      removeBranchTaskItemIds: ['item-1'],
      scrubWorkflowIds: ['wf-1'],
    });

    await syncTaskItemOnMove(tx as never, { movedPageId: 'list', movedPageType: 'TASK_LIST', oldParentId: 'old', newParentId: 'new', userId: 'u' });

    expect(deletedTables).toEqual(['workflows', 'taskItems']);
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

describe('scrubDriveScopedTaskAssociations', () => {
  it('no-ops on an empty page list without touching the database', async () => {
    const { tx, deletedTables } = makeTx();
    await scrubDriveScopedTaskAssociations(tx as never, { pageIds: [], targetDriveId: 'drive-target' });
    expect(tx.select).not.toHaveBeenCalled();
    expect(deletedTables).toHaveLength(0);
  });

  it('no-ops when none of the moved pages are tasks', async () => {
    const { tx, deletedTables } = makeTx({ scrubTaskItemIds: [] });
    await scrubDriveScopedTaskAssociations(tx as never, { pageIds: ['p1', 'p2'], targetDriveId: 'drive-target' });
    expect(deletedTables).toHaveLength(0);
  });

  // The ordering that matters: task_triggers.taskItemId cascades from task_items, so
  // anything that removes triggers before reading them leaves the workflows rows
  // orphaned and unreachable — the hazard disableTaskTriggers documents.
  it('deletes the linked workflows by id, letting the cascade take the triggers', async () => {
    const { tx, deletedTables } = makeTx({
      scrubTaskItemIds: ['item-1'],
      scrubWorkflowIds: ['wf-1', 'wf-2'],
      scrubAgentIdByItem: { 'item-1': 'agent-left-behind' },
    });

    await scrubDriveScopedTaskAssociations(tx as never, { pageIds: ['p1'], targetDriveId: 'drive-target' });

    expect(deletedTables).toEqual(['workflows', 'taskAssignees']);
  });

  it('clears the agent assignee and drops agent assignee rows', async () => {
    const { tx, taskItemUpdates, deletedTables } = makeTx({
      scrubTaskItemIds: ['item-1'],
      scrubAgentIdByItem: { 'item-1': 'agent-left-behind' },
    });

    await scrubDriveScopedTaskAssociations(tx as never, { pageIds: ['p1'], targetDriveId: 'drive-target' });

    expect(taskItemUpdates).toEqual([{ assigneeAgentId: null }]);
    expect(deletedTables).toContain('taskAssignees');
  });

  // Moving a project folder that carries BOTH its task list and the agent it assigns
  // work to must not silently drop the assignment — that agent is not stale.
  it('leaves alone an agent that moved into the target drive with the task', async () => {
    const { tx, taskItemUpdates, deletedTables } = makeTx({
      scrubTaskItemIds: ['item-1'],
      scrubAgentIdByItem: { 'item-1': 'agent-came-along' },
      agentsInTargetDrive: ['agent-came-along'],
    });

    await scrubDriveScopedTaskAssociations(tx as never, { pageIds: ['p1'], targetDriveId: 'drive-target' });

    expect(taskItemUpdates).toHaveLength(0);
    expect(deletedTables).not.toContain('taskAssignees');
  });

  // Finding: workflows.driveId is stamped at creation and never rewritten, so testing it
  // deleted EVERY surviving trigger. Staleness is the agent's, not the drive column's.
  it('spares and repoints the trigger workflow when its agent moved along', async () => {
    const { tx, deletedTables, workflowDriveUpdates } = makeTx({
      scrubTaskItemIds: ['item-1'],
      scrubWorkflowIds: ['wf-1'],
      triggerAgentByWorkflow: { 'wf-1': 'agent-came-along' },
      scrubAgentIdByItem: { 'item-1': 'agent-came-along' },
      agentsInTargetDrive: ['agent-came-along'],
    });

    await scrubDriveScopedTaskAssociations(tx as never, { pageIds: ['p1'], targetDriveId: 'drive-target' });

    expect(deletedTables).not.toContain('workflows');
    // driveId is stamped at creation and never rewritten, so a spared workflow must be
    // repointed or it executes against the drive the task just left.
    expect(workflowDriveUpdates).toHaveLength(1);
    expect(workflowDriveUpdates[0]).toMatchObject({ vals: { driveId: 'drive-target' } });
    // The predicate must name the workflow, not (say) its agent — an UPDATE matching
    // zero rows would otherwise pass, exactly as it did on the delete side.
    expect(JSON.stringify((workflowDriveUpdates[0] as { cond: unknown }).cond)).toContain('wf-1');
  });

  // The partition was only ever exercised one branch at a time; a swap would fail both
  // single-branch tests but this pins them running together.
  it('deletes the stale workflow and repoints the surviving one in the same move', async () => {
    const { tx, deletedTables, workflowDriveUpdates } = makeTx({
      scrubTaskItemIds: ['item-1'],
      scrubWorkflowIds: ['wf-stale', 'wf-ok'],
      triggerAgentByWorkflow: { 'wf-stale': 'agent-left-behind', 'wf-ok': 'agent-came-along' },
      agentsInTargetDrive: ['agent-came-along'],
    });

    await scrubDriveScopedTaskAssociations(tx as never, { pageIds: ['p1'], targetDriveId: 'drive-target' });

    expect(deletedTables).toContain('workflows');
    expect(JSON.stringify(workflowDriveUpdates)).toContain('wf-ok');
    expect(JSON.stringify(workflowDriveUpdates)).not.toContain('wf-stale');
  });

  // contextPageIds are re-filtered by driveId at fire time; instructionPageId is not —
  // loadInstructionPage gates only on the workflow creator's membership, and that
  // creator is a source-drive user. A runbook left behind would keep being read and its
  // content persisted into a destination-drive agent page.
  it('clears an instruction page that stayed behind on a surviving workflow', async () => {
    const { tx, workflowDriveUpdates } = makeTx({
      scrubTaskItemIds: ['item-1'],
      scrubWorkflowIds: ['wf-ok'],
      triggerAgentByWorkflow: { 'wf-ok': 'agent-came-along' },
      agentsInTargetDrive: ['agent-came-along'],
      instructionPageByWorkflow: { 'wf-ok': 'runbook-left-behind' },
    });

    await scrubDriveScopedTaskAssociations(tx as never, { pageIds: ['p1'], targetDriveId: 'drive-target' });

    const clear = workflowDriveUpdates.find(
      (u) => (u as { vals: Record<string, unknown> }).vals.instructionPageId === null,
    );
    expect(clear).toBeDefined();
    expect(JSON.stringify((clear as { cond: unknown }).cond)).toContain('wf-ok');
  });

  // "clear all surviving when any is stranded" would pass every single-workflow
  // fixture; this pins that the two are decided independently.
  it('clears only the workflow whose runbook stayed behind', async () => {
    const { tx, workflowDriveUpdates } = makeTx({
      scrubTaskItemIds: ['item-1'],
      scrubWorkflowIds: ['wf-stranded', 'wf-travelled'],
      triggerAgentByWorkflow: { 'wf-stranded': 'agent-came-along', 'wf-travelled': 'agent-came-along' },
      agentsInTargetDrive: ['agent-came-along'],
      instructionPageByWorkflow: { 'wf-stranded': 'runbook-left', 'wf-travelled': 'runbook-moved' },
      pagesInTargetDrive: ['runbook-moved'],
    });

    await scrubDriveScopedTaskAssociations(tx as never, { pageIds: ['p1'], targetDriveId: 'drive-target' });

    const clears = workflowDriveUpdates.filter(
      (u) => (u as { vals: Record<string, unknown> }).vals.instructionPageId === null,
    );
    expect(clears).toHaveLength(1);
    expect(JSON.stringify(clears[0])).toContain('wf-stranded');
    expect(JSON.stringify(clears[0])).not.toContain('wf-travelled');
  });

  // 7783c6618's whole effect was unasserted: dropping the shared memo left every test
  // green. The three resolutions in one scrub must cost ONE pages lookup, not three.
  it('resolves page residency once per scrub, not once per consumer', async () => {
    const { tx, scrubSelects } = makeTx({
      scrubTaskItemIds: ['item-1'],
      scrubWorkflowIds: ['wf-ok'],
      scrubAgentIdByItem: { 'item-1': 'agent-a' },
      triggerAgentByWorkflow: { 'wf-ok': 'agent-a' },
      agentsInTargetDrive: ['agent-a'],
      instructionPageByWorkflow: { 'wf-ok': 'agent-a' },
    });

    await scrubDriveScopedTaskAssociations(tx as never, { pageIds: ['p1'], targetDriveId: 'drive-target' });

    const pageProbes = scrubSelects.filter((cond) => JSON.stringify(cond).includes('pages.driveId'));
    expect(pageProbes).toHaveLength(1);
  });

  it('keeps an instruction page that travelled with the task', async () => {
    const { tx, workflowDriveUpdates } = makeTx({
      scrubTaskItemIds: ['item-1'],
      scrubWorkflowIds: ['wf-ok'],
      triggerAgentByWorkflow: { 'wf-ok': 'agent-came-along' },
      agentsInTargetDrive: ['agent-came-along'],
      instructionPageByWorkflow: { 'wf-ok': 'runbook-came-along' },
      pagesInTargetDrive: ['runbook-came-along'],
    });

    await scrubDriveScopedTaskAssociations(tx as never, { pageIds: ['p1'], targetDriveId: 'drive-target' });

    expect(JSON.stringify(workflowDriveUpdates)).not.toContain('instructionPageId');
  });

  // A trigger's agent comes from workflows.agentPageId, set independently of any task
  // assignee — keying the sweep off the assignee set let these survive a move.
  it('deletes a stale trigger workflow even when the task has NO agent assignee', async () => {
    const { tx, deletedTables } = makeTx({
      scrubTaskItemIds: ['item-1'],
      scrubWorkflowIds: ['wf-1'],
      triggerAgentByWorkflow: { 'wf-1': 'agent-left-behind' },
    });

    await scrubDriveScopedTaskAssociations(tx as never, { pageIds: ['p1'], targetDriveId: 'drive-target' });

    expect(deletedTables).toContain('workflows');
  });

  it('deletes the trigger workflow when its agent stayed behind', async () => {
    const { tx, deletedTables, deleteConditions } = makeTx({
      scrubTaskItemIds: ['item-1'],
      scrubWorkflowIds: ['wf-1'],
      triggerAgentByWorkflow: { 'wf-1': 'agent-left-behind' },
      scrubAgentIdByItem: { 'item-1': 'agent-left-behind' },
    });

    await scrubDriveScopedTaskAssociations(tx as never, { pageIds: ['p1'], targetDriveId: 'drive-target' });

    expect(deletedTables).toContain('workflows');
    // The predicate must actually name the doomed workflow — discarding it let this
    // assertion pass against a delete that matched nothing.
    const wfDelete = deleteConditions.find((d) => d.table === 'workflows');
    expect(JSON.stringify(wfDelete?.cond)).toContain('wf-1');
  });

  // Human assignees, priority, dueDate and metadata are not drive-scoped, so the
  // scrub must not be a blanket row reset.
  it('does not delete the task_items rows themselves', async () => {
    const { tx, deletedTables } = makeTx({ scrubTaskItemIds: ['item-1'] });
    await scrubDriveScopedTaskAssociations(tx as never, { pageIds: ['p1'], targetDriveId: 'drive-target' });
    expect(deletedTables).not.toContain('taskItems');
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

  it('resolves the parent list once, not once per missing child', async () => {
    // This runs on an ordinary list read, inside a write transaction. The parent
    // is fixed for the whole loop, so re-deriving its list per row is a query —
    // and a possible seeding write — repeated for nothing while the transaction
    // stays open. A hundred missing rows used to mean a few hundred round trips.
    const parts = makeTx({ pageTypes: { p: 'TASK_LIST' } });
    const database = makeDb([], parts);
    await backfillMissingTaskItems(database as never, {
      parentId: 'p', childPageIds: ['a', 'b', 'c', 'd'], userId: 'u',
    });
    assert({
      given: 'four children all missing their task_items row',
      should: 'look the parent list up exactly once',
      actual: {
        listLookups: parts.tx.query.taskLists.findFirst.mock.calls.length,
        inserted: parts.taskItemInserts.length,
      },
      expected: { listLookups: 1, inserted: 4 },
    });
  });

  it('backfills only the children missing a task item', async () => {
    const parts = makeTx({ pageTypes: { p: 'TASK_LIST' } });
    const database = makeDb(['a'], parts);
    await backfillMissingTaskItems(database as never, { parentId: 'p', childPageIds: ['a', 'b', 'c'], userId: 'u' });
    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(parts.taskItemInserts.map(r => r.pageId)).toEqual(['b', 'c']);
  });
});
