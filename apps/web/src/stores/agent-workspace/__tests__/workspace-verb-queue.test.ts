/**
 * The QUEUE PROTOCOL — the contract that replaced the blob era's debounced
 * PUT, its two hydration latches, and its localStorage copy of the grid.
 *
 * Everything here is about one invariant: whatever the server says, and in
 * whatever order it says it, the client converges on the server's grid with
 * its own unacked work replayed on top — and never double-applies anything.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PaneScope, PersistedColumnState } from '@pagespace/lib/agent-sessions/contract';
import { useAgentWorkspaceStore, __resetWorkspaceQueuesForTests } from '../useAgentWorkspaceStore';
import { panesOf } from '../pane-reducer';

const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

const store = () => useAgentWorkspaceStore.getState();
const grid = (id = 'ses-1') => store().workspaces[id];
const sync = (id = 'ses-1') => store().sync[id];

const scope = (name = 'Planning', targetId = 'conv-1'): PaneScope => ({
  kind: 'chat',
  name,
  targetId,
  agentPageId: 'agent-1',
});

/** A minimal `Response` stand-in — only the three members the store reads. */
function reply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Every verb POST body the store has sent, in order. */
function postedVerbs(): Array<{ opId: string; baseRev: number; verb: { type: string } }> {
  return mockFetchWithAuth.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

/** A one-column, one-pane grid as the wire carries it. */
function wireGrid(paneId: string, paneScope: PaneScope | null, columnId = 'col-server'): PersistedColumnState[] {
  return [{ id: columnId, panes: [{ id: paneId, scope: paneScope }] }];
}

/** Let the microtask queue drain so an in-flight POST settles. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  mockFetchWithAuth.mockReset();
  __resetWorkspaceQueuesForTests();
  useAgentWorkspaceStore.setState({ workspaces: {}, sync: {}, focus: {} });
});

describe('optimistic apply + eager POST', () => {
  it('renders the mutation immediately and posts exactly one verb for it', async () => {
    mockFetchWithAuth.mockImplementation(() => new Promise<Response>(() => {}));

    store().ensureWorkspace('ses-1', scope());

    // Rendered before anything crossed the wire — that is the whole point.
    expect(panesOf(grid())).toHaveLength(1);
    expect(postedVerbs()).toHaveLength(1);
    expect(postedVerbs()[0].verb.type).toBe('ensure');
    expect(sync().pending).toHaveLength(1);
  });

  it('posts strictly one at a time, in order', async () => {
    mockFetchWithAuth.mockImplementation(() => new Promise<Response>(() => {}));

    store().ensureWorkspace('ses-1', scope());
    store().splitRight('ses-1', grid().activePaneId);
    store().splitDown('ses-1', grid().activePaneId);

    // Three verbs queued, one on the wire: op N's baseRev is unknowable until
    // op N-1 is answered.
    expect(sync().pending.map((op) => op.verb.type)).toEqual(['ensure', 'split_right', 'split_down']);
    expect(postedVerbs()).toHaveLength(1);
  });

  it('never posts a verb the reducer declined', () => {
    mockFetchWithAuth.mockImplementation(() => new Promise<Response>(() => {}));

    store().ensureWorkspace('ses-1', scope());
    // A second `ensure` on an existing grid is a structural no-op — there is
    // nothing for the server to converge on.
    store().ensureWorkspace('ses-1', scope());

    expect(postedVerbs()).toHaveLength(1);
  });

  it('sends no verb for focus — activePaneId is client-local, not a row', () => {
    mockFetchWithAuth.mockImplementation(() => new Promise<Response>(() => {}));

    store().ensureWorkspace('ses-1', scope());
    store().splitRight('ses-1', grid().activePaneId);
    const before = postedVerbs().length;

    store().selectPane('ses-1', panesOf(grid())[0].id);
    store().dismissPicker('ses-1', grid().pendingPickerPaneId ?? 'none');

    expect(postedVerbs()).toHaveLength(before);
    expect(grid().activePaneId).toBe(panesOf(grid())[0].id);
  });

  it('resolves openConversation into a PRIMITIVE verb, never the server policy verb', async () => {
    // The client-only guards (dirty panes, #2295's live set, the excluded
    // invoker) live here and nowhere else, so what crosses the wire must be
    // the decision, not the policy.
    mockFetchWithAuth.mockImplementation(() => new Promise<Response>(() => {}));

    store().ensureWorkspace('ses-1', scope());
    store().openConversation('ses-1', scope('Other', 'conv-2'));

    expect(sync().pending.map((op) => op.verb.type)).toEqual(['ensure', 'assign_pane']);
  });

  it('resolves an unreplaceable open into split_right + assign_pane, in that order', () => {
    mockFetchWithAuth.mockImplementation(() => new Promise<Response>(() => {}));

    store().ensureWorkspace('ses-1', scope());
    store().openConversation('ses-1', scope('Other', 'conv-2'), { liveConversationIds: new Set(['conv-2']) });

    expect(sync().pending.map((op) => op.verb.type)).toEqual(['ensure', 'split_right', 'assign_pane']);
  });
});

describe('200 — adopting the ack', () => {
  it('drops the op, adopts the returned rev and grid, and sends the next one', async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(reply(200, { rev: 4, grid: wireGrid('pane-server', scope()), applied: true }))
      .mockImplementation(() => new Promise<Response>(() => {}));

    store().ensureWorkspace('ses-1', scope());
    store().splitRight('ses-1', grid().activePaneId);
    await settled();

    expect(sync().rev).toBe(4);
    expect(sync().pending.map((op) => op.verb.type)).toEqual(['split_right']);
    // The second POST rebases on the rev the first one taught us.
    expect(postedVerbs()[1].baseRev).toBe(4);
  });

  it('adopts the rev even when the server reports applied: false', async () => {
    // A no-op still reports the CURRENT rev. Refusing it would strand the
    // client one rev behind forever and 409 on everything afterwards.
    mockFetchWithAuth.mockResolvedValue(
      reply(200, { rev: 9, grid: wireGrid('pane-server', scope()), applied: false }),
    );

    store().ensureWorkspace('ses-1', scope());
    await settled();

    expect(sync().rev).toBe(9);
    expect(sync().pending).toHaveLength(0);
  });

  it('replays the still-unacked verbs on top of the adopted grid', async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(reply(200, { rev: 1, grid: wireGrid('pane-server', scope()), applied: true }))
      .mockImplementation(() => new Promise<Response>(() => {}));

    store().ensureWorkspace('ses-1', scope());
    const splitFrom = grid().activePaneId;
    store().splitRight('ses-1', splitFrom);
    // The split targets the LOCALLY minted pane, which the server's grid
    // does not contain — so after adoption it no longer resolves and the
    // replay is a no-op. That is correct convergence, not a lost edit: the
    // op is still queued and its own POST will answer for it.
    await settled();

    expect(sync().rev).toBe(1);
    expect(panesOf(grid()).some((pane) => pane.id === 'pane-server')).toBe(true);
  });
});

describe('409 — the body is the truth to rebase against', () => {
  it('adopts the returned snapshot, keeps the rejected op queued, and re-posts it at the new rev', async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(reply(409, { rev: 7, grid: wireGrid('pane-server', scope()) }))
      .mockResolvedValueOnce(reply(200, { rev: 8, grid: wireGrid('pane-server', scope('Renamed')), applied: true }))
      .mockImplementation(() => new Promise<Response>(() => {}));

    store().assignPane('ses-1', 'pane-server', scope('Renamed'));
    // Nothing local yet — an assign against a grid the store has not seen is
    // declined, so seed a snapshot first and then mutate.
    store().hydrateFromServer('ses-1', { rev: 0, grid: wireGrid('pane-server', scope()) });
    store().assignPane('ses-1', 'pane-server', scope('Renamed'));

    await settled();
    await settled();

    expect(sync().rev).toBe(8);
    expect(sync().pending).toHaveLength(0);
    const retried = postedVerbs();
    expect(retried).toHaveLength(2);
    expect(retried[0].baseRev).toBe(0);
    expect(retried[1].baseRev).toBe(7);
    // Same op, same key — a rebase is not a new operation.
    expect(retried[1].opId).toBe(retried[0].opId);
  });

  it('converges on the server grid with the local edit reapplied on top', async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(reply(409, { rev: 3, grid: wireGrid('pane-a', scope('Server', 'conv-server')) }))
      .mockImplementation(() => new Promise<Response>(() => {}));

    store().hydrateFromServer('ses-1', { rev: 0, grid: wireGrid('pane-a', scope()) });
    store().assignPane('ses-1', 'pane-a', scope('Mine', 'conv-mine'));
    await settled();

    // The server's structure won; the unacked assign is still on top of it.
    expect(sync().rev).toBe(3);
    expect(panesOf(grid())).toHaveLength(1);
    expect(panesOf(grid())[0].scope?.targetId).toBe('conv-mine');
  });
});

describe('workspace:updated — live adoption', () => {
  beforeEach(() => {
    mockFetchWithAuth.mockImplementation(() => new Promise<Response>(() => {}));
    store().hydrateFromServer('ses-1', { rev: 5, grid: wireGrid('pane-a', scope()) });
  });

  it('adopts a newer rev', () => {
    store().applyRemoteUpdate({
      workspaceId: 'ses-1',
      rev: 6,
      opId: 'someone-else',
      grid: [
        { id: 'col-server', panes: [{ id: 'pane-a', scope: scope() }] },
        { id: 'col-2', panes: [{ id: 'pane-b', scope: scope('Second', 'conv-2') }] },
      ],
    });

    expect(sync().rev).toBe(6);
    expect(panesOf(grid())).toHaveLength(2);
  });

  it('drops an event at or below the rev already known', () => {
    store().applyRemoteUpdate({
      workspaceId: 'ses-1',
      rev: 5,
      opId: 'stale',
      grid: wireGrid('pane-zzz', scope('Stale', 'conv-stale')),
    });

    expect(panesOf(grid())[0].id).toBe('pane-a');
  });

  it('no-ops on our OWN in-flight op — the POST answer is the authoritative one', () => {
    store().splitRight('ses-1', 'pane-a');
    const ownOpId = sync().pending[0].opId;

    store().applyRemoteUpdate({
      workspaceId: 'ses-1',
      rev: 6,
      opId: ownOpId,
      grid: [
        { id: 'col-server', panes: [{ id: 'pane-a', scope: scope() }] },
        { id: 'col-echo', panes: [{ id: 'pane-echo', scope: null }] },
      ],
    });

    // Adopting the echo would have replayed our still-queued split on a grid
    // that already contains it — two columns from one split.
    expect(sync().rev).toBe(5);
    expect(grid().columns).toHaveLength(2);
    expect(sync().pending).toHaveLength(1);
  });

  it('ignores an event for a session the store is not tracking', () => {
    store().applyRemoteUpdate({
      workspaceId: 'ses-unknown',
      rev: 1,
      opId: null,
      grid: wireGrid('pane-x', scope()),
    });

    expect(store().workspaces['ses-unknown']).toBeUndefined();
    expect(store().sync['ses-unknown']).toBeUndefined();
  });

  it('never steals focus: a remote structural change leaves the active pane alone', () => {
    store().applyRemoteUpdate({
      workspaceId: 'ses-1',
      rev: 6,
      opId: 'someone-else',
      grid: [
        { id: 'col-server', panes: [{ id: 'pane-a', scope: scope() }] },
        { id: 'col-2', panes: [{ id: 'pane-b', scope: scope('Second', 'conv-2') }] },
      ],
    });

    expect(grid().activePaneId).toBe('pane-a');
  });
});

describe('hydration', () => {
  it('mount GET seats the snapshot and its rev', async () => {
    mockFetchWithAuth.mockResolvedValue(reply(200, { rev: 12, grid: wireGrid('pane-a', scope()), workspace: null }));

    await store().refreshWorkspaceSnapshot('ses-1');

    expect(sync().rev).toBe(12);
    expect(panesOf(grid())[0].id).toBe('pane-a');
  });

  it('a snapshot OLDER than what we hold is ignored', () => {
    mockFetchWithAuth.mockImplementation(() => new Promise<Response>(() => {}));
    store().hydrateFromServer('ses-1', { rev: 5, grid: wireGrid('pane-a', scope()) });

    store().hydrateFromServer('ses-1', { rev: 2, grid: wireGrid('pane-old', scope()) });

    expect(sync().rev).toBe(5);
    expect(panesOf(grid())[0].id).toBe('pane-a');
  });

  it('a local seed racing the fetch is replayed on top rather than dropped — no latch needed', async () => {
    // The exact race `hydratedSessionsThisPageLoad` +
    // `adoptServerWorkspaceAsHydrated` existed to arbitrate: the caller seeds
    // a grid in the same commit the snapshot fetch starts in.
    mockFetchWithAuth.mockImplementation(() => new Promise<Response>(() => {}));
    store().ensureWorkspace('ses-1', scope());
    expect(sync().pending).toHaveLength(1);

    store().hydrateFromServer('ses-1', { rev: 5, grid: wireGrid('pane-a', scope('Saved', 'conv-saved')) });

    // Server structure adopted; the seed's own verb survives as a queued op
    // (it will 409-rebase and then no-op, since the grid now exists).
    expect(sync().rev).toBe(5);
    expect(sync().pending).toHaveLength(1);
    expect(panesOf(grid())[0].id).toBe('pane-a');
  });

  it('hydrateWorkspace clears the queue and orphans anything in flight', async () => {
    let resolveFirst: ((value: Response) => void) | undefined;
    mockFetchWithAuth.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolveFirst = resolve; }),
    );

    store().ensureWorkspace('ses-1', scope());
    store().hydrateWorkspace('ses-1', {
      id: 'ses-1',
      columns: wireGrid('pane-rollback', scope('Rolled back')),
      activePaneId: 'pane-rollback',
      pendingPickerPaneId: null,
    });
    expect(sync().pending).toHaveLength(0);

    // The orphaned POST answers late — it must not resurrect the grid it
    // belonged to.
    resolveFirst?.(reply(200, { rev: 99, grid: wireGrid('pane-zombie', scope()), applied: true }));
    await settled();

    expect(panesOf(grid())[0].id).toBe('pane-rollback');
  });
});

describe('give-up', () => {
  it('abandons the queue and re-reads the server after repeated transport failures', async () => {
    vi.useFakeTimers();
    try {
      mockFetchWithAuth.mockImplementation((_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? Promise.reject(new Error('offline'))
          : Promise.resolve(reply(200, { rev: 3, grid: wireGrid('pane-truth', scope()) })),
      );

      store().hydrateFromServer('ses-1', { rev: 0, grid: wireGrid('pane-a', scope()) });
      store().assignPane('ses-1', 'pane-a', scope('Mine', 'conv-mine'));

      for (let i = 0; i < 8; i += 1) {
        await vi.advanceTimersByTimeAsync(6000);
      }

      expect(sync().pending).toHaveLength(0);
      expect(sync().rev).toBe(3);
      expect(panesOf(grid())[0].id).toBe('pane-truth');
    } finally {
      vi.useRealTimers();
    }
  });
});
