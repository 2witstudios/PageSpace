/**
 * useAgentTerminals — optimistic kill/remove tests (pane-close orphan fix).
 *
 * The sidebar's "unclaimed session" rows are a set-difference between the
 * server session list (this hook's SWR cache) and the workspace store's panes.
 * A pane close mutates the store synchronously, so the session row must leave
 * this cache in the SAME tick — anything slower resurfaces the session as an
 * orphan row for at least a frame, and forever if the round-trip fails
 * silently. These tests pin the whole contract: synchronous optimistic
 * removal, 404-as-success, and rollback (the row IS the fallback) on genuine
 * failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { assert } from './riteway';

const { mockFetchWithAuth, mockPost } = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
  post: mockPost,
  del: vi.fn(),
}));

import {
  useAgentTerminals,
  killAgentTerminal,
  withoutSession,
  killMutateOptions,
  type AgentTerminal,
} from '../useAgentTerminals';

const row = (name: string): AgentTerminal => ({
  id: `id-${name}`,
  name,
  agentType: 'shell',
  createdAt: '2026-07-21T00:00:00.000Z',
});

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** GET list responses resolve immediately; DELETE is routed to `onDelete`. */
function routeFetch(list: AgentTerminal[], onDelete: () => Promise<unknown>) {
  mockFetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return onDelete();
    return Promise.resolve(jsonResponse({ agentTerminals: list }));
  });
}

/** A DELETE the test resolves by hand, to freeze the in-flight window. */
function deferredDelete() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('withoutSession (pure)', () => {
  it('filters the named row and keeps the rest, without mutating its input', () => {
    const list = { agentTerminals: [row('shell-a'), row('shell-b')] };
    const result = withoutSession('shell-a')(list);

    assert({
      given: 'a cached list holding the named row',
      should: 'return a list without it, other rows untouched',
      actual: result,
      expected: { agentTerminals: [row('shell-b')] },
    });
    assert({
      given: 'the same input list after the call',
      should: 'be unmodified (pure — no in-place mutation)',
      actual: list,
      expected: { agentTerminals: [row('shell-a'), row('shell-b')] },
    });
  });

  it('passes undefined cache data through unchanged', () => {
    assert({
      given: 'an unpopulated cache (undefined)',
      should: 'return it unchanged rather than fabricate a list',
      actual: withoutSession('shell-a')(undefined),
      expected: undefined,
    });
  });
});

describe('killMutateOptions (pure)', () => {
  it('filters DISPLAYED data optimistically, so concurrent kills stay hidden', () => {
    // Two concurrent kills on one key: kill A's committedData snapshot still
    // holds row B (taken before B's optimistic update landed). Filtering the
    // DISPLAYED data — which already lost B — is what keeps B from
    // resurfacing for a frame while A settles.
    const committed = { agentTerminals: [row('shell-a'), row('shell-b')] };
    const displayed = { agentTerminals: [row('shell-a')] }; // B already optimistically gone

    assert({
      given: 'a concurrent kill already hid another row from displayed data',
      should: 'filter the displayed data, not resurrect the committed snapshot',
      actual: killMutateOptions('key-pure', 'shell-a').optimisticData(committed, displayed),
      expected: { agentTerminals: [] },
    });
  });

  it('commits the filtered committed snapshot via populateCache', () => {
    const committed = { agentTerminals: [row('shell-a'), row('shell-b')] };

    assert({
      given: 'a settled DELETE and the committed snapshot',
      should: 'commit the snapshot minus the killed row',
      actual: killMutateOptions('key-pure', 'shell-a').populateCache(undefined, committed),
      expected: { agentTerminals: [row('shell-b')] },
    });
  });

  it('rolls back on error and reconciles via detached revalidation', () => {
    const options = killMutateOptions('key-pure', 'shell-a');

    assert({
      given: 'a kill mutation',
      should: 'restore the row on failure — the unclaimed row IS the fallback',
      actual: options.rollbackOnError,
      expected: true,
    });
    assert({
      given: 'a kill mutation',
      should: 'revalidate after settling (detached — cannot reject the call)',
      actual: options.revalidate,
      expected: true,
    });
  });
});

describe('killAgentTerminal', () => {
  it('removes the row from the cache before the DELETE resolves', async () => {
    const machineId = 'm-kill-optimistic';
    const deferred = deferredDelete();
    routeFetch([row('shell-a'), row('shell-b')], () => deferred.promise as Promise<never>);

    const { result } = renderHook(() => useAgentTerminals(machineId, 'proj', 'main'));
    await waitFor(() => expect(result.current.agentTerminals).toHaveLength(2));

    let killed!: Promise<void>;
    act(() => {
      killed = killAgentTerminal(machineId, { projectName: 'proj', branchName: 'main', name: 'shell-a' });
    });

    assert({
      given: 'a kill whose DELETE is still in flight',
      should: 'have already dropped the row (same tick as the pane close)',
      actual: result.current.agentTerminals.map((t) => t.name),
      expected: ['shell-b'],
    });

    // Settle: DELETE succeeds, row stays gone.
    routeFetch([row('shell-b')], () => Promise.resolve(jsonResponse(null)));
    await act(async () => {
      deferred.resolve(jsonResponse(null));
      await killed;
    });
    assert({
      given: 'the DELETE succeeding',
      should: 'keep the row gone',
      actual: result.current.agentTerminals.map((t) => t.name),
      expected: ['shell-b'],
    });
  });

  it('treats 404 as success — the session is already gone server-side', async () => {
    const machineId = 'm-kill-404';
    routeFetch([row('shell-a')], () => Promise.resolve(jsonResponse({ error: 'not_found' }, 404)));

    const { result } = renderHook(() => useAgentTerminals(machineId, 'proj', 'main'));
    await waitFor(() => expect(result.current.agentTerminals).toHaveLength(1));

    routeFetch([], () => Promise.resolve(jsonResponse({ error: 'not_found' }, 404)));
    await act(async () => {
      await killAgentTerminal(machineId, { projectName: 'proj', branchName: 'main', name: 'shell-a' });
    });

    assert({
      given: 'a DELETE answering 404',
      should: 'resolve and keep the row removed (goal state reached)',
      actual: result.current.agentTerminals,
      expected: [],
    });
  });

  it('rolls the row back and rethrows when the DELETE genuinely fails', async () => {
    const machineId = 'm-kill-rollback';
    routeFetch([row('shell-a')], () => Promise.resolve(jsonResponse({ error: 'sprite unreachable' }, 500)));

    const { result } = renderHook(() => useAgentTerminals(machineId, 'proj', 'main'));
    await waitFor(() => expect(result.current.agentTerminals).toHaveLength(1));

    let error: Error | null = null;
    await act(async () => {
      await killAgentTerminal(machineId, { projectName: 'proj', branchName: 'main', name: 'shell-a' }).catch(
        (err: Error) => {
          error = err;
        },
      );
    });

    assert({
      given: 'a DELETE failing 5xx',
      should: 'rethrow the server error (agent may still be running and billing)',
      actual: (error as Error | null)?.message,
      expected: 'sprite unreachable',
    });
    await waitFor(() => {
      assert({
        given: 'the failed kill',
        should: 'restore the row — still reachable, still removable',
        actual: result.current.agentTerminals.map((t) => t.name),
        expected: ['shell-a'],
      });
    });
  });
});

describe('removeAgentTerminal', () => {
  it('removes optimistically and stays removed on 404', async () => {
    const machineId = 'm-remove-404';
    const deferred = deferredDelete();
    routeFetch([row('shell-a')], () => deferred.promise as Promise<never>);

    const { result } = renderHook(() => useAgentTerminals(machineId, 'proj', 'main'));
    await waitFor(() => expect(result.current.agentTerminals).toHaveLength(1));

    let removed!: Promise<void>;
    act(() => {
      removed = result.current.removeAgentTerminal('shell-a');
    });
    assert({
      given: 'a removal whose DELETE is still in flight',
      should: 'have already dropped the row from this hook instance',
      actual: result.current.agentTerminals,
      expected: [],
    });

    // A row already dead server-side must still be removable — del()'s old
    // throw-on-404 made these rows permanently stuck with an error toast.
    routeFetch([], () => Promise.resolve(jsonResponse({ error: 'not_found' }, 404)));
    await act(async () => {
      deferred.resolve(jsonResponse({ error: 'not_found' }, 404));
      await removed;
    });
    assert({
      given: 'the DELETE answering 404',
      should: 'resolve with the row still gone',
      actual: result.current.agentTerminals,
      expected: [],
    });
  });

  it('rolls back and rethrows on genuine failure', async () => {
    const machineId = 'm-remove-rollback';
    routeFetch([row('shell-a')], () => Promise.resolve(jsonResponse({ error: 'kill failed' }, 500)));

    const { result } = renderHook(() => useAgentTerminals(machineId, 'proj', 'main'));
    await waitFor(() => expect(result.current.agentTerminals).toHaveLength(1));

    let error: Error | null = null;
    await act(async () => {
      await result.current.removeAgentTerminal('shell-a').catch((err: Error) => {
        error = err;
      });
    });

    assert({
      given: 'a DELETE failing 5xx',
      should: 'rethrow so the caller can toast',
      actual: (error as Error | null)?.message,
      expected: 'kill failed',
    });
    await waitFor(() => {
      assert({
        given: 'the failed removal',
        should: 'restore the row',
        actual: result.current.agentTerminals.map((t) => t.name),
        expected: ['shell-a'],
      });
    });
  });
});

describe('concurrent kills on one key', () => {
  it('never resurrects an already-killed sibling row when settles arrive out of order and revalidation is delayed', async () => {
    // The Codex-flagged race: SWR hands each settle the ORIGINAL committed
    // snapshot (`_c`, captured before any optimistic update), so the
    // latest-started kill's populateCache would write the FIRST kill's row
    // back into the cache. With revalidation delayed (here: hung), that
    // resurrected row is not a flash — it's an orphan listing again.
    const machineId = 'm-kill-out-of-order';
    const first = deferredDelete();
    const second = deferredDelete();
    const deletes = [first, second];
    let loaded = false;
    mockFetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return deletes.shift()!.promise as Promise<never>;
      if (!loaded) {
        loaded = true;
        return Promise.resolve(jsonResponse({ agentTerminals: [row('shell-a'), row('shell-b')] }));
      }
      // Every revalidation after the initial load HANGS — the cache's own
      // committed state must be correct without the detached repair.
      return new Promise(() => {});
    });

    const { result } = renderHook(() => useAgentTerminals(machineId, 'proj', 'main'));
    await waitFor(() => expect(result.current.agentTerminals).toHaveLength(2));

    let killA!: Promise<void>;
    let killB!: Promise<void>;
    act(() => {
      killA = killAgentTerminal(machineId, { projectName: 'proj', branchName: 'main', name: 'shell-a' });
      killB = killAgentTerminal(machineId, { projectName: 'proj', branchName: 'main', name: 'shell-b' });
    });

    // B (the latest-started mutation, the one whose populateCache SWR will
    // honor) settles FIRST; A settles after.
    await act(async () => {
      second.resolve(jsonResponse(null));
      await killB;
    });
    await act(async () => {
      first.resolve(jsonResponse(null));
      await killA;
    });

    assert({
      given: 'two concurrent kills whose DELETEs settle out of order, with revalidation hung',
      should: 'commit a cache containing NEITHER row — no settle may resurrect the other kill from its stale committed snapshot',
      actual: result.current.agentTerminals,
      expected: [],
    });
  });

  it('hides both rows in flight and keeps both gone after settling', async () => {
    const machineId = 'm-kill-concurrent';
    const first = deferredDelete();
    const second = deferredDelete();
    const deletes = [first, second];
    mockFetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return deletes.shift()!.promise as Promise<never>;
      return Promise.resolve(jsonResponse({ agentTerminals: [row('shell-a'), row('shell-b')] }));
    });

    const { result } = renderHook(() => useAgentTerminals(machineId, 'proj', 'main'));
    await waitFor(() => expect(result.current.agentTerminals).toHaveLength(2));

    let killA!: Promise<void>;
    let killB!: Promise<void>;
    act(() => {
      killA = killAgentTerminal(machineId, { projectName: 'proj', branchName: 'main', name: 'shell-a' });
      killB = killAgentTerminal(machineId, { projectName: 'proj', branchName: 'main', name: 'shell-b' });
    });

    assert({
      given: 'two kills in flight on the same key (workspace removal)',
      should: 'hide both rows — neither kill resurrects the other',
      actual: result.current.agentTerminals,
      expected: [],
    });

    mockFetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.resolve(jsonResponse(null));
      return Promise.resolve(jsonResponse({ agentTerminals: [] }));
    });
    await act(async () => {
      first.resolve(jsonResponse(null));
      second.resolve(jsonResponse(null));
      await Promise.all([killA, killB]);
    });
    assert({
      given: 'both DELETEs succeeding',
      should: 'keep both rows gone',
      actual: result.current.agentTerminals,
      expected: [],
    });
  });
});
