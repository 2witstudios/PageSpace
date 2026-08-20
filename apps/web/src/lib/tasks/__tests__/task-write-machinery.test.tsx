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

const { useTaskWriteMachinery, useTaskWriter } = await import('../task-write-machinery');

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
/** Monotonic tick, so tests can assert the ORDER of two observed events. */
let tick = 0;
const nextTick = () => ++tick;

const makeMutate = (initial: TaskListData[]) => {
  // Records what SWR was asked to do, and — like SWR — resolves functional
  // `optimisticData` and the async updater against the CURRENT cache value,
  // which is what proves the writer never patches a captured snapshot.
  const calls: { optimisticData?: TaskListData[]; revalidate?: boolean; rollbackOnError?: boolean }[] = [];
  const results: (TaskListData[] | undefined)[] = [];
  let current: TaskListData[] | undefined = initial;
  let commitAt: number | null = null;
  const mutate = vi.fn(async (data?: unknown, opts?: Record<string, unknown>) => {
    const rawOptimistic = opts?.optimisticData;
    const optimisticData = typeof rawOptimistic === 'function'
      ? (rawOptimistic as (c?: TaskListData[]) => TaskListData[])(current)
      : rawOptimistic as TaskListData[] | undefined;
    calls.push({ ...opts, optimisticData } as never);
    const before = current;
    if (optimisticData) current = optimisticData;
    if (typeof data === 'function') {
      try {
        const out = await (data as (c?: TaskListData[]) => Promise<TaskListData[] | undefined>)(current);
        results.push(out);
        // The commit: SWR writes the updater's return value into the cache here.
        if (out) { current = out; commitAt = nextTick(); }
        return out;
      } catch (e) {
        // SWR restores the pre-optimistic value when rollbackOnError is set.
        // Modelling it is what lets a test assert the ROLLBACK rather than just
        // the presence of the option.
        if (opts?.rollbackOnError) current = before;
        throw e;
      }
    }
    return undefined;
  });
  return { mutate, calls, results, committedAt: () => commitAt, cache: () => current };
};

// Two distinct spies on purpose: the machinery's view-wide `revalidateAll` and
// the writer's `onRevisionConflict` are different paths, and sharing one mock
// made both the 409 assertion and the deferred-echo assertion read the same
// counter — neither proved which one actually fired.
const setup = (
  initial: TaskListData[],
  revalidateAll = vi.fn(),
  onRevisionConflict = vi.fn(),
) => {
  const { mutate, calls, results, committedAt, cache } = makeMutate(initial);
  let revalidatedAt: number | null = null;
  const trackedRevalidateAll = () => { revalidatedAt = nextTick(); revalidateAll(); };
  const view = renderHook(() => {
    const machinery = useTaskWriteMachinery('user-me', trackedRevalidateAll);
    const writer = useTaskWriter({ mutatePages: mutate as never, onRevisionConflict, machinery });
    return { machinery, writer };
  });
  return {
    view, mutate, calls, results, revalidateAll, onRevisionConflict,
    committedAt, cache, revalidatedAt: () => revalidatedAt,
  };
};

beforeEach(() => {
  patchMock.mockReset();
  toastErrorMock.mockReset();
  tick = 0;
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

  it('rolls the optimistic patch back when the write fails', async () => {
    // Previously only the rollbackOnError OPTION was asserted; nothing checked
    // that the row actually reverts, so a change that stopped passing it — or
    // passed it somewhere ineffective — would not have been caught.
    patchMock.mockRejectedValue(Object.assign(new Error('x'), { status: 500, body: {} }));
    const { view, cache } = setup(pages([task({ id: 't1', status: 'pending' })]));
    await act(async () => {
      await view.result.current.writer.writeTaskField({
        loc: { listPageId: 'list', taskId: 't1' },
        body: { status: 'completed' },
        optimistic: { status: 'completed', completedAt: 'guess' },
        fallbackMessage: 'Failed to update status',
      });
    });
    assert({
      given: 'an optimistic completion whose write then failed',
      should: 'leave the row exactly as it was',
      actual: [cache()?.[0].tasks[0].status, cache()?.[0].tasks[0].completedAt],
      expected: ['pending', null],
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
    const onRevisionConflict = vi.fn();
    const { view } = setup(pages([task({ id: 't1' })]), revalidateAll, onRevisionConflict);
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
      should: 'take the conflict path only — not the view-wide deferred revalidation',
      actual: [onRevisionConflict.mock.calls.length, revalidateAll.mock.calls.length],
      expected: [1, 0],
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
    const { view, committedAt, revalidatedAt } = setup(pages([task({ id: 't1' })]), revalidateAll);

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

    assert({
      given: 'the same deferred-echo write',
      should: 'flush the revalidation only AFTER the cache write committed',
      // Revalidating from inside SWR's updater starts a refetch that can land
      // before the updater commits, and that commit would then overwrite the
      // foreign change the refetch just fetched.
      actual: {
        committed: committedAt() !== null,
        revalidatedAfterCommit: (revalidatedAt() ?? 0) > (committedAt() ?? 0),
      },
      expected: { committed: true, revalidatedAfterCommit: true },
    });
  });

  it('does not revalidate when the deferred echo turns out to have been ours', async () => {
    // The PATCH route awaits its realtime broadcasts BEFORE returning, so our
    // own echo routinely arrives while the write is still open and gets
    // deferred. Re-classifying it once the stamp is known is what keeps the
    // common click from ending in a full revalidation after all.
    let resolve: (v: TaskItem) => void = () => {};
    patchMock.mockReturnValue(new Promise<TaskItem>((r) => { resolve = r; }));
    const revalidateAll = vi.fn();
    const { view } = setup(pages([task({ id: 't1' })]), revalidateAll);

    let pending: Promise<boolean>;
    await act(async () => {
      pending = view.result.current.writer.writeTaskField({
        loc: { listPageId: 'list', taskId: 't1' },
        body: { status: 'completed' }, optimistic: { status: 'completed' },
        fallbackMessage: 'nope',
      });
      await Promise.resolve();
    });

    // The echo of THIS write, arriving before its response.
    const duringFlight = view.result.current.machinery.shouldRevalidateForEvent(echo('stamp-1'));

    await act(async () => {
      resolve(task({ id: 't1', updatedAt: 'stamp-1' }));
      await pending!;
    });

    assert({
      given: 'a deferred echo carrying the stamp our own write settled with',
      should: 'drop it on settle rather than revalidating',
      actual: [duringFlight, revalidateAll.mock.calls.length],
      expected: [false, 0],
    });
  });

  it('waits for a concurrent write on the SAME task before flushing', async () => {
    // Two writes to one task overlap on a double-clicked checkbox. Keying the
    // in-flight records on taskId alone let the first to settle erase the
    // second's marker, so the guard reported "nothing open" and the
    // revalidation could race the second write's commit.
    let resolveA: (v: TaskItem) => void = () => {};
    let resolveB: (v: TaskItem) => void = () => {};
    patchMock
      .mockReturnValueOnce(new Promise<TaskItem>((r) => { resolveA = r; }))
      .mockReturnValueOnce(new Promise<TaskItem>((r) => { resolveB = r; }));
    const revalidateAll = vi.fn();
    const { view } = setup(pages([task({ id: 't1' })]), revalidateAll);

    let pendingA: Promise<boolean>; let pendingB: Promise<boolean>;
    await act(async () => {
      pendingA = view.result.current.writer.writeTaskField({
        loc: { listPageId: 'list', taskId: 't1' },
        body: { status: 'completed' }, optimistic: { status: 'completed' },
        fallbackMessage: 'nope',
      });
      pendingB = view.result.current.writer.writeTaskField({
        loc: { listPageId: 'list', taskId: 't1' },
        body: { status: 'pending' }, optimistic: { status: 'pending' },
        fallbackMessage: 'nope',
      });
      await Promise.resolve();
    });

    // A foreign edit to the same task arrives while both are open.
    view.result.current.machinery.shouldRevalidateForEvent(echo('someone-else'));

    await act(async () => {
      resolveA(task({ id: 't1', updatedAt: 'stamp-a' }));
      await pendingA!;
    });
    const afterA = revalidateAll.mock.calls.length;

    await act(async () => {
      resolveB(task({ id: 't1', updatedAt: 'stamp-b' }));
      await pendingB!;
    });

    assert({
      given: 'two overlapping writes to one task, the first settling first',
      should: 'hold the revalidation until the second settles too, then run it once',
      actual: [afterA, revalidateAll.mock.calls.length],
      expected: [0, 1],
    });
  });

  it('waits for a concurrent write before flushing the deferred revalidation', async () => {
    // The flag is view-wide. Write A takes a deferred echo and stays open while
    // write B settles: if B's flush ran, the refetch could land before A commits
    // and A would overwrite the foreign change it fetched.
    let resolveA: (v: TaskItem) => void = () => {};
    let resolveB: (v: TaskItem) => void = () => {};
    patchMock
      .mockReturnValueOnce(new Promise<TaskItem>((r) => { resolveA = r; }))
      .mockReturnValueOnce(new Promise<TaskItem>((r) => { resolveB = r; }));
    const revalidateAll = vi.fn();
    const { view } = setup(pages([task({ id: 't1' }), task({ id: 't2' })]), revalidateAll);

    let pendingA: Promise<boolean>; let pendingB: Promise<boolean>;
    await act(async () => {
      pendingA = view.result.current.writer.writeTaskField({
        loc: { listPageId: 'list', taskId: 't1' },
        body: { status: 'completed' }, optimistic: { status: 'completed' },
        fallbackMessage: 'nope',
      });
      pendingB = view.result.current.writer.writeTaskField({
        loc: { listPageId: 'list', taskId: 't2' },
        body: { status: 'completed' }, optimistic: { status: 'completed' },
        fallbackMessage: 'nope',
      });
      await Promise.resolve();
    });

    // An echo for A arrives while both are open.
    view.result.current.machinery.shouldRevalidateForEvent(echo('who-knows'));

    // B finishes first. A is still open, so nothing may be revalidated yet.
    await act(async () => {
      resolveB(task({ id: 't2', updatedAt: 'stamp-b' }));
      await pendingB!;
    });
    const afterB = revalidateAll.mock.calls.length;

    // A finishes: now the last open write is gone and the flush runs, once.
    await act(async () => {
      resolveA(task({ id: 't1', updatedAt: 'stamp-a' }));
      await pendingA!;
    });

    assert({
      given: 'a deferred echo while two writes are open, the unrelated one settling first',
      should: 'hold the revalidation until the last write settles, then run it once',
      actual: [afterB, revalidateAll.mock.calls.length],
      expected: [0, 1],
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
