// @vitest-environment node
/**
 * SERVER-RESOLVED placement and rearrangement — the policy port.
 *
 * The two deleted suites this replaces (`workspace-placement.test.ts` and
 * `workspace-placement-worker.test.ts`) pinned a policy, not an implementation,
 * so the policy is what is pinned here: an agent ADDS a surface beside what the
 * user is doing and never navigates their panes, only an unbound pane may be
 * filled, the invoking conversation's own node is never a candidate, a running
 * shell is never given up, the page ACL is checked against the ACTING USER, and
 * a layout write never fails the model's actual work.
 *
 * What is deliberately NOT pinned here is the rebase loop, because there is no
 * longer one to pin: a command is resolved against the tree the lock read, so
 * there is no snapshot to be stale against and no attempt budget to exhaust.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PaneTarget, WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';

const WORKSPACE = 'ws-1';
const ACTOR = 'user-1';
const CALLER_CONVERSATION = 'conv-caller';

const { runtime, access, rows, logged } = vi.hoisted(() => ({
  runtime: {
    nodes: [] as WorkspaceNode[],
    applied: [] as Array<{ put: WorkspaceNode[]; drop: string[] }>,
    throws: false,
  },
  access: { level: 'VIEW' as string | null },
  rows: { conversationWorkspaceId: 'ws-1' as string | null },
  logged: { warns: [] as unknown[], errors: [] as unknown[] },
}));

vi.mock('../workspace-node-runtime', () => ({
  applyWorkspaceNodeCommand: async (input: {
    workspaceId: string;
    actingUserId: string;
    run: (nodes: readonly WorkspaceNode[]) => { ok: boolean; write?: { put: WorkspaceNode[]; drop: string[] }; code?: string; detail?: string };
  }) => {
    if (runtime.throws) throw new Error('database is on fire');
    const result = input.run(runtime.nodes);
    if (!result.ok) return { status: 'refused' as const, code: result.code, detail: result.detail };
    const write = result.write ?? { put: [], drop: [] };
    runtime.applied.push(write);
    const changed = write.put.length > 0 || write.drop.length > 0;
    return { status: 'ok' as const, snapshot: { rev: 1, nodes: runtime.nodes, targets: [] }, changed };
  },
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (rows.conversationWorkspaceId === null ? [] : [{ workspaceId: rows.conversationWorkspaceId }]) }) }),
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: () => ({}) }));
vi.mock('@pagespace/db/schema/conversations', () => ({ conversations: {} }));
vi.mock('@pagespace/lib/permissions/permissions', () => ({ getUserAccessLevel: async () => access.level }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: {
      warn: (...args: unknown[]) => logged.warns.push(args),
      error: (...args: unknown[]) => logged.errors.push(args),
    },
  },
}));

const { layoutCommand, placePagePaneForConversation, placeWorkerPane } = await import('../workspace-node-placement');

const root: WorkspaceNode = { nodeType: 'root', id: 'root', parentId: null, position: 0, axis: 'row' };
const pane = (
  id: string,
  parentId: string,
  position: number,
  target: PaneTarget | null = null,
  fraction?: number,
): WorkspaceNode => ({
  nodeType: 'pane',
  id,
  parentId,
  position,
  target,
  ...(fraction === undefined ? {} : { fraction }),
});

beforeEach(() => {
  vi.clearAllMocks();
  runtime.nodes = [];
  runtime.applied = [];
  runtime.throws = false;
  access.level = 'VIEW';
  rows.conversationWorkspaceId = WORKSPACE;
  logged.warns = [];
  logged.errors = [];
});

/**
 * The pane the user was looking at came through the write UNTOUCHED — not
 * dropped, and still showing what it showed.
 *
 * "Absent from `put` entirely" is the ordinary answer since the placement
 * started PACKING (#2469): when the newcomer joins the container the pane is
 * already in, nothing about the sitting pane changes, so the write does not
 * name it at all. It used to be reparented under a freshly minted container,
 * which is why these assertions could once read it straight out of `put`. A
 * write is `put` ∪ `drop`; a node in neither is a node nothing happened to.
 */
function paneUntouched(write: { put: WorkspaceNode[]; drop: string[] } | undefined, nodeId: string, target: { kind: string; id: string }): void {
  expect(write).toBeDefined();
  if (!write) return;
  expect(write.drop).not.toContain(nodeId);
  const rewritten = write.put.find((node) => node.id === nodeId);
  if (rewritten !== undefined) expect(rewritten).toMatchObject({ target });
}

/** Every pane the last applied write left bound, by target. */
function boundTargets(): string[] {
  const write = runtime.applied.at(-1);
  if (!write) return [];
  return write.put
    .filter((node): node is Extract<WorkspaceNode, { nodeType: 'pane' }> => node.nodeType === 'pane')
    .map((node) => (node.target === null ? 'unbound' : `${node.target.kind}:${node.target.id}`));
}

describe('open_page_pane: an agent ADDS a surface and never navigates the user panes', () => {
  it('fills an UNBOUND pane, because that is a rectangle the user has said nothing about', async () => {
    runtime.nodes = [root, pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-other' }, 0.5), pane('pane-b', 'root', 1, null, 0.5)];
    await placePagePaneForConversation({ conversationId: CALLER_CONVERSATION, pageId: 'page-1', viewerId: ACTOR });
    expect(boundTargets()).toEqual(['page:page-1']);
    // The bound pane was left exactly alone — nothing was evicted.
    expect(runtime.applied.at(-1)?.drop).toEqual([]);
    expect(runtime.applied.at(-1)?.put.map((node) => node.id)).toEqual(['pane-b']);
  });

  it('SPLITS rather than take a bound pane away when nothing is unbound', async () => {
    runtime.nodes = [root, pane('pane-a', 'root', 0, { kind: 'chat', id: 'conv-other' })];
    await placePagePaneForConversation({ conversationId: CALLER_CONVERSATION, pageId: 'page-1', viewerId: ACTOR });
    const write = runtime.applied.at(-1);
    expect(write).toBeDefined();
    if (!write) return;
    // The newcomer arrived BESIDE it — packed into the root, which already runs
    // that way, so no container was minted (#2469) — and the pane the user was
    // looking at still shows what it showed.
    expect(boundTargets()).toContain('page:page-1');
    expect(write.drop).toEqual([]);
    paneUntouched(write, 'pane-a', { kind: 'chat', id: 'conv-other' });
  });

  it('never evicts the INVOKING conversation', async () => {
    // Two guards hold here and only one is load-bearing in this shape:
    // `preferSplit` already refuses every BOUND pane, so `excludeTargetId` is
    // the belt to its braces. The property pinned is the outcome the tool
    // promises — a tool call never eats its own invoker — not which of the two
    // said no.
    runtime.nodes = [root, pane('pane-a', 'root', 0, { kind: 'chat', id: CALLER_CONVERSATION })];
    await placePagePaneForConversation({ conversationId: CALLER_CONVERSATION, pageId: 'page-1', viewerId: ACTOR });
    paneUntouched(runtime.applied.at(-1), 'pane-a', { kind: 'chat', id: CALLER_CONVERSATION });
    expect(boundTargets()).toContain('page:page-1');
  });

  it('never gives up a running shell — the PTY loses its only surface and there is no reattach', async () => {
    runtime.nodes = [root, pane('pane-a', 'root', 0, { kind: 'terminal', id: 'shell-1' })];
    await placePagePaneForConversation({ conversationId: CALLER_CONVERSATION, pageId: 'page-1', viewerId: ACTOR });
    paneUntouched(runtime.applied.at(-1), 'pane-a', { kind: 'terminal', id: 'shell-1' });
    expect(boundTargets()).toContain('page:page-1');
  });

  it('leaves a page already on screen exactly where it is — idempotent by POLICY, not by an opId', async () => {
    runtime.nodes = [root, pane('pane-a', 'root', 0, { kind: 'page', id: 'page-1' })];
    await placePagePaneForConversation({ conversationId: CALLER_CONVERSATION, pageId: 'page-1', viewerId: ACTOR });
    // This is what retired the `(workspaceId, opId)` memory row: the SDK's retry
    // of one tool call writes nothing because there is nothing left to do.
    expect(runtime.applied.at(-1)).toEqual({ put: [], drop: [] });
  });
});

describe('open_page_pane: the ACL gate is on the ACTING USER', () => {
  it('refuses a page the acting user cannot view, and writes nothing', async () => {
    access.level = null;
    runtime.nodes = [root, pane('pane-a', 'root', 0)];
    await placePagePaneForConversation({ conversationId: CALLER_CONVERSATION, pageId: 'secret-page', viewerId: ACTOR });
    // `pageId` came from the MODEL. Without this, a prompt-injected agent naming
    // ids it should not know turns the pane into a title-exfiltration channel.
    expect(runtime.applied).toEqual([]);
    expect(JSON.stringify(logged.warns)).toContain('secret-page');
  });

  it('is a harmless no-op for a conversation bound to no workspace', async () => {
    rows.conversationWorkspaceId = null;
    await placePagePaneForConversation({ conversationId: CALLER_CONVERSATION, pageId: 'page-1', viewerId: ACTOR });
    expect(runtime.applied).toEqual([]);
  });
});

describe('a layout write is best-effort: it must never fail the model actual work', () => {
  it('swallows a thrown write and logs it', async () => {
    runtime.throws = true;
    runtime.nodes = [root];
    await expect(
      placePagePaneForConversation({ conversationId: CALLER_CONVERSATION, pageId: 'page-1', viewerId: ACTOR }),
    ).resolves.toBeUndefined();
    expect(logged.errors.length).toBe(1);
  });

  it('swallows a thrown worker placement too — the spawn has already succeeded', async () => {
    runtime.throws = true;
    await expect(
      placeWorkerPane({ workspaceId: WORKSPACE, conversationId: 'conv-worker', actingUserId: ACTOR }),
    ).resolves.toBeUndefined();
    expect(logged.errors.length).toBe(1);
  });
});

describe('spawn_session: the worker gets a pane in the workspace it was placed into', () => {
  it('places into an empty workspace, which is now an ordinary state rather than a create', async () => {
    runtime.nodes = [root];
    await placeWorkerPane({ workspaceId: WORKSPACE, conversationId: 'conv-worker', actingUserId: ACTOR });
    expect(boundTargets()).toEqual(['chat:conv-worker']);
  });

  it('never evicts the SPAWNING conversation', async () => {
    runtime.nodes = [root, pane('pane-a', 'root', 0, { kind: 'chat', id: CALLER_CONVERSATION })];
    await placeWorkerPane({
      workspaceId: WORKSPACE,
      conversationId: 'conv-worker',
      actingUserId: ACTOR,
      excludeTargetId: CALLER_CONVERSATION,
    });
    paneUntouched(runtime.applied.at(-1), 'pane-a', { kind: 'chat', id: CALLER_CONVERSATION });
    expect(boundTargets()).toContain('chat:conv-worker');
  });
});

describe('the rearrange commands', () => {
  const twoColumns = (): WorkspaceNode[] => [
    root,
    pane('a', 'root', 0, null, 0.5),
    pane('b', 'root', 1, null, 0.25),
    pane('c', 'root', 2, null, 0.25),
  ];

  it('move with no index APPENDS, resolved against the live tree rather than guessed', async () => {
    // The algebra REFUSES an out-of-range slot instead of clamping it, so
    // "append" has to be a real slot in the destination as it is right now.
    const result = layoutCommand({ type: 'move', nodeId: 'a', parentId: 'root' })(twoColumns());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.write.put.find((node) => node.id === 'a')).toMatchObject({ position: 2 });
  });

  it('move only ever RELOCATES — there is no destination outside the tree', async () => {
    // `parentId: null` used to be a legal destination and meant PARK: out of the
    // layout, still in the workspace. `LayoutCommandInput`'s `parentId` is a
    // `string` now, so the tool cannot spell it and the model cannot hold it.
    // Taking a pane away is a destroy.
    const result = layoutCommand({ type: 'move', nodeId: 'c', parentId: 'root', index: 0 })(twoColumns());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.write.put.find((node) => node.id === 'c')).toMatchObject({ parentId: 'root', position: 0 });
    expect(result.write.drop).toEqual([]);
  });

  it('move to an out-of-range slot is REFUSED, never clamped', async () => {
    const result = layoutCommand({ type: 'move', nodeId: 'a', parentId: 'root', index: 99 })(twoColumns());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_index');
  });

  it('close DESTROYS the pane — the capability the null destination used to carry', async () => {
    // An agent's only way to take a pane off the grid was
    // `move_pane(toParentId: null)`, which PARKED it. Removing that destination
    // without this verb would have left agents able to rearrange a layout and
    // unable to close anything in it.
    const result = layoutCommand({ type: 'close', nodeId: 'b' })(twoColumns());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.write.drop).toEqual(['b']);
    expect(result.write.put.some((node) => node.id === 'b')).toBe(false);
  });

  it('close refuses the ROOT, so an agent cannot end a session by closing a pane', async () => {
    // `destroy(root)` genuinely ends the session — that is the correction at the
    // top of the tree. This command is named for panes, and going through the
    // COMMAND rather than straight to the algebra is what makes an agent's
    // mis-aimed close a refusal rather than a session nobody asked to end.
    const result = layoutCommand({ type: 'close', nodeId: 'root' })(twoColumns());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('root_immutable');
  });

  it('close refuses a CONTAINER, because closing a column is not closing a pane', async () => {
    const nested: WorkspaceNode[] = [
      root,
      { nodeType: 'split', id: 's1', parentId: 'root', position: 0, axis: 'column' },
      pane('a', 's1', 0, null),
      pane('b', 's1', 1, null),
    ];
    const result = layoutCommand({ type: 'close', nodeId: 's1' })(nested);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_a_pane');
  });

  it('arrange puts the named ids first and leaves the rest in their relative order', async () => {
    const result = layoutCommand({ type: 'arrange', nodeIds: ['c'] })(twoColumns());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const positions = new Map(result.write.put.map((node) => [node.id, node.position]));
    expect(positions.get('c')).toBe(0);
    expect(positions.get('a')).toBe(1);
    expect(positions.get('b')).toBe(2);
  });

  it('arrange defaults to the ROOT children, found by TYPE and not by a null parent', async () => {
    // A ROW can carry a null parent without being a root, so "the node with no
    // parent" is still not what identifies one — it is just no longer a state
    // any legitimate write produces.
    const result = layoutCommand({ type: 'arrange', nodeIds: ['b'] })(twoColumns());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const positions = new Map(result.write.put.map((node) => [node.id, node.position]));
    expect(positions.get('b')).toBe(0);
  });

  it('arrange SKIPS an id that is not a child of that container rather than failing the call', async () => {
    // Ids change as panes open and close; failing a whole rearrange because one
    // of four went stale would make the tool unusable exactly when a workspace
    // is busy. A model ergonomics decision, made at this layer — emphatically
    // not the algebra clamping a bad index, which stays refused above.
    const result = layoutCommand({ type: 'arrange', nodeIds: ['ghost', 'c'] })(twoColumns());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.write.put.find((node) => node.id === 'c')).toMatchObject({ position: 0 });
  });

  it('arrange is ONE write, so no intermediate order is ever published', async () => {
    const result = layoutCommand({ type: 'arrange', nodeIds: ['c', 'b', 'a'] })(twoColumns());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const positions = new Map(result.write.put.map((node) => [node.id, node.position]));
    expect([...positions.entries()].sort()).toEqual([
      ['a', 2],
      ['b', 1],
      ['c', 0],
    ]);
  });

  it('arrange on a container that does not exist is refused', async () => {
    const result = layoutCommand({ type: 'arrange', parentId: 'ghost', nodeIds: ['a'] })(twoColumns());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unknown_parent');
  });

  it('resize refuses a node that is alone in its parent — it already fills it', async () => {
    const result = layoutCommand({ type: 'resize', nodeId: 'a', fraction: 0.5 })([root, pane('a', 'root', 0)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_sizable');
  });
});
