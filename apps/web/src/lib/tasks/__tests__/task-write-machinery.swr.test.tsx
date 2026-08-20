/**
 * The write path against REAL swr/infinite, not a stand-in.
 *
 * The sibling suite mocks `mutate`, which is right for asserting what the
 * writer ASKS for. It cannot prove what SWR then does, and the difference is
 * not academic: the previous implementation used `optimisticData` + an async
 * updater, and lost a committed write whenever two overlapped on one key —
 * a user ticking two checkboxes in a row. Every fake of `mutate` written
 * against the intended semantics rather than the real ones hides that, because
 * the two facts that cause it are exactly the two a fake omits:
 *
 *   • `optimisticData(committedData, …)` and `data(committedData)` receive the
 *     PRE-optimistic snapshot (`state._c`), not the value on screen.
 *   • A superseded mutation (`beforeMutationTs !== MUTATION[key][0]`) skips
 *     `populateCache` and writes nothing at all.
 *
 * So this file drives the real hook and asserts the real cache.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';
import useSWRInfinite from 'swr/infinite';
import type {
  TaskItem,
  TaskListData,
} from '@/components/layout/middle-content/page-views/task-list/task-list-types';

const patchMock = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({ patch: (...a: unknown[]) => patchMock(...a) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

const { useTaskWriteMachinery, useTaskWriter } = await import('../task-write-machinery');

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const task = (id: string): TaskItem => ({
  id,
  userId: 'u1', assigneeId: null, assigneeAgentId: null, pageId: `page-${id}`,
  title: id, status: 'pending', priority: 'medium', position: 0, dueDate: null,
  completedAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

const initialPage: TaskListData = {
  taskList: { id: 'l1', title: 'L', description: null, status: 'active', updatedAt: 'x' },
  tasks: [task('t1'), task('t2')],
  statusConfigs: [],
  hasMore: false,
};

/** A promise whose resolution the test controls, one per task id. */
const deferrals = new Map<string, (value: unknown) => void>();
const deferFor = (taskId: string) => new Promise((resolve) => { deferrals.set(taskId, resolve); });
const settle = async (taskId: string, value: unknown) => {
  await act(async () => { deferrals.get(taskId)!(value); await Promise.resolve(); });
};

const { applyTaskPatchToPages: applyPatch } = await import('../task-cache-core');

/**
 * Reproduces the root list's gate, which is `hasLoadedRef.current &&
 * isAnyEditing` — it pauses only AFTER the first load, so the flag has to be
 * flipped by the test rather than set here, or nothing ever loads.
 */
let paused = false;
const pausedWrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, isPaused: () => paused }}>
    {children}
  </SWRConfig>
);

const wrapper = ({ children }: { children: React.ReactNode }) => (
  // A fresh provider per test: SWR's cache is module-global otherwise, and the
  // second test would inherit the first's committed data.
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

const useHarness = () => {
  const swr = useSWRInfinite<TaskListData>(
    (index) => `tasks-${index}`,
    async () => initialPage,
    { revalidateAll: true, revalidateOnFocus: false, revalidateOnReconnect: false,
      revalidateFirstPage: false, revalidateIfStale: false },
  );
  const machinery = useTaskWriteMachinery('u1', vi.fn());
  const writer = useTaskWriter({ mutatePages: swr.mutate, machinery });
  return { data: swr.data, mutate: swr.mutate, writer };
};

const statuses = (data: TaskListData[] | undefined) => data?.[0].tasks.map((t) => t.status);

describe('task writes against real SWR', () => {
  beforeEach(() => { patchMock.mockReset(); deferrals.clear(); paused = false; });

  it('keeps both writes when two overlap on one cache', async () => {
    patchMock.mockImplementation((url: string) => deferFor(url.split('/').pop()!));
    const { result } = renderHook(useHarness, { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    // Both clicks before either PATCH returns — the real sequence a user makes,
    // and the one the old optimistic path could not survive.
    let firstDone: Promise<boolean> | undefined;
    let secondDone: Promise<boolean> | undefined;
    await act(async () => {
      firstDone = result.current.writer.writeTaskField({
        loc: { listPageId: 'p', taskId: 't1' }, body: { status: 'completed' },
        optimistic: { status: 'completed' }, fallbackMessage: 'x',
      });
    });
    await act(async () => {
      secondDone = result.current.writer.writeTaskField({
        loc: { listPageId: 'p', taskId: 't2' }, body: { status: 'completed' },
        optimistic: { status: 'completed' }, fallbackMessage: 'x',
      });
    });


    const bothPainted = statuses(result.current.data);

    await settle('t1', { status: 'completed', completedAt: '2026-02-01T00:00:00.000Z', updatedAt: 'a' });
    await settle('t2', { status: 'completed', completedAt: '2026-02-01T00:00:01.000Z', updatedAt: 'b' });
    await act(async () => { await firstDone; await secondDone; });

    assert({
      given: 'two checkbox writes started before either response arrived',
      should: 'show both immediately AND keep both after both commit',
      actual: {
        painted: bothPainted,
        committed: statuses(result.current.data),
        stamps: result.current.data?.[0].tasks.map((t) => t.updatedAt),
      },
      expected: {
        painted: ['completed', 'completed'],
        committed: ['completed', 'completed'],
        stamps: ['a', 'b'],
      },
    });
  });

  it('undoes a failed write locally, without help from a refetch', async () => {
    // The root list runs `isPaused: () => isAnyEditing`, and SWR returns early
    // from every revalidation while that holds — so on a paused cache the
    // error path's refetch is never issued at all. If the undo depended on it,
    // a completion the server rejected would stay on screen until the
    // 5-minute interval, which is gated the same way. Pausing here is what
    // makes this test able to tell the two apart.
    patchMock.mockRejectedValue(Object.assign(new Error('no'), { status: 500, body: {} }));
    const { result } = renderHook(useHarness, { wrapper: pausedWrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    paused = true;

    await act(async () => {
      await result.current.writer.writeTaskField({
        loc: { listPageId: 'p', taskId: 't1' }, body: { status: 'completed' },
        optimistic: { status: 'completed', completedAt: 'client-guess' }, fallbackMessage: 'x',
      });
    });

    assert({
      given: 'a failed write on a cache whose revalidation is paused',
      should: 'put the row back anyway',
      actual: {
        status: result.current.data?.[0].tasks[0].status,
        completedAt: result.current.data?.[0].tasks[0].completedAt,
      },
      expected: { status: 'pending', completedAt: null },
    });
  });

  it('leaves a failed write alone if something newer already changed the row', async () => {
    // The undo is conditional for this case: restoring what this write
    // displaced would otherwise revert a newer, correct value.
    patchMock.mockImplementation(() => Promise.reject(
      Object.assign(new Error('no'), { status: 500, body: {} }),
    ));
    const { result } = renderHook(useHarness, { wrapper: pausedWrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    paused = true;

    const failing = act(async () => {
      await result.current.writer.writeTaskField({
        loc: { listPageId: 'p', taskId: 't1' }, body: { status: 'completed' },
        optimistic: { status: 'completed' }, fallbackMessage: 'x',
      });
    });
    // A socket echo (or any other writer) moves the row on to a third value
    // before the failure lands.
    await act(async () => {
      await result.current.mutate(
        (current) => applyPatch(current, 't1', { status: 'blocked' }),
        { revalidate: false },
      );
    });
    await failing;

    assert({
      given: 'a row already moved on by the time the write failed',
      should: 'leave the newer value in place',
      actual: statuses(result.current.data),
      expected: ['blocked', 'pending'],
    });
  });

  it('keeps an in-flight write when a sub-task count lands on the same cache', async () => {
    // The counter patch is a plain functional mutate issued from a nested row
    // when one of its sub-tasks settles. Against the optimistic path it both
    // reverted the in-flight write's paint and cancelled its commit.
    patchMock.mockImplementation((url: string) => deferFor(url.split('/').pop()!));
    const { result } = renderHook(useHarness, { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    let done: Promise<boolean> | undefined;
    await act(async () => {
      done = result.current.writer.writeTaskField({
        loc: { listPageId: 'p', taskId: 't1' }, body: { status: 'completed' },
        optimistic: { status: 'completed' }, fallbackMessage: 'x',
      });
      await Promise.resolve();
    });

    const { applySubTaskCountsToPages } = await import('../task-cache-core');
    await act(async () => {
      // The same call shape TaskRowGroup's onCountDelta uses.
      await result.current.mutate(
        (current) => applySubTaskCountsToPages(current, 't2', { total: 1 }),
        { revalidate: false },
      );
    });

    await settle('t1', { status: 'completed', completedAt: '2026-02-01T00:00:00.000Z', updatedAt: 'a' });
    await act(async () => { await done; });

    assert({
      given: 'a counter patch landing while a checkbox write is in flight',
      should: 'keep the write and the counter',
      actual: {
        statuses: statuses(result.current.data),
        counts: result.current.data?.[0].tasks.map((t) => t.subTaskCount),
      },
      expected: { statuses: ['completed', 'pending'], counts: [undefined, 1] },
    });
  });
});
