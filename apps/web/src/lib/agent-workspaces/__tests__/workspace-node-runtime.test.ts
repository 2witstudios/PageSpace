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
import { rootSeedFor } from '@pagespace/lib/agent-workspaces/workspace-node-commands';
import {
  CHAT_TARGET_UNIQUE_INDEX,
  type ChatTargetHolder,
} from '@pagespace/lib/agent-workspaces/workspace-node-chat-binding';

const WORKSPACE = 'ws-1';
const VIEWER = 'user-1';

const { store, mockBroadcast, mockConversationClosed, authorize, labelRows, chatBindings, directoryRows } = vi.hoisted(() => ({
  /**
   * A workspace's nodes and rev, mutated by the write exactly as the DB would
   * be — plus `rows`, which stands for whatever `within` writes on the same
   * transaction (a conversation, a shell). The lock stub below rolls ALL of it
   * back on a throw, so "the membership write unwound" and "it returned a
   * refusal" are distinguishable states rather than the same empty `writes`.
   */
  store: {
    rev: 0,
    nodes: [] as WorkspaceNode[],
    writes: [] as PersistedNodeWrite[],
    rows: [] as string[],
    /**
     * A transaction that fails AT COMMIT, after the body has run to completion.
     *
     * The only way to reach the far side of every in-body refusal and still not
     * have the write land — which is the one seam that can tell "read inside
     * the transaction, emit after it commits" from "emit inside it". Every
     * other rollback in this suite is a throw from the body, which happens
     * before the directory read is even reached.
     */
    throwOnCommit: null as Error | null,
  },
  mockBroadcast: vi.fn(),
  /**
   * The DIRECTORY plane's `conversation:closed`. Async like the real one, and
   * typed with its argument so `mock.calls` is a tuple the assertions can index.
   */
  mockConversationClosed: vi.fn(async (_ctx: { conversationId: string }) => {}),
  /**
   * What `readConversationDirectoryRows` answers — the display facts a
   * `conversation:closed` is addressed with. Seeded per test for whichever
   * threads that test's tree holds.
   */
  directoryRows: [] as Array<{
    id: string;
    rev: number;
    userId: string;
    isShared: boolean;
    type: string;
    contextId: string | null;
  }>,
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
    /** Conversations whose history has been deleted — the liveness backstop's answer. */
    deleted: [] as string[],
    /** Every id the LIVENESS check looked up, so a test can pin that it did not look. */
    livenessAsked: [] as string[][],
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
    //
    // The transaction it hands `fn` is used for two things: the store reads
    // above (mocked wholesale), and `readWorkspaceOwnerId`'s own SELECT — which
    // runs INSIDE the lock deliberately, so the broadcast can reach the owner's
    // directory plane without a second query on the hot path. A `{}` here would
    // pass every rollback test and throw on every broadcast one.
    withWorkspaceLock: async (_id: string, fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = {
        rev: store.rev,
        nodes: structuredClone(store.nodes),
        writes: [...store.writes],
        rows: [...store.rows],
      };
      try {
        const answer = await fn({
          select: () => ({
            from: () => ({ where: () => ({ limit: async () => labelRows.workspaces }) }),
          }),
        });
        if (store.throwOnCommit !== null) throw store.throwOnCommit;
        return answer;
      } catch (error) {
        Object.assign(store, snapshot);
        throw error;
      }
    },
    readWorkspaceNodeSnapshot: async () => ({ rev: store.rev, nodes: structuredClone(store.nodes) }),
    readWorkspaceNodeSnapshots: async (_tx: unknown, ids: string[]) =>
      new Map(ids.map((id) => [id, { rev: store.rev, nodes: structuredClone(store.nodes) }])),
    readChatTargetHolders: async (_tx: unknown, targetIds: readonly string[]) => {
      chatBindings.asked.push([...targetIds]);
      return chatBindings.holders.filter((holder) => targetIds.includes(holder.targetId));
    },
    readDeletedChatTargets: async (_tx: unknown, targetIds: readonly string[]) => {
      chatBindings.livenessAsked.push([...targetIds]);
      return targetIds.filter((id) => chatBindings.deleted.includes(id));
    },
    readConversationDirectoryRows: async (_tx: unknown, ids: readonly string[]) =>
      directoryRows.filter((row) => ids.includes(row.id)),
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

// `SERVER_TRIGGERED_BROWSER_SESSION` is not decoration: `emitContextFromRow`
// reads it for the default `triggeredBy`, and vitest raises on a missing named
// export from a mocked module. That throw is SYNCHRONOUS and lands inside
// `announceWithoutUnsucceeding`, which swallows it by contract — so an
// incomplete mock here reads as "the funnel does not announce" rather than as
// an error. (It also demonstrated the contract works: the write still
// succeeded.)
vi.mock('@/lib/websocket/conversation-events', () => ({
  conversationEvents: { closed: (ctx: { conversationId: string }) => mockConversationClosed(ctx) },
  SERVER_TRIGGERED_BROWSER_SESSION: 'server',
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
vi.mock('@pagespace/db/operators', () => ({
  inArray: () => ({}),
  eq: () => ({}),
  and: () => ({}),
  sql: Object.assign(() => ({}), { raw: () => ({}) }),
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({ getUserAccessLevel: async () => 'VIEW' }));
vi.mock('@pagespace/lib/permissions/conversation-access', () => ({ canAccessConversation: async () => true }));

const {
  applyWorkspaceMembershipWrite,
  applyWorkspaceNodeWrite,
  destroyWorkspaceTree,
  readWorkspaceNodes,
} = await import('../workspace-node-runtime');

const root: WorkspaceNode = { nodeType: 'root', id: 'root', parentId: null, position: 0, axis: 'row' };
const pane = (
  id: string,
  parentId: string,
  position: number,
  target: PaneTarget | null = null,
): WorkspaceNode => ({ nodeType: 'pane', id, parentId, position, target });

beforeEach(() => {
  vi.clearAllMocks();
  store.rev = 3;
  store.nodes = [root, pane('pane-a', 'root', 0), pane('pane-b', 'root', 1)];
  store.writes = [];
  store.rows = [];
  store.throwOnCommit = null;
  authorize.allow = true;
  authorize.seen = [];
  labelRows.conversations = [];
  labelRows.shells = [];
  labelRows.pages = [];
  labelRows.workspaces = [{ id: WORKSPACE, ownerId: VIEWER }];
  chatBindings.holders = [];
  chatBindings.asked = [];
  chatBindings.throwOnWrite = null;
  chatBindings.deleted = [];
  chatBindings.livenessAsked = [];
  directoryRows.length = 0;
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
    // CLOSE the pane showing it. Gating every target in the payload rather than
    // only the ones the write INTRODUCES would leave no exit at all.
    store.nodes = [
      root,
      pane('pane-a', 'root', 0, { kind: 'page', id: 'page-1' }),
      pane('pane-b', 'root', 1),
    ];
    authorize.allow = false;
    const result = await write({ put: [pane('pane-a', 'root', 1, { kind: 'page', id: 'page-1' }), pane('pane-b', 'root', 0)] });
    expect(result.status).toBe('ok');
    expect(authorize.seen).toEqual([]);
  });

  it('does not gate the DESTROY of a pane whose target the viewer can no longer read', async () => {
    // The exit itself. Closing is a `drop` now rather than a `put` with a null
    // parent, and a drop introduces no target at all — so the gate has nothing
    // to judge and cannot strand a pane on screen.
    store.nodes = [
      root,
      pane('pane-a', 'root', 0, { kind: 'page', id: 'page-1' }),
      pane('pane-b', 'root', 1),
    ];
    authorize.allow = false;
    const result = await write({ drop: ['pane-a'], put: [pane('pane-b', 'root', 0)] });
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

/**
 * THE DIRECTORY PLANE'S HALF OF A MEMBERSHIP CHANGE.
 *
 * `conversation:closed` used to be emitted by the close ROUTE's own decision,
 * which is one of four producers that remove a chat node — and, in practice,
 * the one that usually lost: the pane's optimistic `drop` reached this funnel
 * first, so the route's `expel` found no node and its announcement branch was
 * never taken. It is emitted from HERE now, so it is a property of the write
 * rather than of which endpoint a client happened to call.
 *
 * The sidebar's rows come from the LISTING, not the tree, so the structural
 * `workspace:nodes-updated` beside it cannot take a row out of that cache — the
 * other side of the seam is `session-directory-listener.test.ts`.
 */
describe('the conversation:closed announcement', () => {
  const chatPane = (id: string, conversationId: string, position: number) =>
    pane(id, 'root', position, { kind: 'chat', id: conversationId });
  const directoryRow = (id: string) => ({
    id,
    rev: 7,
    userId: VIEWER,
    isShared: false,
    type: 'global',
    contextId: null,
  });

  beforeEach(() => {
    store.nodes = [root, chatPane('pane-a', 'conv-1', 0), chatPane('pane-b', 'conv-2', 1)];
    directoryRows.push(directoryRow('conv-1'), directoryRow('conv-2'));
  });

  it('announces once for the thread a drop removed, and for no other', async () => {
    const result = await write({ drop: ['pane-b'] });
    expect(result.status).toBe('ok');

    expect(mockConversationClosed).toHaveBeenCalledTimes(1);
    expect(mockConversationClosed).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv-2', rev: 7 }));
  });

  it('announces NOTHING for a hand-off — the same thread on a different node', async () => {
    // THE CASE A `drop`-shaped implementation gets wrong. The write drops
    // `pane-b` and puts `pane-c` holding the same conversation; the thread
    // never left the workspace, so telling every subscriber it closed would be
    // a lie the sidebar acts on.
    const result = await write({
      drop: ['pane-b'],
      put: [chatPane('pane-c', 'conv-2', 1)],
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.changed).toBe(true);
    expect(mockConversationClosed).not.toHaveBeenCalled();
  });

  it('announces nothing on a REPLAY — no rev, no broadcast, no announcement', async () => {
    await write({ drop: ['pane-b'] });
    expect(mockConversationClosed).toHaveBeenCalledTimes(1);

    const replay = await write({ drop: ['pane-b'] });
    expect(replay.status).toBe('ok');
    if (replay.status !== 'ok') return;
    expect(replay.changed).toBe(false);
    // Still one: the second POST produced the tree already stored, so it minted
    // no rev, broadcast nothing, and owes the directory plane nothing either.
    expect(mockConversationClosed).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
  });

  it('announces nothing for a write that ROLLED BACK', async () => {
    // A refusal raised after the decision — the write unwinds, so there is no
    // membership change to announce. Announcing from inside the transaction
    // would have shipped this one.
    authorize.allow = false;
    const result = await write({
      drop: ['pane-b'],
      put: [chatPane('pane-c', 'conv-new', 1)],
    });
    expect(result.status).toBe('refused');
    expect(store.writes).toEqual([]);
    expect(mockConversationClosed).not.toHaveBeenCalled();
  });

  it('announces for every thread an end-session destroyed', async () => {
    // The producer that never announced AT ALL under the old shape: ending a
    // session goes nowhere near the close route.
    const result = await destroyWorkspaceTree({ workspaceId: WORKSPACE, actingUserId: VIEWER });
    expect(result.status).toBe('ok');

    expect(mockConversationClosed).toHaveBeenCalledTimes(2);
    expect(
      mockConversationClosed.mock.calls.map(([ctx]) => ctx.conversationId).sort(),
    ).toEqual(['conv-1', 'conv-2']);
  });

  it('announces nothing when the transaction fails AT COMMIT', async () => {
    // The seam between reading inside the transaction and emitting after it.
    // Every other refusal in this funnel throws before the directory read is
    // reached; this one lets the whole body run and then fails, so an emit
    // placed beside the read would ship a `conversation:closed` for a removal
    // that rolled back — telling every subscriber a thread had left a workspace
    // it is still in, with nothing to correct it but the 120s poll.
    store.throwOnCommit = new Error('commit failed');

    await expect(write({ drop: ['pane-b'] })).rejects.toThrow('commit failed');

    expect(store.nodes.map((node) => node.id)).toEqual(['root', 'pane-a', 'pane-b']);
    expect(mockConversationClosed).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('announces nothing for a pure layout write that removed no thread', async () => {
    const result = await write({ put: [chatPane('pane-a', 'conv-1', 1), chatPane('pane-b', 'conv-2', 0)] });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.changed).toBe(true);
    expect(mockConversationClosed).not.toHaveBeenCalled();
  });
});

/**
 * THE FIRST WRITE TO AN EMPTY WORKSPACE, which is where the two seeds meet.
 *
 * A workspace with no tree is seeded by whichever write first needs a root, and
 * BOTH ends mint one — the browser so its optimistic tree has somewhere to put
 * a pane, and this funnel inside the lock so the write is legal whatever the
 * client sent. `rootSeedFor` makes them the same node, which is what the
 * deterministic id is for, and they arrive in ONE `put`, where the convergence
 * has to be a property of the write decision rather than of the upsert. It
 * wasn't: both copies reached the validator and every first command against an
 * empty workspace came back `duplicate_id` — a 400 the client's queue treats as
 * unrecoverable, so it discarded the pending writes and resynced.
 */
describe('the root seed the CLIENT also sent', () => {
  beforeEach(() => {
    store.rev = 0;
    store.nodes = [];
  });

  it('lands as one root, not a refusal', async () => {
    const seed = rootSeedFor(WORKSPACE);
    const result = await write({ baseRev: 0, put: [seed, pane('pane-new', WORKSPACE, 0)] });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.snapshot.nodes.filter((node) => node.nodeType === 'root')).toHaveLength(1);
    expect(store.nodes.filter((node) => node.nodeType === 'root')).toHaveLength(1);
  });

  it('reaches the store once — one statement cannot carry one key twice', async () => {
    const seed = rootSeedFor(WORKSPACE);
    await write({ baseRev: 0, put: [seed, pane('pane-new', WORKSPACE, 0)] });
    expect(store.writes).toHaveLength(1);
    const ids = store.writes[0]!.put.map((node) => node.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it('is the same tree the client would have got had it sent no seed at all', async () => {
    const seeded = await write({ baseRev: 0, put: [rootSeedFor(WORKSPACE), pane('pane-new', WORKSPACE, 0)] });
    const first = store.nodes;

    store.rev = 0;
    store.nodes = [];
    store.writes = [];
    const bare = await write({ baseRev: 0, put: [pane('pane-new', WORKSPACE, 0)] });

    expect(seeded.status).toBe('ok');
    expect(bare.status).toBe('ok');
    expect(first).toEqual(store.nodes);
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
    // `ownerId` is routing, not content: it names the second ROOM the event
    // goes to (the owner's own directory plane, so a workspace nobody has open
    // still updates its sidebar rows) and is stripped before the payload is
    // emitted — see `broadcastWorkspaceNodesUpdated`.
    expect(Object.keys(payload).sort()).toEqual(['nodes', 'ownerId', 'rev', 'workspaceId']);
    expect(payload.ownerId).toBe(VIEWER);
    // Both rooms carry the same STRUCTURAL payload — one reaches every member
    // of a shared workspace at once, so there is no viewer to redact for and a
    // title has no business on this wire.
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
      {
        id: 'conv-1',
        kind: 'chat',
        title: 'Planning',
        lastMessageAt: '2026-01-02T03:04:05.000Z',
        // Derived by the SHARED `conversationPageId` rule, behind the same gate
        // the title passed — the pane header's only route to its agent now that
        // there is no `PaneScope` to carry one.
        agentPageId: 'page-9',
      },
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
      { id: 'conv-1', kind: 'chat', title: '(private thread)', lastMessageAt: null, agentPageId: null },
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
      { id: 'conv-mine', kind: 'chat', title: 'Planning', lastMessageAt: null, agentPageId: null },
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

/**
 * THE LIVENESS BACKSTOP — the third global question about a chat target, after
 * "may this caller show it" and "will the table let anyone".
 *
 * Every admission path asks it before taking the lock, and a history-delete
 * fits in that window: `expelConversationFromSession` removes the node under
 * the lock and RELEASES it before `softDeleteConversation` flips `isActive`, so
 * in between the thread is homeless and still active — exactly what a claim
 * admits. Asked on the writing transaction, there is no window left.
 */
describe('a chat target whose thread has been DELETED', () => {
  it('is a typed refusal, and writes nothing', async () => {
    chatBindings.deleted = ['conv-1'];
    const result = await write({ put: [pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-1' })] });

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.code).toBe('target_deleted');
    expect(result.detail).toContain('conv-1');
    expect(store.writes).toEqual([]);
    expect(store.rev).toBe(3);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('is asked ONLY about targets the write INTRODUCES', async () => {
    // The containment rule the ACL gate already lives by, and here it is what
    // keeps a pane whose thread died under it movable and CLOSABLE — closing
    // re-sends the node, so checking the whole payload would make the pane
    // permanent.
    store.nodes = [root, pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-1' })];
    chatBindings.deleted = ['conv-1'];
    const result = await write({ put: [pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-1' })] });

    expect(result.status).toBe('ok');
    expect(chatBindings.livenessAsked).toEqual([]);
  });

  it('lets a workspace holding a DEAD thread still open a new pane — containment, on a write that actually changes something', async () => {
    // THE PROBE THE TEST ABOVE CANNOT BE. Its write re-sends an identical node,
    // so `decision.persist.put` is EMPTY and nothing is asked about anything —
    // it passes whether liveness is scoped to INTRODUCED targets or widened to
    // the whole payload. That mutation survived a review of this file (`M4`);
    // the assertion that claims to pin containment could not see it.
    //
    // This write CHANGES the tree, so the payload is non-empty and carries the
    // dead thread's node alongside the live newcomer. Scoped to introduced, only
    // `conv-live` is asked about and the write lands. Widened to the payload,
    // the long-dead `conv-1` refuses it — which is the user-visible shape of the
    // bug: one thread dies under a pane and the workspace can never open another
    // chat pane again.
    store.nodes = [root, pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-1' })];
    chatBindings.deleted = ['conv-1'];

    const result = await write({
      put: [
        pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-1' }),
        pane('pane-new', 'root', 1, { kind: 'chat', id: 'conv-live' }),
      ],
    });

    expect(result.status).toBe('ok');
    // Only the newcomer was ever the subject of the question.
    expect(chatBindings.livenessAsked).toEqual([['conv-live']]);
  });

  it('runs AFTER the ACL gate, so a refusal never confirms a conversation the caller may not touch', async () => {
    // Same oracle argument as the holder check above: "that thread is deleted"
    // is a fact about a conversation, and a caller with no authority over it
    // must not learn it. The 403 wins.
    authorize.allow = false;
    chatBindings.deleted = ['conv-1'];
    const result = await write({ put: [pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-1' })] });

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result.code).toBe('forbidden_target');
    expect(chatBindings.livenessAsked).toEqual([]);
  });

  it('is not asked at all by a write that binds no chat target', async () => {
    const result = await write({ put: [pane('pane-a', 'root', 0)] });
    expect(result.status).toBe('ok');
    expect(chatBindings.livenessAsked).toEqual([]);
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

  it('reports a chat-target unique violation as a CONFLICT carrying the truth to rebase against', async () => {
    // Two workspaces raced for one conversation, and only the global index was
    // in a position to settle it. It is matched on the constraint NAME rather
    // than the message, because the message is a Postgres locale string.
    //
    // This asserted `{status: 'refused', code: 'bound_elsewhere'}`, which this
    // funnel could not produce: the write path's own backstop matches the same
    // index and unwraps the driver's `cause` chain, so it always answered first
    // and the local translation was dead code. The membership callers read
    // `conflict` and give it their own name.
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

    expect(result.status).toBe('conflict');
    if (result.status !== 'conflict') return;
    expect(result.code).toBe('target_already_shown');
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


/**
 * ENDING A SESSION IS `destroy(root)` — the tree's own removal, pointed at the
 * top of the tree instead of at a pane.
 *
 * This is the correction the epic's node-tree cutover missed. `destroy` refused
 * the root (`root_immutable`), which did not stop sessions ending — it moved
 * ending one into a SECOND lifecycle mechanism beside the tree, two removals
 * with two meanings reconciled by convention.
 */
describe('destroyWorkspaceTree', () => {
  it('drops the root and its whole subtree, leaving no nodes at all', async () => {
    store.nodes = [
      root,
      { nodeType: 'split', id: 'col', parentId: 'root', position: 0, axis: 'column' },
      pane('pane-a', 'col', 0),
      pane('pane-b', 'col', 1),
    ];

    const result = await destroyWorkspaceTree({ workspaceId: WORKSPACE, actingUserId: VIEWER });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.changed).toBe(true);
    expect(store.nodes).toEqual([]);
    expect(store.writes[0].drop.slice().sort()).toEqual(['col', 'pane-a', 'pane-b', 'root']);
  });

  it('does NOT seed a root in order to destroy it', async () => {
    // The funnel mints a root for any command that needs one to place into.
    // Seeding here would put the seed in `put` and its id in `drop`, which the
    // decision resolves as "put wins" — so ending a session that had no tree
    // would CREATE one. The write must be empty instead.
    store.nodes = [];

    const result = await destroyWorkspaceTree({ workspaceId: WORKSPACE, actingUserId: VIEWER });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.changed).toBe(false);
    expect(store.nodes).toEqual([]);
    expect(store.writes).toEqual([]);
  });

  it('is idempotent — a re-issued end writes nothing the second time', async () => {
    await destroyWorkspaceTree({ workspaceId: WORKSPACE, actingUserId: VIEWER });
    store.writes = [];

    const again = await destroyWorkspaceTree({ workspaceId: WORKSPACE, actingUserId: VIEWER });

    expect(again.status).toBe('ok');
    if (again.status !== 'ok') return;
    expect(again.changed).toBe(false);
    expect(store.writes).toEqual([]);
  });

  it('broadcasts the empty tree, so every client stops rendering the session', async () => {
    await destroyWorkspaceTree({ workspaceId: WORKSPACE, actingUserId: VIEWER });
    expect(mockBroadcast).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE, nodes: [] }));
  });
});
