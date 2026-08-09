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
import {
  CHAT_TARGET_UNIQUE_INDEX,
  type ChatTargetHolder,
} from '@pagespace/lib/agent-workspaces/workspace-node-chat-binding';

const WORKSPACE = 'ws-1';
const VIEWER = 'user-1';

const { store, mockBroadcast, authorize, labelRows, chatBindings } = vi.hoisted(() => ({
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
  /**
   * The GLOBAL half of the one-node-per-conversation rule, which no workspace's
   * own rows can answer: `holders` is what the whole table says, `asked` is
   * every id the write path actually looked up (so a test can pin that it did
   * NOT look, which is how the ordering against the ACL gate is asserted), and
   * `throwOnWrite` is a constraint violation the persist raises after the
   * pre-flight has already passed — the TOCTOU window.
   */
  chatBindings: {
    holders: [] as ChatTargetHolder[],
    asked: [] as string[][],
    throwOnWrite: null as Error | null,
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
    readChatTargetHolders: async (_tx: unknown, targetIds: readonly string[]) => {
      chatBindings.asked.push([...targetIds]);
      return chatBindings.holders.filter((holder) => targetIds.includes(holder.targetId));
    },
    writeWorkspaceNodes: async (_tx: unknown, input: { write: PersistedNodeWrite }) => {
      if (chatBindings.throwOnWrite !== null) throw chatBindings.throwOnWrite;
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
  chatBindings.holders = [];
  chatBindings.asked = [];
  chatBindings.throwOnWrite = null;
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

/**
 * The constraint whose key is `targetId` ALONE — the only one on the node table
 * that reaches past the workspace being written, and therefore the only one
 * `validateTree` structurally cannot settle. Everything here is about the two
 * places that gap is closed and about the SHAPE of the refusal, which is the
 * whole point: a 502 tells an optimistic client nothing it can act on.
 */
describe('a chat target already bound in ANOTHER workspace', () => {
  const held = (target: string, rootId = 'ws-somewhere-else'): ChatTargetHolder => ({
    rootId,
    nodeId: 'their-pane',
    targetId: target,
  });

  it('is a typed refusal, not a raw constraint error — and writes nothing', async () => {
    chatBindings.holders = [held('conv-1')];
    const result = await write({ put: [pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-1' })] });

    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.code).toBe('target_already_shown');
    expect(result.detail).toContain('conv-1');
    expect(store.writes).toEqual([]);
    expect(store.rev).toBe(3);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('CARRIES THE TRUTH TO REBASE AGAINST — the same body a GET answers', async () => {
    // This is the finding, not a nicety. The client applied optimistically; a
    // body with no `rev` and no `nodes` leaves its rebase path — which is driven
    // by the snapshot — with nothing to run on, and the phantom pane stays on
    // screen until an unrelated poll happens to correct it.
    store.nodes = [root, pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-mine' })];
    labelRows.conversations = [
      { id: 'conv-mine', title: 'Planning', type: 'page', contextId: null, userId: VIEWER, isShared: false, workspaceId: WORKSPACE, lastMessageAt: null },
    ];
    chatBindings.holders = [held('conv-1')];

    const result = await write({
      put: [pane('pane-new', 'root', 1, { kind: 'chat', id: 'conv-1' })],
    });
    const fresh = await readWorkspaceNodes(WORKSPACE, VIEWER);

    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.snapshot).toEqual(fresh);
    expect(result.snapshot.rev).toBe(3);
    expect(result.snapshot.nodes.map((node) => node.id)).toEqual(['root', 'pane-a']);
    expect(result.snapshot.targets).toEqual([
      { id: 'conv-mine', kind: 'chat', title: 'Planning', lastMessageAt: null },
    ]);
  });

  it('asks the table only about CHAT targets — pages and terminals carry no such index', async () => {
    // `UNIQUE (targetId) WHERE targetKind = 'chat'` is predicated on the kind,
    // and opening one page in two panes is a thing users do. Asking about a page
    // id would be a query with no constraint behind it.
    await write({
      put: [
        pane('pane-a', 'root', 0, { kind: 'page', id: 'page-1' }),
        pane('pane-b', 'root', 1, { kind: 'terminal', id: 'shell-1' }),
      ],
    });
    expect(chatBindings.asked).toEqual([]);
  });

  it('does not ask about a conversation THIS workspace already holds', async () => {
    // Held here means it passed this gate when it arrived, and the global index
    // guarantees nobody else can be holding it. Re-asking would also make a
    // resize of a bound pane cost a table-wide query.
    store.nodes = [root, pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-1' })];
    const result = await write({ put: [pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-1' }), pane('pane-z', 'root', 1)] });
    expect(result.status).toBe('ok');
    expect(chatBindings.asked).toEqual([]);
  });

  it('runs AFTER the ACL gate, so a refusal never confirms a conversation the caller may not touch', async () => {
    // Reversed, the pre-flight would be an existence oracle: "already shown
    // elsewhere" about a conversation id the caller has no authority over tells
    // them it exists and is in use. The 403 has to win.
    authorize.allow = false;
    chatBindings.holders = [held('conv-1')];
    const result = await write({ put: [pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-1' })] });

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.code).toBe('forbidden_target');
    expect(chatBindings.asked).toEqual([]);
  });

  it('lets the bind through when the only holder is in THIS workspace', async () => {
    // The row exists, and it is ours. `validateTree` and the store's
    // delete-before-upsert own that case; a second refusal here would give one
    // fault two codes.
    store.nodes = [root, pane('pane-old', 'root', 0, { kind: 'chat', id: 'conv-1' })];
    chatBindings.holders = [held('conv-1', WORKSPACE)];
    const result = await write({
      drop: ['pane-old'],
      put: [pane('pane-new', 'root', 0, { kind: 'chat', id: 'conv-1' })],
    });
    expect(result.status).toBe('ok');
  });
});

describe('the TOCTOU backstop', () => {
  /** What node-postgres raises, wrapped the way drizzle wraps it. */
  const indexViolation = (constraint: string) =>
    Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        constraint,
      }),
    });

  it('maps the index violation to the SAME typed refusal, with the same rebase body', async () => {
    // The pre-flight cannot close this: the advisory lock serializes writes to
    // ONE workspace, and two writers racing for one conversation are in two
    // different ones by definition. Without this, the pre-flight would make the
    // 502 rarer rather than gone.
    chatBindings.throwOnWrite = indexViolation(CHAT_TARGET_UNIQUE_INDEX);
    const result = await write({ put: [pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-1' })] });

    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.code).toBe('target_already_shown');
    expect(result.detail).toContain('conv-1');
    expect(result.snapshot.rev).toBe(3);
    expect(result.snapshot.nodes.map((node) => node.id)).toEqual(['root', 'pane-a', 'pane-b']);
    expect(store.rev).toBe(3);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('does NOT swallow a violation of the single-root index — a different fault, and not this code', async () => {
    // Widening the catch to every 23505 would report a structurally broken
    // workspace as "that conversation is shown elsewhere". It stays a thrown
    // error, which the route answers as 502.
    chatBindings.throwOnWrite = indexViolation('agent_workspace_nodes_one_root_idx');
    await expect(write({ put: [pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-1' })] })).rejects.toThrow();
  });

  it('does not swallow an ordinary failure', async () => {
    chatBindings.throwOnWrite = new Error('connection terminated');
    await expect(write({ put: [pane('pane-z', 'root', 2)] })).rejects.toThrow('connection terminated');
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
