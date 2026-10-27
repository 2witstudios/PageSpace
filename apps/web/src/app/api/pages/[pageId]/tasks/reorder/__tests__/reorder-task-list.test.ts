import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', field: a, value: b })),
  and: vi.fn((...conditions) => ({ op: 'and', conditions })),
  inArray: vi.fn((column, values) => ({ op: 'inArray', column, values })),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: {
    id: 'pages.id',
    parentId: 'pages.parentId',
    type: 'pages.type',
    isTrashed: 'pages.isTrashed',
    position: 'pages.position',
    updatedAt: 'pages.updatedAt',
  },
}));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskItems: { id: 'taskItems.id', pageId: 'taskItems.pageId' },
}));
vi.mock('@pagespace/lib/services/reorder', async () => {
  const actual = await vi.importActual<typeof import('@pagespace/lib/services/reorder')>(
    '@pagespace/lib/services/reorder'
  );
  return { ...actual, lockedBatchReorder: vi.fn().mockResolvedValue([]) };
});

import { pages } from '@pagespace/db/schema/core';
import { lockedBatchReorder } from '@pagespace/lib/services/reorder';
import { reorderTaskListChildren } from '../reorder-task-list';

/**
 * Structural stand-in for Tx. `select()` serves two call shapes:
 * `.from().where().for('share')` (the scope lock) and
 * `.from().innerJoin().where()` (the task id → page id resolution).
 */
function fakeTx(resolutionRows: Array<{ taskId: string; pageId: string }>) {
  const forShare = vi.fn().mockResolvedValue([]);
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => whereResult,
  };
  const whereResult = {
    for: forShare,
    then: (onFulfilled: (rows: typeof resolutionRows) => unknown) =>
      Promise.resolve(resolutionRows).then(onFulfilled),
  };
  const select = vi.fn(() => chain);
  const tx = { select } as unknown as Parameters<typeof reorderTaskListChildren>[0];
  return { tx, select, forShare };
}

describe('reorderTaskListChildren', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(lockedBatchReorder).mockResolvedValue([]);
  });

  it('locks the scoped pages FOR SHARE before delegating to lockedBatchReorder', async () => {
    const callOrder: string[] = [];
    const { tx, forShare } = fakeTx([{ taskId: 'task-a', pageId: 'page-a' }]);
    forShare.mockImplementation(async () => {
      callOrder.push('lock-pages');
      return [];
    });
    vi.mocked(lockedBatchReorder).mockImplementationOnce(async () => {
      callOrder.push('locked-batch-reorder');
      return ['page-a'];
    });

    const plan = { orderedIds: ['task-a'], positionById: new Map([['task-a', 9]]) };
    await reorderTaskListChildren(tx, 'page-1', plan);

    expect(forShare).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['lock-pages', 'locked-batch-reorder']);
  });

  it('writes pages.position — the single ordering rail — not a task-row position', async () => {
    // #2143: task_items carried a second, disjoint position column. Users reordered
    // pages, this endpoint reordered task rows, and neither saw the other.
    const { tx } = fakeTx([{ taskId: 'task-a', pageId: 'page-a' }]);
    vi.mocked(lockedBatchReorder).mockResolvedValueOnce(['page-a']);

    const plan = { orderedIds: ['task-a'], positionById: new Map([['task-a', 9]]) };
    await reorderTaskListChildren(tx, 'page-1', plan);

    const opts = vi.mocked(lockedBatchReorder).mock.calls[0][1];
    expect(opts.table).toBe(pages);
    expect(opts.idColumn).toBe(pages.id);
    expect(opts.positionColumn).toBe(pages.position);
    expect(opts.touchColumns).toEqual([pages.updatedAt]);
  });

  it('casts positions as real so fractional midpoints are not truncated', async () => {
    const { tx } = fakeTx([{ taskId: 'task-a', pageId: 'page-a' }]);
    vi.mocked(lockedBatchReorder).mockResolvedValueOnce(['page-a']);

    const plan = { orderedIds: ['task-a'], positionById: new Map([['task-a', 1.5]]) };
    await reorderTaskListChildren(tx, 'page-1', plan);

    expect(vi.mocked(lockedBatchReorder).mock.calls[0][1].positionType).toBe('real');
  });

  it('translates submitted task ids to their linked page ids, keeping each position', async () => {
    const { tx } = fakeTx([
      { taskId: 'task-a', pageId: 'page-a' },
      { taskId: 'task-b', pageId: 'page-b' },
    ]);
    vi.mocked(lockedBatchReorder).mockResolvedValueOnce(['page-a', 'page-b']);

    const plan = {
      orderedIds: ['task-a', 'task-b'],
      positionById: new Map([['task-a', 2.5], ['task-b', 1]]),
    };
    await reorderTaskListChildren(tx, 'page-1', plan);

    const submitted = vi.mocked(lockedBatchReorder).mock.calls[0][1].plan;
    expect(submitted.orderedIds).toEqual(['page-a', 'page-b']);
    expect(submitted.positionById.get('page-a')).toBe(2.5);
    expect(submitted.positionById.get('page-b')).toBe(1);
  });

  it('maps locked page ids back to task ids so the caller can validate its own input', async () => {
    // The route compares this against plan.orderedIds (task ids) to 400 on unknown ids.
    const { tx } = fakeTx([
      { taskId: 'task-a', pageId: 'page-a' },
      { taskId: 'task-b', pageId: 'page-b' },
    ]);
    vi.mocked(lockedBatchReorder).mockResolvedValueOnce(['page-b', 'page-a']);

    const plan = {
      orderedIds: ['task-a', 'task-b'],
      positionById: new Map([['task-a', 1], ['task-b', 2]]),
    };
    const result = await reorderTaskListChildren(tx, 'page-1', plan);

    expect([...result].sort()).toEqual(['task-a', 'task-b']);
  });

  it('reports only the resolvable ids when a submitted task is outside this list', async () => {
    const { tx } = fakeTx([{ taskId: 'task-a', pageId: 'page-a' }]);
    vi.mocked(lockedBatchReorder).mockResolvedValueOnce(['page-a']);

    const plan = {
      orderedIds: ['task-a', 'task-foreign'],
      positionById: new Map([['task-a', 1], ['task-foreign', 2]]),
    };
    const result = await reorderTaskListChildren(tx, 'page-1', plan);

    expect(result).toEqual(['task-a']);
  });

  it('skips the batch write entirely when no submitted task is in scope', async () => {
    const { tx } = fakeTx([]);

    const plan = { orderedIds: ['task-foreign'], positionById: new Map([['task-foreign', 1]]) };
    const result = await reorderTaskListChildren(tx, 'page-1', plan);

    expect(lockedBatchReorder).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('never touches the transaction for an empty plan (defense in depth, matching lockedBatchReorder\'s own empty-plan guard)', async () => {
    const { tx, select } = fakeTx([]);

    const plan = { orderedIds: [], positionById: new Map() };
    const result = await reorderTaskListChildren(tx, 'page-1', plan);

    expect(select).not.toHaveBeenCalled();
    expect(lockedBatchReorder).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});
