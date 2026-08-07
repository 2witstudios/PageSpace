// @vitest-environment node
/**
 * `applyWorkspaceLayoutVerb` — the locked read-reduce-write orchestration
 * over the shared reducer. What matters here: the opId replay short-circuit
 * (a retried split must never re-insert its pane id), the stale-baseRev
 * truth-to-rebase answer, the content-diff deciding `applied` and the
 * broadcast, and — since the `workspaceState` blob was dropped — that every
 * pane LABEL on the way out is JOINED from the live target rather than
 * carried by a stored copy. The reducer itself and the store contract are
 * pinned in packages/lib; this suite runs both against a fake store to test
 * exactly the wiring in between.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LayoutGridColumn } from '@pagespace/lib/agent-sessions/workspace-layout-verbs';
import type { WorkspaceLayoutStore } from '@pagespace/lib/services/agent-sessions/workspace-layout-store';

/**
 * In-memory stand-in honoring the store contract pinned by packages/lib's
 * own fake-backed suite (the lib fake lives under `__tests__/`, which never
 * ships in dist — hence this local twin rather than an import).
 */
function createFakeWorkspaceLayoutStore(): WorkspaceLayoutStore {
  const grids = new Map<string, LayoutGridColumn[]>();
  const revs = new Map<string, number>();
  const ops = new Map<string, { rev: number; applied: boolean }>();
  return {
    async getWorkspaceGrid(workspaceId) {
      return structuredClone(grids.get(workspaceId) ?? []);
    },
    async getWorkspaceGridsBulk(workspaceIds) {
      const out = new Map<string, LayoutGridColumn[]>();
      for (const id of workspaceIds) {
        const grid = grids.get(id);
        if (grid && grid.length > 0) out.set(id, structuredClone(grid));
      }
      return out;
    },
    async replaceWorkspaceGrid({ workspaceId, grid }) {
      const current = grids.get(workspaceId) ?? [];
      if (JSON.stringify(current) === JSON.stringify(grid)) {
        return { rev: revs.get(workspaceId) ?? 0, applied: false };
      }
      grids.set(workspaceId, structuredClone(grid));
      const next = (revs.get(workspaceId) ?? 0) + 1;
      revs.set(workspaceId, next);
      return { rev: next, applied: true };
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

const { mockBroadcast, storeRef, labelRows } = vi.hoisted(() => ({
  mockBroadcast: vi.fn(),
  storeRef: { current: null as unknown },
  /** What the label JOIN finds, per table — the live titles the rows do not store. */
  labelRows: { conversations: [] as unknown[], shells: [] as unknown[], pages: [] as unknown[] },
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
// The label join is now on EVERY path out of this module, so the db graph is
// stubbed as a working query chain rather than stubbed away: `.from(table)`
// picks the row list that table's lookup should find.
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: (table: { __name: 'conversations' | 'shells' | 'pages' }) => ({
        where: async () => labelRows[table.__name],
      }),
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ inArray: vi.fn() }));
vi.mock('@pagespace/db/schema/conversations', () => ({ conversations: { __name: 'conversations' } }));
vi.mock('@pagespace/db/schema/agent-sessions', () => ({ agentSessionShells: { __name: 'shells' } }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { __name: 'pages' } }));

import { applyWorkspaceLayoutVerb } from '../workspace-layout-runtime';

const WORKSPACE_ID = 'ses-1';
const scope = { kind: 'chat' as const, name: 'Conversation', targetId: 'conv-1', agentPageId: null };
/** What the pane comes back as: the name is JOINED, never echoed from the verb. */
const joinedScope = { ...scope, name: 'Live title' };

let store: ReturnType<typeof createFakeWorkspaceLayoutStore>;

beforeEach(() => {
  vi.clearAllMocks();
  store = createFakeWorkspaceLayoutStore();
  storeRef.current = store;
  labelRows.conversations = [{ id: 'conv-1', title: 'Live title', type: 'global', contextId: null }];
  labelRows.shells = [];
  labelRows.pages = [];
});

const ensure = (opId = 'op-ensure', baseRev = 0) =>
  applyWorkspaceLayoutVerb({
    workspaceId: WORKSPACE_ID,
    opId,
    baseRev,
    verb: { type: 'ensure', columnId: 'col-1', paneId: 'pane-1', scope },
  });

describe('applyWorkspaceLayoutVerb', () => {
  it('applies a verb, persists rows, and broadcasts the post-write rev with JOINED labels', async () => {
    const result = await ensure();
    expect(result).toEqual({
      status: 'ok',
      rev: 1,
      applied: true,
      grid: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: joinedScope }] }],
    });
    // Row projection carries CANONICAL null fractions on an unsized grid
    // (issue #2208) — the store's content diff is a JSON.stringify compare,
    // where an absent key and an explicit null are not the same bytes.
    expect(await store.getWorkspaceGrid(WORKSPACE_ID)).toEqual([
      { id: 'col-1', widthFraction: null, panes: [{ id: 'pane-1', kind: 'chat', targetId: 'conv-1', heightFraction: null }] },
    ]);
    expect(mockBroadcast).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      rev: 1,
      verb: 'ensure',
      // The causing op's key rides along so a subscriber can recognize its
      // OWN echo and leave its still-queued verb alone.
      opId: 'op-ensure',
      grid: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: joinedScope }] }],
    });
  });

  it('reflects a RENAME on the next verb without any write to the pane row', async () => {
    await ensure('op-1');
    // The conversation is renamed elsewhere. Nothing rewrites the pane row —
    // and nothing needs to, which is the entire point of not storing names.
    labelRows.conversations = [{ id: 'conv-1', title: 'Renamed', type: 'global', contextId: null }];
    const next = await applyWorkspaceLayoutVerb({
      workspaceId: WORKSPACE_ID,
      opId: 'op-2',
      baseRev: 1,
      verb: { type: 'split_down', fromPaneId: 'pane-1', newPaneId: 'pane-2' },
    });
    expect(next.status === 'ok' && next.grid[0].panes[0].scope?.name).toBe('Renamed');
  });

  it('leaves a pane whose target no longer exists with an empty label, not a crash', async () => {
    labelRows.conversations = [];
    const result = await ensure();
    expect(result.status === 'ok' && result.grid[0].panes[0].scope).toEqual({ ...scope, name: '' });
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
      grid: [{ id: 'col-1', panes: [{ id: 'pane-1', scope: joinedScope }] }],
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
