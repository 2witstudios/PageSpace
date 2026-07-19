import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', field: a, value: b })),
  and: vi.fn((...conditions) => ({ op: 'and', conditions })),
  inArray: vi.fn((column, values) => ({ op: 'inArray', column, values })),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', parentId: 'pages.parentId', type: 'pages.type', isTrashed: 'pages.isTrashed' },
}));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskItems: { id: 'taskItems.id', position: 'taskItems.position', pageId: 'taskItems.pageId', updatedAt: 'taskItems.updatedAt' },
}));
vi.mock('@pagespace/lib/services/reorder', () => ({
  lockedBatchReorder: vi.fn().mockResolvedValue(['task-a']),
}));

import { inArray } from '@pagespace/db/operators';
import { taskItems } from '@pagespace/db/schema/tasks';
import { lockedBatchReorder } from '@pagespace/lib/services/reorder';
import { reorderTaskListChildren } from '../reorder-task-list';

describe('reorderTaskListChildren', () => {
  it('locks the scoped pages FOR SHARE before delegating to lockedBatchReorder', async () => {
    const callOrder: string[] = [];
    const forShare = vi.fn().mockImplementation(async () => {
      callOrder.push('lock-pages');
      return [];
    });
    const select = vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ for: forShare })) })) }));
    const tx = { select } as unknown as Parameters<typeof reorderTaskListChildren>[0];

    vi.mocked(lockedBatchReorder).mockImplementationOnce(async () => {
      callOrder.push('locked-batch-reorder');
      return ['task-a'];
    });

    const plan = { orderedIds: ['task-a'], positionById: new Map([['task-a', 9]]) };
    await reorderTaskListChildren(tx, 'page-1', plan);

    expect(forShare).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['lock-pages', 'locked-batch-reorder']);
  });

  it('scopes the write with a pages subquery, not a materialized id array', async () => {
    const forShare = vi.fn().mockResolvedValue([]);
    const select = vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ for: forShare })) })) }));
    const tx = { select } as unknown as Parameters<typeof reorderTaskListChildren>[0];

    const plan = { orderedIds: ['task-a'], positionById: new Map([['task-a', 9]]) };
    await reorderTaskListChildren(tx, 'page-1', plan);

    // A large task list must not force every child page id into app memory
    // and then into a bind-param array — that reintroduces the unbounded-
    // collection cost this epic exists to remove, and risks the Postgres
    // bind-parameter limit. inArray's second argument must be the query
    // builder returned by tx.select(...).from(...).where(...) itself, so
    // Postgres runs `IN (SELECT ...)`, matching fetchEnrichedTasks in
    // task-helpers.ts — not a resolved/materialized array of ids.
    expect(inArray).toHaveBeenCalledWith(taskItems.pageId, expect.anything());
    const scopeArg = vi.mocked(inArray).mock.calls.at(-1)?.[1];
    expect(Array.isArray(scopeArg)).toBe(false);
  });

  it('returns lockedBatchReorder\'s result directly', async () => {
    const forShare = vi.fn().mockResolvedValue([]);
    const select = vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ for: forShare })) })) }));
    const tx = { select } as unknown as Parameters<typeof reorderTaskListChildren>[0];
    vi.mocked(lockedBatchReorder).mockResolvedValueOnce(['task-a', 'task-b']);

    const plan = { orderedIds: ['task-a', 'task-b'], positionById: new Map() };
    const result = await reorderTaskListChildren(tx, 'page-1', plan);

    expect(result).toEqual(['task-a', 'task-b']);
  });
});
