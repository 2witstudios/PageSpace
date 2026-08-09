// @vitest-environment node
/**
 * The node model's write funnel — the wiring between the atomic read, the pure
 * decision, the binding gate, the persistence and the broadcast.
 *
 * The decision itself is pinned next door in packages/lib against node lists;
 * what this suite is for is everything that decision cannot see: that a refusal
 * writes NOTHING, that the binding gate runs on the acting user and only for
 * bindings the write INTRODUCES, that a stale caller gets truth rather than an
 * error, that a replay bumps no rev and broadcasts nothing, and that the
 * broadcast carries no titles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PaneTarget, WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import type { PersistedNodeWrite } from '@pagespace/lib/agent-workspaces/workspace-node-write';

const WORKSPACE = 'ws-1';
const VIEWER = 'user-1';

const { store, mockBroadcast, authorize, labelRows } = vi.hoisted(() => ({
  /** A workspace's nodes and rev, mutated by the write exactly as the DB would be. */
  store: { rev: 0, nodes: [] as WorkspaceNode[], writes: [] as PersistedNodeWrite[] },
  mockBroadcast: vi.fn(),
  authorize: { allow: true, seen: [] as unknown[] },
  labelRows: {
    conversations: [] as unknown[],
    shells: [] as unknown[],
    pages: [] as unknown[],
    workspaces: [] as unknown[],
  },
}));

vi.mock('@pagespace/lib/services/agent-workspaces/workspace-node-store', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@pagespace/lib/services/agent-workspaces/workspace-node-store',
  );
  return {
    ...actual,
    // The lock collapses to a passthrough: lock semantics belong to the store's
    // own surface, not to this wiring test.
    withWorkspaceLayoutLock: async (_id: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
    readWorkspaceNodeSnapshot: async () => ({ rev: store.rev, nodes: structuredClone(store.nodes) }),
    readWorkspaceNodeSnapshots: async (_tx: unknown, ids: string[]) =>
      new Map(ids.map((id) => [id, { rev: store.rev, nodes: structuredClone(store.nodes) }])),
    writeWorkspaceNodes: async (_tx: unknown, input: { write: PersistedNodeWrite }) => {
      store.writes.push(input.write);
      const dropping = new Set(input.write.drop);
      const byId = new Map(input.write.put.map((node) => [node.id, node]));
      const kept = store.nodes.filter((node) => !dropping.has(node.id)).map((node) => byId.get(node.id) ?? node);
      const present = new Set(kept.map((node) => node.id));
      store.nodes = [...kept, ...input.write.put.filter((node) => !present.has(node.id))];
      store.rev += 1;
      return store.rev;
    },
  };
});

vi.mock('@/lib/websocket/agent-workspace-events', () => ({
  broadcastWorkspaceNodesUpdated: (...args: unknown[]) => mockBroadcast(...args),
}));

vi.mock('../authorize-pane-scope', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../authorize-pane-scope');
  return {
    ...actual,
    authorizePaneTargets: async (input: unknown) => {
      authorize.seen.push(input);
      return authorize.allow;
    },
  };
});

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: (table: { __name: 'conversations' | 'shells' | 'pages' | 'workspaces' }) => ({
        where: async () => labelRows[table.__name],
      }),
    }),
  },
}));
vi.mock('@pagespace/db/schema/conversations', () => ({ conversations: { __name: 'conversations' } }));
vi.mock('@pagespace/db/schema/agent-workspaces', () => ({
  agentWorkspaceShells: { __name: 'shells' },
  agentWorkspaces: { __name: 'workspaces' },
}));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { __name: 'pages' } }));
vi.mock('@pagespace/db/operators', () => ({ inArray: () => ({}) }));
vi.mock('@pagespace/lib/permissions/permissions', () => ({ getUserAccessLevel: async () => 'VIEW' }));
vi.mock('@pagespace/lib/permissions/conversation-access', () => ({ canAccessConversation: async () => true }));

const { applyWorkspaceNodeWrite, readWorkspaceNodes } = await import('../workspace-node-runtime');

const root: WorkspaceNode = { nodeType: 'root', id: 'root', parentId: null, position: 0, axis: 'row' };
const pane = (
  id: string,
  parentId: string | null,
  position: number,
  target: PaneTarget | null = null,
): WorkspaceNode => ({ nodeType: 'pane', id, parentId, position, target });

beforeEach(() => {
  vi.clearAllMocks();
  store.rev = 3;
  store.nodes = [root, pane('pane-a', 'root', 0), pane('pane-b', 'root', 1)];
  store.writes = [];
  authorize.allow = true;
  authorize.seen = [];
  labelRows.conversations = [];
  labelRows.shells = [];
  labelRows.pages = [];
  labelRows.workspaces = [{ id: WORKSPACE, ownerId: VIEWER }];
});

function write(over: { baseRev?: number; put?: WorkspaceNode[]; drop?: string[] } = {}) {
  return applyWorkspaceNodeWrite({
    workspaceId: WORKSPACE,
    baseRev: over.baseRev ?? store.rev,
    put: over.put ?? [],
    drop: over.drop ?? [],
    viewerId: VIEWER,
  });
}

describe('a stale baseRev', () => {
  it('answers with the truth to rebase against, and writes nothing', async () => {
    const result = await write({ baseRev: 1, put: [pane('pane-a', 'root', 1)] });
    expect(result.status).toBe('stale');
    if (result.status !== 'stale') return;
    expect(result.snapshot.rev).toBe(3);
    expect(result.snapshot.nodes.map((node) => node.id)).toEqual(['root', 'pane-a', 'pane-b']);
    expect(store.writes).toEqual([]);
    expect(store.rev).toBe(3);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

describe('a payload that names another workspace', () => {
  it('is refused outright — never told to rebase, and never partially applied', async () => {
    const result = await applyWorkspaceNodeWrite({
      workspaceId: WORKSPACE,
      baseRev: 3,
      put: [{ ...pane('pane-a', 'root', 1), rootId: 'ws-somebody-else' }],
      drop: [],
      viewerId: VIEWER,
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.code).toBe('foreign_scope');
    expect(store.writes).toEqual([]);
    expect(store.rev).toBe(3);
  });
});

describe('a write whose result would not be a valid workspace', () => {
  it('is refused, writes nothing, and REPAIRS nothing', async () => {
    // `pane-a` would be parented to a container the write itself removed. The
    // only acceptable answer is "no" — a re-parent onto the root here is a pane
    // relocated into a place the user never put it.
    const result = await write({ put: [pane('pane-a', 'col-that-is-not-there', 0)] });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.code).toBe('dangling_parent');
    expect(store.writes).toEqual([]);
    expect(store.nodes.find((node) => node.id === 'pane-a')?.parentId).toBe('root');
  });
});

describe('the binding gate', () => {
  it('runs on a target the write INTRODUCES, against the acting user', async () => {
    await write({ put: [pane('pane-a', 'root', 0, { kind: 'page', id: 'page-1' })] });
    expect(authorize.seen).toEqual([
      expect.objectContaining({
        viewerId: VIEWER,
        workspaceId: WORKSPACE,
        targets: [{ kind: 'page', targetId: 'page-1' }],
      }),
    ]);
  });

  it('refuses the whole write when the acting user may not bind that target', async () => {
    authorize.allow = false;
    const result = await write({ put: [pane('pane-a', 'root', 0, { kind: 'page', id: 'page-1' })] });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.code).toBe('forbidden_target');
    expect(store.writes).toEqual([]);
  });

  it('does NOT gate a binding the workspace already holds — the trap that would make a layout unwritable', async () => {
    // A viewer who lost access to a page must still be able to move, resize and
    // CLOSE the pane showing it. Closing is a `put` with `parentId: null`, so
    // gating every target in the payload would leave no exit at all.
    store.nodes = [root, pane('pane-a', 'root', 0, { kind: 'page', id: 'page-1' })];
    authorize.allow = false;
    const result = await write({ put: [pane('pane-a', null, 0, { kind: 'page', id: 'page-1' })] });
    expect(result.status).toBe('ok');
    expect(authorize.seen).toEqual([]);
  });
});

describe('replay', () => {
  it('is a no-op by construction: the same POST twice mints one rev and broadcasts once', async () => {
    const put = [pane('pane-a', 'root', 1), pane('pane-b', 'root', 0)];
    const first = await write({ put });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    expect(first.changed).toBe(true);
    expect(store.rev).toBe(4);

    // The retry carries the SAME baseRev the client sent the first time. In the
    // verb model this needed an `(workspaceId, opId)` memory row, because a
    // replayed `split_right` re-inserted its own minted pane id and violated the
    // primary key. An upsert of a node set simply cannot.
    const replay = await applyWorkspaceNodeWrite({
      workspaceId: WORKSPACE,
      baseRev: 4,
      put,
      drop: [],
      viewerId: VIEWER,
    });
    expect(replay.status).toBe('ok');
    if (replay.status !== 'ok') return;
    expect(replay.changed).toBe(false);
    expect(store.rev).toBe(4);
    expect(store.writes).toHaveLength(1);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
  });

  it('a drop naming an already-dropped node changes nothing', async () => {
    await write({ drop: ['pane-b'] });
    const before = store.rev;
    const replay = await write({ drop: ['pane-b'] });
    expect(replay.status).toBe('ok');
    if (replay.status !== 'ok') return;
    expect(replay.changed).toBe(false);
    expect(store.rev).toBe(before);
  });
});

describe('the broadcast', () => {
  it('is STRUCTURAL: the tree and the rev, and no titles at all', async () => {
    store.nodes = [root, pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-1' })];
    labelRows.conversations = [
      { id: 'conv-1', title: 'Q3 layoffs', type: 'page', contextId: 'page-9', userId: VIEWER, isShared: false, workspaceId: WORKSPACE, lastMessageAt: new Date('2026-01-02T03:04:05Z') },
    ];
    await write({ put: [pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-1' }), pane('pane-z', 'root', 1)] });

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    const payload = mockBroadcast.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['nodes', 'rev', 'workspaceId']);
    // `session:<id>` is a ROOM — one payload reaches every member at once, so
    // there is no viewer to redact for and a title has no business on this wire.
    expect(JSON.stringify(payload)).not.toContain('Q3 layoffs');
  });
});

describe('targets ride BESIDE the tree, resolved once per viewer', () => {
  it('carries the title and the lastMessageAt the sidebar orders by', async () => {
    store.nodes = [root, pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-1' })];
    labelRows.conversations = [
      { id: 'conv-1', title: 'Planning', type: 'page', contextId: 'page-9', userId: VIEWER, isShared: false, workspaceId: WORKSPACE, lastMessageAt: new Date('2026-01-02T03:04:05.000Z') },
    ];
    const snapshot = await readWorkspaceNodes(WORKSPACE, VIEWER);
    expect(snapshot.targets).toEqual([
      { id: 'conv-1', kind: 'chat', title: 'Planning', lastMessageAt: '2026-01-02T03:04:05.000Z' },
    ]);
  });

  it('redacts another member private thread in a workspace they do not own', async () => {
    store.nodes = [root, pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-1' })];
    labelRows.workspaces = [{ id: WORKSPACE, ownerId: 'someone-else' }];
    labelRows.conversations = [
      { id: 'conv-1', title: 'Q3 layoffs', type: 'page', contextId: null, userId: 'someone-else', isShared: false, workspaceId: WORKSPACE, lastMessageAt: null },
    ];
    const snapshot = await readWorkspaceNodes(WORKSPACE, VIEWER);
    expect(snapshot.targets).toEqual([
      { id: 'conv-1', kind: 'chat', title: '(private thread)', lastMessageAt: null },
    ]);
  });

  it('resolves NOTHING for a viewer of null — the honest shape for a caller that discards the body', async () => {
    store.nodes = [root, pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-1' })];
    labelRows.conversations = [
      { id: 'conv-1', title: 'Planning', type: 'page', contextId: null, userId: VIEWER, isShared: false, workspaceId: WORKSPACE, lastMessageAt: null },
    ];
    expect((await readWorkspaceNodes(WORKSPACE, null)).targets).toEqual([]);
  });

  it('drops a shell that belongs to ANOTHER workspace — containment is the whole rule for a terminal', async () => {
    store.nodes = [root, pane('pane-a', 'root', 0, { kind: 'terminal', id: 'shell-1' })];
    labelRows.shells = [{ id: 'shell-1', name: 'build', workspaceId: 'ws-somewhere-else' }];
    // No entry at all, so refusing to resolve is indistinguishable from "gone"
    // and the read is not an existence oracle. The NODE still renders.
    expect((await readWorkspaceNodes(WORKSPACE, VIEWER)).targets).toEqual([]);
  });
});

describe('the 409 body', () => {
  it('says exactly what a GET would say — same shape, same per-viewer titles', async () => {
    store.nodes = [root, pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-1' })];
    labelRows.conversations = [
      { id: 'conv-1', title: 'Planning', type: 'page', contextId: null, userId: VIEWER, isShared: false, workspaceId: WORKSPACE, lastMessageAt: null },
    ];
    const stale = await write({ baseRev: 1, put: [pane('pane-a', 'root', 1)] });
    const fresh = await readWorkspaceNodes(WORKSPACE, VIEWER);
    expect(stale.status).toBe('stale');
    if (stale.status !== 'stale') return;
    expect(stale.snapshot).toEqual(fresh);
  });
});
