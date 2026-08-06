// @vitest-environment node
/**
 * `applyWorkspaceLayoutVerb` / `saveWorkspaceBlobReconciled` — the locked
 * read-reduce-write orchestration over the shared reducer. What matters
 * here: the opId replay short-circuit (a retried split must never re-insert
 * its pane id), the stale-baseRev truth-to-rebase answer, the content-diff
 * deciding `applied` and the broadcast, and the legacy PUT reconciling rows
 * through the same projection. The reducer itself and the store contract are
 * pinned in packages/lib; this suite runs both against the lib FAKE store to
 * test exactly the wiring in between.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PersistedWorkspaceState } from '@pagespace/lib/agent-sessions/contract';
import type { LayoutGridColumn } from '@pagespace/lib/agent-sessions/workspace-layout-verbs';
import type { WorkspaceLayoutStore } from '@pagespace/lib/services/agent-sessions/workspace-layout-store';

/**
 * In-memory stand-in honoring the store contract pinned by packages/lib's
 * own fake-backed suite (the lib fake lives under `__tests__/`, which never
 * ships in dist — hence this local twin rather than an import).
 */
function createFakeWorkspaceLayoutStore(): WorkspaceLayoutStore & { blobs: Map<string, PersistedWorkspaceState> } {
  const grids = new Map<string, LayoutGridColumn[]>();
  const revs = new Map<string, number>();
  const blobs = new Map<string, PersistedWorkspaceState>();
  const ops = new Map<string, { rev: number; applied: boolean }>();
  return {
    blobs,
    async getWorkspaceGrid(workspaceId) {
      return structuredClone(grids.get(workspaceId) ?? []);
    },
    async getWorkspaceBlob(workspaceId) {
      const blob = blobs.get(workspaceId);
      return blob ? structuredClone(blob) : null;
    },
    async replaceWorkspaceGrid({ workspaceId, grid, workspaceState }) {
      const current = grids.get(workspaceId) ?? [];
      if (JSON.stringify(current) === JSON.stringify(grid)) {
        return { rev: revs.get(workspaceId) ?? 0, applied: false };
      }
      grids.set(workspaceId, structuredClone(grid));
      if (workspaceState) blobs.set(workspaceId, structuredClone(workspaceState));
      const next = (revs.get(workspaceId) ?? 0) + 1;
      revs.set(workspaceId, next);
      return { rev: next, applied: true };
    },
    async saveWorkspaceBlob(workspaceId, workspaceState) {
      blobs.set(workspaceId, structuredClone(workspaceState));
    },
    async currentRev(workspaceId) {
      return revs.get(workspaceId) ?? 0;
    },
    async findOp(workspaceId, opId) {
      return ops.get(`${workspaceId}::${opId}`) ?? null;
    },
    async recordOp({ workspaceId, opId, rev, applied }) {
      const key = `${workspaceId}::${opId}`;
      if (!ops.has(key)) ops.set(key, { rev, applied });
    },
  };
}

const { mockBroadcast, storeRef } = vi.hoisted(() => ({
  mockBroadcast: vi.fn(),
  storeRef: { current: null as unknown },
}));

vi.mock('@pagespace/lib/services/agent-sessions/workspace-layout-store', () => ({
  // The lock seam collapses to a passthrough here — lock semantics belong to
  // the real store's own integration surface, not this wiring test.
  withWorkspaceLayoutLock: async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
  createDbWorkspaceLayoutStore: async () => storeRef.current,
}));
vi.mock('@/lib/websocket/agent-workspace-events', () => ({
  broadcastWorkspaceUpdated: (...args: unknown[]) => mockBroadcast(...args),
}));
// The snapshot read's label joins pull the db module graph; this suite never
// exercises them (readWorkspaceLayoutSnapshot has its own callers/tests via
// the route), so stub the graph out entirely.
vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/db/operators', () => ({ inArray: vi.fn() }));
vi.mock('@pagespace/db/schema/conversations', () => ({ conversations: {} }));
vi.mock('@pagespace/db/schema/agent-sessions', () => ({ agentSessionShells: {} }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: {} }));

import { applyWorkspaceLayoutVerb, saveWorkspaceBlobReconciled } from '../workspace-layout-runtime';

const WORKSPACE_ID = 'ses-1';
const scope = { kind: 'chat' as const, name: 'Conversation', targetId: 'conv-1', agentPageId: null };

let store: ReturnType<typeof createFakeWorkspaceLayoutStore>;

beforeEach(() => {
  vi.clearAllMocks();
  store = createFakeWorkspaceLayoutStore();
  storeRef.current = store;
});

const ensure = (opId = 'op-ensure', baseRev = 0) =>
  applyWorkspaceLayoutVerb({
    workspaceId: WORKSPACE_ID,
    opId,
    baseRev,
    verb: { type: 'ensure', columnId: 'col-1', paneId: 'pane-1', scope },
  });

describe('applyWorkspaceLayoutVerb', () => {
  it('applies a verb, dual-writes rows + blob, and broadcasts the post-write rev', async () => {
    const result = await ensure();
    expect(result).toEqual({
      status: 'ok',
      rev: 1,
      applied: true,
      grid: [{ id: 'col-1', panes: [{ id: 'pane-1', scope }] }],
    });
    expect(await store.getWorkspaceGrid(WORKSPACE_ID)).toEqual([
      { id: 'col-1', panes: [{ id: 'pane-1', kind: 'chat', targetId: 'conv-1' }] },
    ]);
    expect(store.blobs.get(WORKSPACE_ID)?.activePaneId).toBe('pane-1');
    expect(mockBroadcast).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      rev: 1,
      verb: 'ensure',
      grid: [{ id: 'col-1', panes: [{ id: 'pane-1', scope }] }],
    });
  });

  it('replays an already-processed opId as a no-op with current truth — never re-applying', async () => {
    await ensure('op-1');
    const split = {
      type: 'split_right' as const,
      fromPaneId: 'pane-1',
      newColumnId: 'col-2',
      newPaneId: 'pane-2',
    };
    const first = await applyWorkspaceLayoutVerb({ workspaceId: WORKSPACE_ID, opId: 'op-2', baseRev: 1, verb: split });
    expect(first.status === 'ok' && first.applied).toBe(true);
    mockBroadcast.mockClear();

    // The retry: same opId, same (now stale) baseRev. It must short-circuit
    // on the op memory — NOT 409, NOT a second column — and not broadcast.
    const retry = await applyWorkspaceLayoutVerb({ workspaceId: WORKSPACE_ID, opId: 'op-2', baseRev: 1, verb: split });
    expect(retry.status).toBe('ok');
    expect(retry.status === 'ok' && retry.applied).toBe(false);
    expect(retry.rev).toBe(2);
    expect((await store.getWorkspaceGrid(WORKSPACE_ID)).length).toBe(2);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('answers a stale baseRev with the current rev + grid to rebase against', async () => {
    await ensure();
    mockBroadcast.mockClear();
    const result = await applyWorkspaceLayoutVerb({
      workspaceId: WORKSPACE_ID,
      opId: 'op-stale',
      baseRev: 0,
      verb: { type: 'split_down', fromPaneId: 'pane-1', newPaneId: 'pane-2' },
    });
    expect(result).toEqual({
      status: 'stale',
      rev: 1,
      grid: [{ id: 'col-1', panes: [{ id: 'pane-1', scope }] }],
    });
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('records a structural no-op (unresolvable target) without bumping rev or broadcasting', async () => {
    await ensure();
    mockBroadcast.mockClear();
    const result = await applyWorkspaceLayoutVerb({
      workspaceId: WORKSPACE_ID,
      opId: 'op-noop',
      baseRev: 1,
      verb: { type: 'close_pane', paneId: 'ghost' },
    });
    expect(result.status === 'ok' && result.applied).toBe(false);
    expect(result.rev).toBe(1);
    expect(mockBroadcast).not.toHaveBeenCalled();
    // The no-op is remembered: a replay with a now-different baseRev still
    // answers ok instead of 409.
    const replay = await applyWorkspaceLayoutVerb({
      workspaceId: WORKSPACE_ID,
      opId: 'op-noop',
      baseRev: 99,
      verb: { type: 'close_pane', paneId: 'ghost' },
    });
    expect(replay.status).toBe('ok');
  });
});

describe('saveWorkspaceBlobReconciled (legacy PUT shim)', () => {
  it('always writes the blob, reconciles rows through the shared projection, and broadcasts when rows changed', async () => {
    const workspace = {
      id: WORKSPACE_ID,
      columns: [{ id: 'col-1', panes: [{ id: 'pane-1', scope }] }],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    };
    await saveWorkspaceBlobReconciled({ workspaceId: WORKSPACE_ID, workspace });
    expect(store.blobs.get(WORKSPACE_ID)).toEqual(workspace);
    expect(await store.getWorkspaceGrid(WORKSPACE_ID)).toEqual([
      { id: 'col-1', panes: [{ id: 'pane-1', kind: 'chat', targetId: 'conv-1' }] },
    ]);
    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, rev: 1, verb: 'legacy_replace' }),
    );
  });

  it('a blob differing only in client-local view state still saves but neither bumps rev nor broadcasts', async () => {
    const workspace = {
      id: WORKSPACE_ID,
      columns: [
        { id: 'col-1', panes: [{ id: 'pane-1', scope }, { id: 'pane-2', scope: null }] },
      ],
      activePaneId: 'pane-1',
      pendingPickerPaneId: null,
    };
    await saveWorkspaceBlobReconciled({ workspaceId: WORKSPACE_ID, workspace });
    mockBroadcast.mockClear();

    const refocused = { ...workspace, activePaneId: 'pane-2' };
    await saveWorkspaceBlobReconciled({ workspaceId: WORKSPACE_ID, workspace: refocused });
    expect(store.blobs.get(WORKSPACE_ID)?.activePaneId).toBe('pane-2');
    expect(await store.currentRev(WORKSPACE_ID)).toBe(1);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});
