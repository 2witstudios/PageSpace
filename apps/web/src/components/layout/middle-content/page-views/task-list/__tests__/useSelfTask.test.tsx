/**
 * The header's own task row.
 *
 * Covered here because the interaction it participates in — the shared write
 * machinery — is the one place a defect has repeatedly hidden, and an e2e can
 * only see the outcome, not which path produced it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';
import { assert } from '@/hooks/__tests__/riteway';

const fetchWithAuth = vi.fn();
const patchMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  patch: (...a: unknown[]) => patchMock(...a),
}));
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastErrorMock(...a) } }));

const { useSelfTask } = await import('../useSelfTask');
const { useTaskWriteMachinery } = await import('@/lib/tasks/task-write-machinery');

const CONFIGS = [
  { id: 'c1', taskListId: 'l', name: 'To Do', slug: 'pending', color: 'x', group: 'todo' as const, position: 0 },
  { id: 'c2', taskListId: 'l', name: 'Done', slug: 'completed', color: 'x', group: 'done' as const, position: 1 },
];

const response = (over: Record<string, unknown> = {}) => ({
  ok: true,
  json: async () => ({
    listPageId: 'parent-page',
    statusConfigs: CONFIGS,
    task: {
      id: 'self-1', status: 'pending', priority: 'medium', completedAt: null,
      dueDate: null, updatedAt: 'u0', subTaskCount: 0, subTaskCompletedCount: 0,
      ...over,
    },
  }),
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

const setup = (revalidateAll = vi.fn()) =>
  renderHook(() => {
    const machinery = useTaskWriteMachinery('user-me', revalidateAll);
    return { machinery, self: useSelfTask('page-1', true, machinery) };
  }, { wrapper });

beforeEach(() => {
  fetchWithAuth.mockReset();
  patchMock.mockReset();
  toastErrorMock.mockReset();
});

describe('useSelfTask', () => {
  it('addresses the PARENT list, not the page being viewed', async () => {
    // The task lives in its parent's list; PATCHing the viewed page 404s on the
    // route's parent-child check.
    fetchWithAuth.mockResolvedValue(response());
    patchMock.mockResolvedValue({ status: 'completed', completedAt: 'c', updatedAt: 'u1' });
    const view = setup();
    await waitFor(() => expect(view.result.current.self.isAvailable).toBe(true));

    await act(async () => { await view.result.current.self.toggleComplete(); });

    assert({
      given: 'completing the task from its own screen',
      should: "address the parent list's page",
      actual: patchMock.mock.calls[0][0],
      expected: '/api/pages/parent-page/tasks/self-1',
    });
  });

  it('shows the completion before the response, and undoes it locally on failure', async () => {
    // Both halves in one test because they are one mechanism: the header paints
    // through a synchronous mutate (see task-write-machinery's header for why
    // SWR's optimistic path cannot be used here), which means there is no
    // `rollbackOnError` to fall back on. If the local undo were dropped in
    // favour of a refetch, a failed click would leave a completion the server
    // never accepted sitting on screen — and on a paused cache, forever.
    fetchWithAuth.mockResolvedValue(response());
    let reject: (e: unknown) => void = () => {};
    patchMock.mockReturnValue(new Promise((_, r) => { reject = r; }));
    const view = setup();
    await waitFor(() => expect(view.result.current.self.isAvailable).toBe(true));

    // From here the refetch can never answer. Without that, a refetch that
    // happens to return the original row repairs the display on its own and
    // the test passes whether or not the LOCAL undo exists — which is exactly
    // the situation production is not in when the cache is paused.
    fetchWithAuth.mockReturnValue(new Promise(() => {}));

    let pending: Promise<void>;
    await act(async () => {
      pending = view.result.current.self.toggleComplete();
      await Promise.resolve();
    });
    const whileInFlight = view.result.current.self.isCompleted;

    await act(async () => {
      reject(Object.assign(new Error('nope'), { status: 500, body: {} }));
      await pending!;
    });

    assert({
      given: 'a header completion whose PATCH then failed',
      should: 'have shown it immediately, then put the row back',
      actual: {
        whileInFlight,
        after: view.result.current.self.isCompleted,
        status: view.result.current.self.task?.status,
        completedAt: view.result.current.self.task?.completedAt,
      },
      expected: { whileInFlight: true, after: false, status: 'pending', completedAt: null },
    });
  });

  it('registers the write, so its own echo costs no revalidation', async () => {
    fetchWithAuth.mockResolvedValue(response());
    patchMock.mockResolvedValue({ status: 'completed', completedAt: 'c', updatedAt: 'stamp-1' });
    const revalidateAll = vi.fn();
    const view = setup(revalidateAll);
    await waitFor(() => expect(view.result.current.self.isAvailable).toBe(true));

    await act(async () => { await view.result.current.self.toggleComplete(); });

    assert({
      given: "the socket echo of the header's own write",
      should: 'be recognised as ours rather than triggering a list refetch',
      actual: view.result.current.machinery.shouldRevalidateForEvent({
        taskId: 'self-1', userId: 'user-me', data: { updatedAt: 'stamp-1' },
      }),
      expected: false,
    });
  });

  it('refuses a done status while sub-tasks are open, without writing', async () => {
    fetchWithAuth.mockResolvedValue(response({ subTaskCount: 2, subTaskCompletedCount: 1 }));
    const view = setup();
    await waitFor(() => expect(view.result.current.self.isAvailable).toBe(true));

    await act(async () => { await view.result.current.self.setStatus('completed'); });

    assert({
      given: 'a done status selected while one sub-task is still open',
      should: 'block before the request and say how many remain',
      actual: [patchMock.mock.calls.length, toastErrorMock.mock.calls[0]?.[0]],
      expected: [0, 'Finish 1 sub-task first'],
    });
  });

  it('allows a move between open statuses even with sub-tasks outstanding', async () => {
    fetchWithAuth.mockResolvedValue(response({
      subTaskCount: 2, subTaskCompletedCount: 0, status: 'pending',
    }));
    patchMock.mockResolvedValue({ status: 'pending', completedAt: null, updatedAt: 'u1' });
    const view = setup();
    await waitFor(() => expect(view.result.current.self.isAvailable).toBe(true));

    await act(async () => { await view.result.current.self.setStatus('pending'); });

    assert({
      given: 'a non-completing status change with sub-tasks open',
      should: 'go through',
      actual: patchMock.mock.calls.length,
      expected: 1,
    });
  });

  it('surfaces the server message when the write is refused', async () => {
    fetchWithAuth.mockResolvedValue(response());
    patchMock.mockRejectedValue(Object.assign(new Error('x'), {
      status: 422,
      body: { code: 'SUBTASKS_INCOMPLETE', error: 'Complete all sub-tasks first (2 of 3 remaining)' },
    }));
    const view = setup();
    await waitFor(() => expect(view.result.current.self.isAvailable).toBe(true));

    await act(async () => { await view.result.current.self.toggleComplete(); });

    assert({
      given: 'a 422 from the server guard',
      should: 'show its message rather than a generic failure',
      actual: toastErrorMock.mock.calls[0][0],
      expected: 'Complete all sub-tasks first (2 of 3 remaining)',
    });
  });

  it('refreshes when another writer flushes a foreign echo', async () => {
    // The header's key is its own cache. The machinery's revalidation covers the
    // list, not this — so without registering a refresher, a concurrent edit to
    // this task made while some other write was in flight never reaches it.
    // That registration is now the ONLY path, since the direct fallback went.
    fetchWithAuth.mockResolvedValue(response());
    const view = setup();
    await waitFor(() => expect(view.result.current.self.isAvailable).toBe(true));
    const before = fetchWithAuth.mock.calls.length;

    // Some other writer opens a write; a foreign echo lands mid-flight.
    const writeId = view.result.current.machinery.noteSelfWriteStart('other-task');
    view.result.current.machinery.shouldRevalidateForEvent({
      taskId: 'other-task', userId: 'user-me', data: { updatedAt: 'not-ours' },
    });
    // ...and that writer settles, performing the flush.
    await act(async () => {
      view.result.current.machinery.noteSelfWriteSettled(writeId, 'their-stamp');
      view.result.current.machinery.flushDeferredRevalidate();
    });

    await waitFor(() => expect(fetchWithAuth.mock.calls.length).toBeGreaterThan(before));
    assert({
      given: 'a foreign echo flushed by a different writer',
      should: "re-read the header's own key",
      actual: fetchWithAuth.mock.calls.length > before,
      expected: true,
    });
  });

  it('reports nothing for a page that is not a task', async () => {
    fetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ task: null, listPageId: null, statusConfigs: [] }),
    });
    const view = setup();
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());

    assert({
      given: 'a top-level list, which is nobody\'s sub-task',
      should: 'be unavailable so the header renders nothing',
      actual: [view.result.current.self.isAvailable, view.result.current.self.task],
      expected: [false, null],
    });
  });
});
