import { describe, it, expect } from 'vitest';
import type {
  TaskItem,
  TaskListData,
  TaskStatusConfig,
} from '@/components/layout/middle-content/page-views/task-list/task-list-types';
import {
  applyTaskPatchToPages,
  applySubTaskCountsToPages,
  appendTaskToPages,
  removeTaskFromPages,
  findTaskInPages,
  shouldAppendOptimistically,
  resolveToggleStatus,
  blockedByOpenSubTasks,
  taskFromCreateResponse,
} from '../task-cache-core';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const task = (over: Partial<TaskItem> & { id: string }): TaskItem => ({
  userId: 'u1',
  assigneeId: null,
  assigneeAgentId: null,
  pageId: `page-${over.id}`,
  title: over.id,
  status: 'pending',
  priority: 'medium',
  position: 0,
  dueDate: null,
  completedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const page = (tasks: TaskItem[], hasMore = false): TaskListData => ({
  taskList: {
    id: 'list-1',
    title: 'List',
    description: null,
    status: 'active',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  tasks,
  statusConfigs: [],
  hasMore,
});

const config = (slug: string, group: TaskStatusConfig['group'], position: number): TaskStatusConfig => ({
  id: `cfg-${slug}`,
  taskListId: 'list-1',
  name: slug,
  slug,
  color: '#000',
  group,
  position,
});

describe('applyTaskPatchToPages', () => {
  it('patches only the matching task', () => {
    const pages = [page([task({ id: 'a' }), task({ id: 'b' })])];
    const next = applyTaskPatchToPages(pages, 'a', { status: 'completed' });
    assert({
      given: 'two tasks on one page',
      should: 'change only the targeted task',
      actual: next?.[0].tasks.map((t) => t.status),
      expected: ['completed', 'pending'],
    });
  });

  it('finds a task on a later page', () => {
    const pages = [page([task({ id: 'a' })], true), page([task({ id: 'b' })])];
    const next = applyTaskPatchToPages(pages, 'b', { status: 'done' });
    assert({
      given: 'a task on the second loaded page',
      should: 'patch it and leave the first page by reference',
      actual: [next?.[1].tasks[0].status, next?.[0] === pages[0]],
      expected: ['done', true],
    });
  });

  it('does not mutate the input pages', () => {
    const pages = [page([task({ id: 'a' })])];
    applyTaskPatchToPages(pages, 'a', { status: 'completed' });
    assert({
      given: 'an input cache',
      should: 'leave the original task untouched',
      actual: pages[0].tasks[0].status,
      expected: 'pending',
    });
  });

  it('returns a new top-level array when something changed', () => {
    const pages = [page([task({ id: 'a' })])];
    assert({
      given: 'a patch that matches',
      should: 'return a different array reference so SWR re-renders',
      actual: applyTaskPatchToPages(pages, 'a', { status: 'x' }) === pages,
      expected: false,
    });
  });

  it('returns the same reference when no task matches', () => {
    const pages = [page([task({ id: 'a' })])];
    assert({
      given: 'a taskId that is not in the cache',
      should: 'return the input unchanged',
      actual: applyTaskPatchToPages(pages, 'nope', { status: 'x' }) === pages,
      expected: true,
    });
  });

  it('leaves undefined fields alone', () => {
    const pages = [page([task({ id: 'a', title: 'original', priority: 'high' })])];
    const next = applyTaskPatchToPages(pages, 'a', { status: 'done' });
    assert({
      given: 'a patch containing only status',
      should: 'keep title and priority',
      actual: [next?.[0].tasks[0].title, next?.[0].tasks[0].priority],
      expected: ['original', 'high'],
    });
  });

  it('applies an explicit null completedAt', () => {
    const pages = [page([task({ id: 'a', completedAt: '2026-01-02T00:00:00.000Z' })])];
    const next = applyTaskPatchToPages(pages, 'a', { completedAt: null });
    assert({
      given: 'a patch setting completedAt to null',
      should: 'clear it rather than treat null as absent',
      actual: next?.[0].tasks[0].completedAt,
      expected: null,
    });
  });
});

describe('applySubTaskCountsToPages', () => {
  it('increments the completed count', () => {
    const pages = [page([task({ id: 'a', subTaskCount: 3, subTaskCompletedCount: 1 })])];
    const next = applySubTaskCountsToPages(pages, 'a', { completed: 1 });
    assert({
      given: 'a parent with 1 of 3 sub-tasks complete',
      should: 'report 2 of 3',
      actual: [next?.[0].tasks[0].subTaskCompletedCount, next?.[0].tasks[0].subTaskCount],
      expected: [2, 3],
    });
  });

  it('clamps the completed count at the total', () => {
    const pages = [page([task({ id: 'a', subTaskCount: 2, subTaskCompletedCount: 2 })])];
    const next = applySubTaskCountsToPages(pages, 'a', { completed: 1 });
    assert({
      given: 'a completion delta that would exceed the total',
      should: 'clamp rather than render 3/2',
      actual: next?.[0].tasks[0].subTaskCompletedCount,
      expected: 2,
    });
  });

  it('clamps the completed count at zero', () => {
    const pages = [page([task({ id: 'a', subTaskCount: 2, subTaskCompletedCount: 0 })])];
    const next = applySubTaskCountsToPages(pages, 'a', { completed: -1 });
    assert({
      given: 'an un-completion delta below zero',
      should: 'clamp to zero rather than go negative',
      actual: next?.[0].tasks[0].subTaskCompletedCount,
      expected: 0,
    });
  });

  it('re-clamps completed when the total shrinks below it', () => {
    const pages = [page([task({ id: 'a', subTaskCount: 3, subTaskCompletedCount: 3 })])];
    const next = applySubTaskCountsToPages(pages, 'a', { total: -2 });
    assert({
      given: 'two sub-tasks deleted from a fully complete parent',
      should: 'bring the completed count down with the total',
      actual: [next?.[0].tasks[0].subTaskCount, next?.[0].tasks[0].subTaskCompletedCount],
      expected: [1, 1],
    });
  });

  it('is a no-op for an empty delta', () => {
    const pages = [page([task({ id: 'a', subTaskCount: 1 })])];
    assert({
      given: 'a delta with neither total nor completed',
      should: 'return the input unchanged',
      actual: applySubTaskCountsToPages(pages, 'a', {}) === pages,
      expected: true,
    });
  });

  it('does not mutate the input', () => {
    const pages = [page([task({ id: 'a', subTaskCount: 2, subTaskCompletedCount: 0 })])];
    applySubTaskCountsToPages(pages, 'a', { completed: 1 });
    assert({
      given: 'an input cache',
      should: 'leave the original counter alone',
      actual: pages[0].tasks[0].subTaskCompletedCount,
      expected: 0,
    });
  });
});

describe('shouldAppendOptimistically', () => {
  it('is false when a later page is unloaded', () => {
    assert({
      given: 'a last loaded page reporting hasMore',
      should: 'refuse the optimistic append',
      actual: shouldAppendOptimistically([page([], true)]),
      expected: false,
    });
  });

  it('is true when every page is loaded', () => {
    assert({
      given: 'a last loaded page reporting no more',
      should: 'allow the optimistic append',
      actual: shouldAppendOptimistically([page([], true), page([], false)]),
      expected: true,
    });
  });

  it('is false for an undefined or empty cache', () => {
    assert({
      given: 'no loaded pages',
      should: 'refuse the append',
      actual: [shouldAppendOptimistically(undefined), shouldAppendOptimistically([])],
      expected: [false, false],
    });
  });
});

describe('appendTaskToPages', () => {
  it('appends to the last loaded page, not the first', () => {
    const pages = [page([task({ id: 'a' })], true), page([task({ id: 'b' })])];
    const next = appendTaskToPages(pages, task({ id: 'c' }));
    assert({
      given: 'a two-page cache',
      should: 'put the new task at the end of the last page',
      actual: [next?.[0].tasks.map((t) => t.id), next?.[1].tasks.map((t) => t.id)],
      expected: [['a'], ['b', 'c']],
    });
  });

  it('does not mutate the input', () => {
    const pages = [page([task({ id: 'a' })])];
    appendTaskToPages(pages, task({ id: 'b' }));
    assert({
      given: 'an input cache',
      should: 'leave its task list at the original length',
      actual: pages[0].tasks.length,
      expected: 1,
    });
  });
});

describe('removeTaskFromPages', () => {
  it('removes the task from whichever page holds it', () => {
    const pages = [page([task({ id: 'a' })], true), page([task({ id: 'b' }), task({ id: 'c' })])];
    const next = removeTaskFromPages(pages, 'b');
    assert({
      given: 'a task on the second page',
      should: 'drop it and keep its page-mates',
      actual: next?.[1].tasks.map((t) => t.id),
      expected: ['c'],
    });
  });
});

describe('findTaskInPages', () => {
  it('searches every loaded page', () => {
    const pages = [page([task({ id: 'a' })], true), page([task({ id: 'b' })])];
    assert({
      given: 'a task on the second page',
      should: 'find it',
      actual: findTaskInPages(pages, 'b')?.id,
      expected: 'b',
    });
  });

  it('is undefined for an unknown id', () => {
    assert({
      given: 'an id not in the cache',
      should: 'return undefined',
      actual: findTaskInPages([page([task({ id: 'a' })])], 'z'),
      expected: undefined,
    });
  });
});

describe('resolveToggleStatus', () => {
  const configs = [
    config('backlog', 'todo', 0),
    config('doing', 'in_progress', 1),
    config('shipped', 'done', 2),
    config('archived', 'done', 3),
  ];

  it('picks the first done-group slug by position when completing', () => {
    assert({
      given: 'a vocabulary with two done statuses',
      should: 'pick the earlier one',
      actual: resolveToggleStatus(configs, false),
      expected: 'shipped',
    });
  });

  it('picks the first todo-group slug when un-completing', () => {
    assert({
      given: 'a vocabulary with a todo status',
      should: 'move back to it',
      actual: resolveToggleStatus(configs, true),
      expected: 'backlog',
    });
  });

  it('ignores array order and uses position', () => {
    const shuffled = [config('late', 'done', 5), config('early', 'done', 1)];
    assert({
      given: 'done configs listed out of position order',
      should: 'pick the lowest position',
      actual: resolveToggleStatus(shuffled, false),
      expected: 'early',
    });
  });

  it('falls back to completed when no done group exists', () => {
    assert({
      given: 'a vocabulary with no done-group status',
      should: 'fall back to the built-in completed slug',
      actual: resolveToggleStatus([config('backlog', 'todo', 0)], false),
      expected: 'completed',
    });
  });

  it('falls back to pending when no todo group exists', () => {
    assert({
      given: 'a vocabulary with no todo-group status',
      should: 'fall back to the built-in pending slug',
      actual: resolveToggleStatus([config('shipped', 'done', 0)], true),
      expected: 'pending',
    });
  });

  it('does not mutate the caller configs while sorting', () => {
    const input = [config('late', 'done', 5), config('early', 'done', 1)];
    resolveToggleStatus(input, false);
    assert({
      given: 'an unsorted configs array',
      should: 'still be in its original order afterwards',
      actual: input.map((c) => c.slug),
      expected: ['late', 'early'],
    });
  });
});

describe('blockedByOpenSubTasks', () => {
  it('allows a leaf', () => {
    assert({
      given: 'a task with no sub-tasks',
      should: 'not block',
      actual: blockedByOpenSubTasks({ subTaskCount: 0, subTaskCompletedCount: 0 }),
      expected: null,
    });
  });

  it('allows a parent whose sub-tasks are all done', () => {
    assert({
      given: 'a parent with 2 of 2 sub-tasks complete',
      should: 'not block',
      actual: blockedByOpenSubTasks({ subTaskCount: 2, subTaskCompletedCount: 2 }),
      expected: null,
    });
  });

  it('blocks and reports how many remain', () => {
    assert({
      given: 'a parent with 1 of 3 sub-tasks complete',
      should: 'block, naming the two that remain',
      actual: blockedByOpenSubTasks({ subTaskCount: 3, subTaskCompletedCount: 1 }),
      expected: { pending: 2, total: 3 },
    });
  });

  it('never reports a negative pending count', () => {
    assert({
      given: 'a completed count above the total',
      should: 'clamp and allow completion rather than report -1 pending',
      actual: blockedByOpenSubTasks({ subTaskCount: 2, subTaskCompletedCount: 5 }),
      expected: null,
    });
  });

  it('treats missing counters as a leaf', () => {
    assert({
      given: 'a task with undefined counters',
      should: 'not block',
      actual: blockedByOpenSubTasks({}),
      expected: null,
    });
  });
});

describe('taskFromCreateResponse', () => {
  it('defaults the derived fields the create route omits', () => {
    const created = taskFromCreateResponse({ id: 'new', title: 'New' } as Partial<TaskItem> & { id: string });
    assert({
      given: 'a POST response with no derived fields',
      should: 'default counts to zero and hasContent to false',
      actual: [
        created.subTaskCount,
        created.subTaskCompletedCount,
        created.hasContent,
        created.activeTriggerCount,
      ],
      expected: [0, 0, false, 0],
    });
  });

  it('does not override values the response did provide', () => {
    const created = taskFromCreateResponse({ id: 'new', hasContent: true } as Partial<TaskItem> & { id: string });
    assert({
      given: 'a response that carries hasContent',
      should: 'keep the response value',
      actual: created.hasContent,
      expected: true,
    });
  });
});
