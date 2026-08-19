import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type {
  TaskItem,
  TaskListData,
} from '@/components/layout/middle-content/page-views/task-list/task-list-types';

const patchMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock('@/lib/auth/auth-fetch', () => ({
  patch: (...args: unknown[]) => patchMock(...args),
}));
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastErrorMock(...a) } }));

const { useTaskWriteMachinery, useTaskWriter } = await import('../task-write-context');

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

const pages = (tasks: TaskItem[]): TaskListData[] => [{
  taskList: { id: 'l1', title: 'L', description: null, status: 'active', updatedAt: 'x' },
  tasks,
  statusConfigs: [],
  hasMore: false,
}];

/**
 * Stands in for swr/infinite's bound mutate: records what it was called with,
 * and (like SWR) runs the async updater and rethrows its rejection.
 */
const makeMutate = (initial: TaskListData[]) => {
  // Records what SWR was asked to do, and — like SWR — resolves functional
  // `optimisticData` and the async updater against the CURRENT cache value,
  // which is what proves the writer never patches a captured snapshot.
  const calls: { optimisticData?: TaskListData[]; revalidate?: boolean; rollbackOnError?: boolean }[] = [];
  const results: (TaskListData[] | undefined)[] = [];
  let current: TaskListData[] | undefined = initial;
  const mutate = vi.fn(async (data?: unknown, opts?: Record<string, unknown>) => {
    const rawOptimistic = opts?.optimisticData;
    const optimisticData = typeof rawOptimistic === 'function'
      ? (rawOptimistic as (c?: TaskListData[]) => TaskListData[])(current)
      : rawOptimistic as TaskListData[] | undefined;
    calls.push({ ...opts, optimisticData } as never);
    if (optimisticData) current = optimisticData;
    if (typeof data === 'function') {
      const out = await (data as (c?: TaskListData[]) => Promise<TaskListData[] | undefined>)(current);
      results.push(out);
      if (out) current = out;
      return out;
    }
    return undefined;
  });
  return { mutate, calls, results };
};

const setup = (initial: TaskListData[], revalidateAll = vi.fn()) => {
  const { mutate, calls, results } = makeMutate(initial);
  const view = renderHook(() => {
    const machinery = useTaskWriteMachinery('user-me', revalidateAll);
    const writer = useTaskWriter({
      mutatePages: mutate as never,
      onRevisionConflict: revalidateAll,
      machinery,
    });
    return { machinery, writer };
  });
  return { view, mutate, calls, results, revalidateAll };
};

beforeEach(() => {
  patchMock.mockReset();
  toastErrorMock.mockReset();
});

describe('writeTaskField', () => {
  it('PATCHes the list the task belongs to, not the viewed list', async () => {
    // The nested-row contract: a sub-task's write must address its parent
    // task's page, or the route's parent-child check 404s.
    patchMock.mockResolvedValue(task({ id: 't1', status: 'completed', updatedAt: 'stamp' }));
    const { view } = setup(pages([task({ id: 't1' })]));
    await act(async () => {
      await view.result.current.writer.writeTaskField({
        loc: { listPageId: 'parent-task-page', taskId: 't1' },
        body: { status: 'completed' },
        optimistic: { status: 'completed' },
        fallbackMessage: 'nope',
      });
    });
    assert({
      given: 'a write located on a nested list',
      should: 'address that list page',
      actual: patchMock.mock.calls[0][0],
      expected: '/api/pages/parent-task-page/tasks/t1',
    });
  });

  it('shows the new value before the request resolves, and never revalidates', async () => {
    // This is the reported lag. `revalidate: false` is what stops the
    // post-write refetch of every loaded page.
    let resolve: (v: TaskItem) => void = () => {};
    patchMock.mockReturnValue(new Promise<TaskItem>((r) => { resolve = r; }));
    const { view, calls } = setup(pages([task({ id: 't1' })]));

    let pending: Promise<boolean>;
    await act(async () => {
      pending = view.result.current.writer.writeTaskField({
        loc: { listPageId: 'list', taskId: 't1' },
        body: { status: 'completed' },
        optimistic: { status: 'completed', completedAt: '2026-01-02T00:00:00.000Z' },
        fallbackMessage: 'nope',
      });
      await Promise.resolve();
    });

    assert({
      given: 'a write still in flight',
      should: 'have already handed SWR the completed row, with revalidation off',
      actual: [
        calls[0].optimisticData?.[0].tasks[0].status,
        calls[0].optimisticData?.[0].tasks[0].completedAt,
        calls[0].revalidate,
        calls[0].rollbackOnError,
      ],
      expected: ['completed', '2026-01-02T00:00:00.000Z', false, true],
    });

    await act(async () => {
      resolve(task({ id: 't1', status: 'completed', completedAt: 'server-stamp', updatedAt: 's1' }));
      await pending!;
    });
  });

  it('reconciles onto the server values rather than keeping the guess', async () => {
    patchMock.mockResolvedValue(
      task({ id: 't1', status: 'shipped', completedAt: 'server-stamp', updatedAt: 's1' }),
    );
    const { view, results } = setup(pages([task({ id: 't1' })]));
    await act(async () => {
      await view.result.current.writer.writeTaskField({
        loc: { listPageId: 'list', taskId: 't1' },
        body: { status: 'shipped' },
        optimistic: { status: 'shipped', completedAt: 'client-guess' },
        fallbackMessage: 'nope',
      });
    });
    assert({
      given: 'a resolved write whose server completedAt differs from the guess',
      should: 'store the server value',
      actual: results[0]?.[0].tasks[0].completedAt,
      expected: 'server-stamp',
    });
  });

  it('surfaces the server message on a 422 and reports failure', async () => {
    patchMock.mockRejectedValue(Object.assign(new Error('x'), {
      status: 422,
      body: { code: 'SUBTASKS_INCOMPLETE', error: 'Complete all sub-tasks first (1 of 2 remaining)' },
    }));
    const { view } = setup(pages([task({ id: 't1' })]));
    let ok: boolean | undefined;
    await act(async () => {
      ok = await view.result.current.writer.writeTaskField({
        loc: { listPageId: 'list', taskId: 't1' },
        body: { status: 'completed' },
        optimistic: { status: 'completed' },
        fallbackMessage: 'Failed to update status',
      });
    });
    assert({
      given: 'a write the server blocked on open sub-tasks',
      should: 'report failure and toast the reason',
      actual: [ok, toastErrorMock.mock.calls[0][0]],
      expected: [false, 'Complete all sub-tasks first (1 of 2 remaining)'],
    });
  });

  it('refetches on a revision conflict instead of trusting the rollback', async () => {
    patchMock.mockRejectedValue(Object.assign(new Error('x'), { status: 409, body: {} }));
    const revalidateAll = vi.fn();
    const { view } = setup(pages([task({ id: 't1' })]), revalidateAll);
    await act(async () => {
      await view.result.current.writer.writeTaskField({
        loc: { listPageId: 'list', taskId: 't1' },
        body: { title: 'new' },
        optimistic: { title: 'new' },
        fallbackMessage: 'Failed to update task',
      });
    });
    assert({
      given: 'a 409 revision conflict',
      should: 'revalidate, because the rolled-back data is already stale',
      actual: revalidateAll.mock.calls.length,
      expected: 1,
    });
  });
});

describe('echo suppression', () => {
  const echo = (updatedAt: string | null, userId = 'user-me') => ({
    taskId: 't1',
    userId,
    data: updatedAt === null ? {} : { updatedAt },
  });

  it('ignores the echo of a write this tab just made', async () => {
    patchMock.mockResolvedValue(task({ id: 't1', updatedAt: 'stamp-1' }));
    const { view } = setup(pages([task({ id: 't1' })]));
    await act(async () => {
      await view.result.current.writer.writeTaskField({
        loc: { listPageId: 'list', taskId: 't1' },
        body: { status: 'completed' },
        optimistic: { status: 'completed' },
        fallbackMessage: 'nope',
      });
    });
    assert({
      given: 'the socket echo of our own completed write',
      should: 'not trigger a revalidation',
      actual: view.result.current.machinery.shouldRevalidateForEvent(echo('stamp-1')),
      expected: false,
    });
  });

  it('still revalidates for the same account in another tab', async () => {
    patchMock.mockResolvedValue(task({ id: 't1', updatedAt: 'stamp-1' }));
    const { view } = setup(pages([task({ id: 't1' })]));
    await act(async () => {
      await view.result.current.writer.writeTaskField({
        loc: { listPageId: 'list', taskId: 't1' },
        body: { status: 'completed' },
        optimistic: { status: 'completed' },
        fallbackMessage: 'nope',
      });
    });
    assert({
      given: 'an event for the same task and user but a different write',
      should: 'revalidate — suppressing on userId alone would strand a second tab',
      actual: view.result.current.machinery.shouldRevalidateForEvent(echo('stamp-2')),
      expected: true,
    });
  });

  it('defers, then runs, one revalidation when an echo races our own write', async () => {
    let resolve: (v: TaskItem) => void = () => {};
    patchMock.mockReturnValue(new Promise<TaskItem>((r) => { resolve = r; }));
    const revalidateAll = vi.fn();
    const { view } = setup(pages([task({ id: 't1' })]), revalidateAll);

    let pending: Promise<boolean>;
    await act(async () => {
      pending = view.result.current.writer.writeTaskField({
        loc: { listPageId: 'list', taskId: 't1' },
        body: { status: 'completed' },
        optimistic: { status: 'completed' },
        fallbackMessage: 'nope',
      });
      await Promise.resolve();
    });

    const duringFlight = view.result.current.machinery.shouldRevalidateForEvent(echo('who-knows'));
    const beforeSettle = revalidateAll.mock.calls.length;

    await act(async () => {
      resolve(task({ id: 't1', updatedAt: 'stamp-1' }));
      await pending!;
    });

    assert({
      given: 'an echo arriving before our own PATCH response',
      should: 'drop it in the moment, then revalidate once the write settles',
      actual: [duringFlight, beforeSettle, revalidateAll.mock.calls.length],
      expected: [false, 0, 1],
    });
  });

  it('stops suppressing after a failed write', async () => {
    // A failed write must not leave an in-flight record behind, or every later
    // event for that task is read as our echo and dropped for the whole TTL.
    patchMock.mockRejectedValue(Object.assign(new Error('x'), { status: 500, body: {} }));
    const { view } = setup(pages([task({ id: 't1' })]));
    await act(async () => {
      await view.result.current.writer.writeTaskField({
        loc: { listPageId: 'list', taskId: 't1' },
        body: { status: 'completed' },
        optimistic: { status: 'completed' },
        fallbackMessage: 'nope',
      });
    });
    assert({
      given: 'an event after our write failed',
      should: 'revalidate normally',
      actual: view.result.current.machinery.shouldRevalidateForEvent(echo('anything')),
      expected: true,
    });
  });

  it('revalidates for another user', () => {
    const { view } = setup(pages([task({ id: 't1' })]));
    assert({
      given: 'an event from a different user',
      should: 'revalidate',
      actual: view.result.current.machinery.shouldRevalidateForEvent(echo('stamp', 'user-other')),
      expected: true,
    });
  });
});
