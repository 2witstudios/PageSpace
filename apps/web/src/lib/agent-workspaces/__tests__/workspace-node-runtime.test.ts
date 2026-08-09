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
  /**
   * A workspace's nodes and rev, mutated by the write exactly as the DB would
   * be — plus `rows`, which stands for whatever `within` writes on the same
   * transaction (a conversation, a shell). The lock stub below rolls ALL of it
   * back on a throw, so "the membership write unwound" and "it returned a
   * refusal" are distinguishable states rather than the same empty `writes`.
   */
  store: { rev: 0, nodes: [] as WorkspaceNode[], writes: [] as PersistedNodeWrite[], rows: [] as string[] },
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
    // A TRANSACTION, not a passthrough. The lock's mutual exclusion belongs to
    // the store's own surface, but its ROLLBACK is exactly what this wiring
    // depends on: a refusal raised after `within` has written must take those
    // writes with it, and a fake that could not roll back would make an
    // unwinding refusal and a returning one indistinguishable.
    withWorkspaceLayoutLock: async (_id: string, fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = {
        rev: store.rev,
        nodes: structuredClone(store.nodes),
        writes: [...store.writes],
        rows: [...store.rows],
      };
      try {
        return await fn({});
      } catch (error) {
        Object.assign(store, snapshot);
        throw error;
      }
    },
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

const { applyWorkspaceMembershipWrite, applyWorkspaceNodeWrite, readWorkspaceNodes } = await import(
  '../workspace-node-runtime',
);

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
  store.rows = [];
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


/**
 * THE MEMBERSHIP WRITE'S SHARED TRANSACTION — the chokepoint's whole contract.
 *
 * `within` receives the transaction the node write runs on, and the funnel is
 * what guarantees the two cannot land apart. The store fake above mutates its
 * state only inside `writeWorkspaceNodes`, so "the node was written" is
 * observable as `store.writes`, and "the row was written" is observable as the
 * callback having run — which is exactly the pair a ghost breaks.
 */
describe('the membership write', () => {
  it('runs `within` BEFORE the binding gate — the gate asks about a row `within` just created', async () => {
    // Ordering, and it is load-bearing rather than incidental: the gate reads
    // the conversation to decide containment, and for a spawn that conversation
    // does not exist until `within` inserts it. A gate that ran first would
    // refuse every legitimate spawn.
    const order: string[] = [];
    authorize.allow = true;
    const before = authorize.seen.length;

    await applyWorkspaceMembershipWrite({
      workspaceId: WORKSPACE,
      actingUserId: VIEWER,
      run: () => ({
        ok: true,
        write: { put: [pane('pane-new', 'root', 2, { kind: 'chat', id: 'conv-new' })], drop: [] },
      }),
      within: async () => {
        order.push('within');
        store.rows.push('conv-new');
      },
    });

    expect(order).toEqual(['within']);
    expect(store.rows).toEqual(['conv-new']);
    // The gate ran, and it ran on the target this write INTRODUCED.
    expect(authorize.seen.length).toBe(before + 1);
    expect(store.writes).toHaveLength(1);
  });

  it('a REFUSED binding gate writes no node AND unwinds `within`', async () => {
    // The gate refuses after `within` has already written into the transaction,
    // so it has to THROW rather than return — otherwise the transaction commits
    // a conversation with no membership, which is the ghost this funnel exists
    // to make unrepresentable. The unwind is observable here as: no node write,
    // and the caller still gets an ordinary refusal rather than an exception.
    authorize.allow = false;

    const result = await applyWorkspaceMembershipWrite({
      workspaceId: WORKSPACE,
      actingUserId: VIEWER,
      run: () => ({
        ok: true,
        write: { put: [pane('pane-new', 'root', 2, { kind: 'chat', id: 'conv-new' })], drop: [] },
      }),
      within: async () => {
        store.rows.push('conv-new');
      },
    });

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.code).toBe('forbidden_target');
    expect(store.writes).toEqual([]);
    expect(store.rev).toBe(3);
    // THE LOAD-BEARING ASSERTION. `within` already inserted by the time the
    // gate refused, so a refusal that merely RETURNED would commit this row
    // with no node beside it — a conversation that is a member of nothing.
    // Only an unwind takes it back.
    expect(store.rows).toEqual([]);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('a REFUSED command never reaches `within` at all', async () => {
    // Refusals decided before the transaction has written anything return
    // rather than throw — but they must still not run the creator, or a
    // workspace at its cap would mint conversations it then refused to admit.
    let ran = false;

    const result = await applyWorkspaceMembershipWrite({
      workspaceId: WORKSPACE,
      actingUserId: VIEWER,
      run: () => ({ ok: false, code: 'session_full', detail: 'full' }),
      within: async () => {
        ran = true;
      },
    });

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.code).toBe('session_full');
    expect(ran).toBe(false);
    expect(store.writes).toEqual([]);
  });

  it('a throw from `within` takes the node write with it', async () => {
    class Refused extends Error {}
    await expect(
      applyWorkspaceMembershipWrite({
        workspaceId: WORKSPACE,
        actingUserId: VIEWER,
        run: () => ({ ok: true, write: { put: [pane('pane-new', 'root', 2)], drop: [] } }),
        within: async () => {
          store.rows.push('conv-new');
          throw new Refused('the conversation could not be created');
        },
      }),
    ).rejects.toBeInstanceOf(Refused);

    // Nothing persisted — not the node, and not the half-written row either —
    // and the caller's own error reaches them unchanged, which is what lets the
    // conversation layer keep its error vocabulary.
    expect(store.writes).toEqual([]);
    expect(store.rows).toEqual([]);
    expect(store.rev).toBe(3);
  });

  it('runs `within` even when the TREE does not change — a retry re-checks its own gates', async () => {
    // A re-sent create finds the node already there, so the membership write is
    // a no-op on the tree. The conversation-level idempotency gates (is this id
    // really the thread the caller described?) still have to run, or a request
    // nobody checked would be answered "yes" because the layout happened not to
    // move.
    let ran = false;
    const result = await applyWorkspaceMembershipWrite({
      workspaceId: WORKSPACE,
      actingUserId: VIEWER,
      run: () => ({ ok: true, write: { put: [], drop: [] } }),
      within: async () => {
        ran = true;
      },
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.changed).toBe(false);
    expect(ran).toBe(true);
    expect(store.writes).toEqual([]);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('reports a chat-target unique violation as `bound_elsewhere`, not as a fault', async () => {
    // The one database answer this layer translates: two workspaces raced for
    // one conversation, and only the global index was in a position to settle
    // it. Matched on the constraint NAME rather than the message, because the
    // message is a Postgres locale string.
    const conflict = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'agent_workspace_nodes_chat_target_idx',
    });

    const result = await applyWorkspaceMembershipWrite({
      workspaceId: WORKSPACE,
      actingUserId: VIEWER,
      run: () => ({ ok: true, write: { put: [pane('pane-new', 'root', 2)], drop: [] } }),
      within: async () => {
        throw conflict;
      },
    });

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.code).toBe('bound_elsewhere');
  });

  it('lets a unique violation from ANY OTHER index keep throwing', async () => {
    // A `23505` on the primary key or the single-root index is a genuine fault
    // and must not be reported to a user as "already bound".
    const conflict = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'agent_workspace_nodes_one_root_idx',
    });

    await expect(
      applyWorkspaceMembershipWrite({
        workspaceId: WORKSPACE,
        actingUserId: VIEWER,
        run: () => ({ ok: true, write: { put: [pane('pane-new', 'root', 2)], drop: [] } }),
        within: async () => {
          throw conflict;
        },
      }),
    ).rejects.toBe(conflict);
  });
});
