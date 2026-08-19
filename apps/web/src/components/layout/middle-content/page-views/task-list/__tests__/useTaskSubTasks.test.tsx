/**
 * The sub-task fetch hook: what it asks for, what it refuses to ask for, and what
 * it serves from cache.
 *
 * The refusal is the load-bearing part. `GET /api/pages/[pageId]/tasks` writes on
 * read (see useTaskSubTasks' gate comment), so "a leaf task issues no request" is a
 * data-integrity guarantee, not a performance nicety. Proven against the real
 * database in useTaskSubTasks.integration.test.tsx; proven at the hook boundary here.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { useTaskSubTasks, shouldFetchSubTasks, getSubTaskPageKey, getSubTasksHasMore } from '../useTaskSubTasks';
import type { TaskItem, TaskListData } from '../task-list-types';

const { fetchWithAuth } = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth }));

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const makeSubTask = (id: string): TaskItem => ({
  id,
  userId: 'u1',
  assigneeId: null,
  assigneeAgentId: null,
  pageId: `page-${id}`,
  title: `Sub-task ${id}`,
  status: 'pending',
  priority: 'medium',
  position: 0,
  dueDate: null,
  completedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const respond = (body: TaskListData) => ({ ok: true, json: async () => body });

const makeBody = (tasks: TaskItem[], hasMore = false): TaskListData => ({
  taskList: { id: 'tl', title: 'Task List', description: null, status: 'pending', updatedAt: '2026-01-01T00:00:00.000Z' },
  tasks,
  statusConfigs: [],
  hasMore,
});

// A fresh SWR cache per wrapper factory; a shared one across a mount/unmount/remount
// is exactly what proves the re-expand cache hit.
const makeWrapper = () => {
  const cache = new Map();
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>{children}</SWRConfig>;
  };
};

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('shouldFetchSubTasks (the gate)', () => {
  it('refuses a leaf task', () => {
    assert({
      given: 'a task with subTaskCount 0',
      should: 'not fetch — the route would lazily write a task_list for it',
      actual: shouldFetchSubTasks({ pageId: 'p1', subTaskCount: 0 }),
      expected: false,
    });
  });

  it('refuses a task whose subTaskCount is unknown', () => {
    assert({
      given: 'a task with no subTaskCount field',
      should: 'not fetch',
      actual: shouldFetchSubTasks({ pageId: 'p1' }),
      expected: false,
    });
  });

  it('refuses a task with no linked page', () => {
    assert({
      given: 'a task with a null pageId but a positive subTaskCount',
      should: 'not fetch — there is no pageId to address the route with',
      actual: shouldFetchSubTasks({ pageId: null, subTaskCount: 3 }),
      expected: false,
    });
  });

  it('allows a task with sub-tasks', () => {
    assert({
      given: 'a task with subTaskCount 3',
      should: 'fetch',
      actual: shouldFetchSubTasks({ pageId: 'p1', subTaskCount: 3 }),
      expected: true,
    });
  });
});

describe('getSubTaskPageKey', () => {
  it('addresses the existing route with the task own pageId', () => {
    assert({
      given: 'a task with sub-tasks, first page',
      should: 'key on GET /api/pages/{task.pageId}/tasks with limit and offset 0',
      actual: getSubTaskPageKey({ pageId: 'task-page', subTaskCount: 2 }, true)(0, null),
      expected: '/api/pages/task-page/tasks?limit=100&offset=0',
    });
  });

  it('pages by offset', () => {
    assert({
      given: 'page index 2 after a page that reported hasMore',
      should: 'offset by two full pages',
      actual: getSubTaskPageKey({ pageId: 'task-page', subTaskCount: 300 }, true)(2, makeBody([], true)),
      expected: '/api/pages/task-page/tasks?limit=100&offset=200',
    });
  });

  it('stops at the end of the list', () => {
    assert({
      given: 'a previous page that reported hasMore false',
      should: 'return a null key so SWR requests nothing further',
      actual: getSubTaskPageKey({ pageId: 'task-page', subTaskCount: 2 }, true)(1, makeBody([], false)),
      expected: null,
    });
  });

  it('stays null while disabled', () => {
    assert({
      given: 'a task with sub-tasks but enabled false (row collapsed)',
      should: 'return a null key',
      actual: getSubTaskPageKey({ pageId: 'task-page', subTaskCount: 2 }, false)(0, null),
      expected: null,
    });
  });

  it('stays null for a leaf task', () => {
    assert({
      given: 'an enabled leaf task',
      should: 'return a null key',
      actual: getSubTaskPageKey({ pageId: 'task-page', subTaskCount: 0 }, true)(0, null),
      expected: null,
    });
  });
});

describe('getSubTasksHasMore', () => {
  it('reads the most recent page only', () => {
    assert({
      given: 'a first page saying hasMore and a second saying not',
      should: 'report the second — earlier bounds are stale',
      actual: getSubTasksHasMore([makeBody([], true), makeBody([], false)]),
      expected: false,
    });
  });

  it('handles no pages', () => {
    assert({
      given: 'undefined pages',
      should: 'report no more',
      actual: getSubTasksHasMore(undefined),
      expected: false,
    });
  });
});

describe('useTaskSubTasks', () => {
  it('issues no request for a leaf task', async () => {
    const { result } = renderHook(
      () => useTaskSubTasks({ pageId: 'leaf-page', subTaskCount: 0 }),
      { wrapper: makeWrapper() },
    );

    // Give any errant effect a full macrotask to fire before concluding it didn't.
    await new Promise((r) => setTimeout(r, 0));

    assert({
      given: 'an expanded leaf task',
      should: 'never call the route',
      actual: fetchWithAuth.mock.calls.length,
      expected: 0,
    });
    assert({
      given: 'an expanded leaf task',
      should: 'report no sub-tasks and not be loading',
      actual: { subTasks: result.current.subTasks, isLoading: result.current.isLoading },
      expected: { subTasks: [], isLoading: false },
    });
  });

  it('issues no request while collapsed', async () => {
    renderHook(
      () => useTaskSubTasks({ pageId: 'parent-page', subTaskCount: 4 }, { enabled: false }),
      { wrapper: makeWrapper() },
    );
    await new Promise((r) => setTimeout(r, 0));

    assert({
      given: 'a task with sub-tasks that is not expanded',
      should: 'never call the route',
      actual: fetchWithAuth.mock.calls.length,
      expected: 0,
    });
  });

  it('loads sub-tasks for a task that has them', async () => {
    fetchWithAuth.mockResolvedValue(respond(makeBody([makeSubTask('a'), makeSubTask('b')])));

    const { result } = renderHook(
      () => useTaskSubTasks({ pageId: 'parent-page', subTaskCount: 2 }),
      { wrapper: makeWrapper() },
    );

    await waitFor(() => expect(result.current.subTasks).toHaveLength(2));

    assert({
      given: 'a task with two sub-tasks',
      should: 'call the existing route with the task own pageId',
      actual: fetchWithAuth.mock.calls[0][0],
      expected: '/api/pages/parent-page/tasks?limit=100&offset=0',
    });
    assert({
      given: 'a task with two sub-tasks',
      should: 'surface them in order',
      actual: result.current.subTasks.map((t) => t.id),
      expected: ['a', 'b'],
    });
  });

  it('does not refetch on collapse then re-expand', async () => {
    fetchWithAuth.mockResolvedValue(respond(makeBody([makeSubTask('a')])));
    const wrapper = makeWrapper();

    const first = renderHook(
      () => useTaskSubTasks({ pageId: 'parent-page', subTaskCount: 1 }),
      { wrapper },
    );
    await waitFor(() => expect(first.result.current.subTasks).toHaveLength(1));
    const callsAfterFirstExpand = fetchWithAuth.mock.calls.length;

    // Collapse: TaskListView unmounts the expansion entirely.
    first.unmount();

    const second = renderHook(
      () => useTaskSubTasks({ pageId: 'parent-page', subTaskCount: 1 }),
      { wrapper },
    );
    await waitFor(() => expect(second.result.current.subTasks).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));

    assert({
      given: 'the same task expanded, collapsed, and expanded again',
      should: 'serve the second expansion from cache without a second request',
      actual: fetchWithAuth.mock.calls.length,
      expected: callsAfterFirstExpand,
    });
  });

  it('does not report loading-more forever once the list is exhausted', async () => {
    // Only one page exists. A caller that calls loadMore anyway (the hook is public API and
    // does not police it) bumps `size` to 2, but the key function returns null for index 1,
    // so `pages` can never reach that size. Without the hasMore term this latched on forever.
    fetchWithAuth.mockResolvedValue(respond(makeBody([makeSubTask('a')], false)));

    const { result } = renderHook(
      () => useTaskSubTasks({ pageId: 'parent-page', subTaskCount: 1 }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.subTasks).toHaveLength(1));
    await act(async () => { result.current.loadMore(); });
    await new Promise((r) => setTimeout(r, 0));

    assert({
      given: 'loadMore called after a page that reported hasMore false',
      should: 'not be stuck reporting isLoadingMore',
      actual: { isLoadingMore: result.current.isLoadingMore, requests: fetchWithAuth.mock.calls.length },
      expected: { isLoadingMore: false, requests: 1 },
    });
  });

  it('pages through a long sub-task list on demand', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(respond(makeBody([makeSubTask('a')], true)))
      .mockResolvedValueOnce(respond(makeBody([makeSubTask('b')], false)));

    const { result } = renderHook(
      () => useTaskSubTasks({ pageId: 'parent-page', subTaskCount: 2 }),
      { wrapper: makeWrapper() },
    );

    await waitFor(() => expect(result.current.hasMore).toBe(true));
    await act(async () => { result.current.loadMore(); });

    await waitFor(() => expect(result.current.subTasks).toHaveLength(2));

    assert({
      given: 'a first page reporting hasMore and a Load more click',
      should: 'request the next offset and append its sub-tasks',
      actual: {
        secondUrl: fetchWithAuth.mock.calls[1][0],
        ids: result.current.subTasks.map((t) => t.id),
        hasMore: result.current.hasMore,
      },
      expected: {
        secondUrl: '/api/pages/parent-page/tasks?limit=100&offset=100',
        ids: ['a', 'b'],
        hasMore: false,
      },
    });
  });
});
