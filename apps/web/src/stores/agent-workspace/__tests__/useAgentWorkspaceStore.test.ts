/**
 * The store's own job: adopting server truth, keeping local edits alive across
 * it, the CLIENT-ONLY guards the shared placement policy deliberately cannot
 * evaluate, and — the whole reason this suite exists in this shape — not
 * believing things it should not believe.
 *
 * The layout RULES are the algebra's and are tested there. What is pinned here
 * is everything a browser can be handed that a server never sees: a broadcast
 * for a workspace that was just forgotten, one at a rev already held, the same
 * event twice, a pending write whose target somebody else destroyed, a body that
 * is not a tree, an empty grid, and a workspace with no root yet.
 *
 * Unless a test says otherwise the transport NEVER settles, so what the
 * assertions read is the optimistic apply — what the user sees the instant they
 * click, before any server has answered.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAgentWorkspaceStore, __resetWorkspaceQueuesForTests } from '../useAgentWorkspaceStore';
import type { WorkspaceNode } from '@pagespace/lib/agent-workspaces/workspace-node';
import type { WorkspaceNodeSnapshotResponse } from '@pagespace/lib/agent-workspaces/workspace-node-wire';
import { useEditingStore } from '@/stores/useEditingStore';

const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

const WS = 'ws-1';

/** The root a workspace is seeded with — deterministic, from the workspace id. */
const root: WorkspaceNode = { nodeType: 'root', id: WS, parentId: null, position: 0, axis: 'row' };

function pane(id: string, parentId: string, position: number, chatId?: string): WorkspaceNode {
  return {
    nodeType: 'pane',
    id,
    parentId,
    position,
    target: chatId === undefined ? null : { kind: 'chat', id: chatId },
  };
}

function snapshot(
  rev: number,
  nodes: WorkspaceNode[],
  targets: WorkspaceNodeSnapshotResponse['targets'] = [],
): WorkspaceNodeSnapshotResponse {
  return { rev, nodes, targets };
}

const store = () => useAgentWorkspaceStore.getState();
const tree = (id = WS) => store().workspaces[id];

/** A `Response` shim carrying a JSON body — enough for the store's parse path. */
function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  mockFetchWithAuth.mockReset();
  mockFetchWithAuth.mockImplementation(() => new Promise<Response>(() => {}));
  __resetWorkspaceQueuesForTests();
  useAgentWorkspaceStore.setState({ workspaces: {}, sync: {}, focus: {}, queueErrors: {} });
  useEditingStore.getState().clearAllSessions();
});

describe('hydrateFromServer', () => {
  it('should seat a tree and its resolved titles', () => {
    store().hydrateFromServer(
      WS,
      snapshot(3, [root, pane('p1', WS, 0, 'c1')], [
        { id: 'c1', kind: 'chat', title: 'Planning', lastMessageAt: null, agentPageId: 'agent-1' },
      ]),
    );
    expect(tree().rev).toBe(3);
    expect(tree().nodes).toHaveLength(2);
    expect(tree().targets[0].title).toBe('Planning');
    expect(tree().activeNodeId).toBe('p1');
  });

  /**
   * THE NO-OP EARLY-OUT. The sidebar seats every listed workspace on every
   * revalidation; a fresh object per revalidation re-renders every tree in the
   * app twice a minute.
   */
  it('should return the SAME object for an identical re-seat', () => {
    const first = snapshot(3, [root, pane('p1', WS, 0, 'c1')], [
      { id: 'c1', kind: 'chat', title: 'Planning', lastMessageAt: null, agentPageId: null },
    ]);
    store().hydrateFromServer(WS, first);
    const before = tree();

    // A DIFFERENT object graph carrying the same facts, as a re-fetch produces.
    store().hydrateFromServer(
      WS,
      snapshot(3, [root, pane('p1', WS, 0, 'c1')], [
        { id: 'c1', kind: 'chat', title: 'Planning', lastMessageAt: null, agentPageId: null },
      ]),
    );

    expect(tree()).toBe(before);
  });

  it('should still adopt a RENAME at an unchanged rev — a title is not part of the rev', () => {
    store().hydrateFromServer(WS, snapshot(3, [root, pane('p1', WS, 0, 'c1')], [
      { id: 'c1', kind: 'chat', title: 'Planning', lastMessageAt: null, agentPageId: null },
    ]));
    store().hydrateFromServer(WS, snapshot(3, [root, pane('p1', WS, 0, 'c1')], [
      { id: 'c1', kind: 'chat', title: 'Renamed', lastMessageAt: null, agentPageId: null },
    ]));
    expect(tree().targets[0].title).toBe('Renamed');
  });

  it('should ignore a snapshot OLDER than the one it holds', () => {
    store().hydrateFromServer(WS, snapshot(5, [root, pane('p1', WS, 0, 'c1')]));
    store().hydrateFromServer(WS, snapshot(4, [root]));
    expect(tree().rev).toBe(5);
    expect(tree().nodes).toHaveLength(2);
  });

  it('should refuse a body that is not a valid tree, rather than adopt it as a base', () => {
    const twoRoots: WorkspaceNode[] = [root, { nodeType: 'root', id: 'other', parentId: null, position: 0, axis: 'row' }];
    store().hydrateFromServer(WS, snapshot(1, twoRoots));
    expect(tree()).toBeUndefined();
  });

  it('should seat an EMPTY tree — a workspace that has never been written', () => {
    store().hydrateFromServer(WS, snapshot(0, []));
    expect(tree()).toBeDefined();
    expect(tree().nodes).toEqual([]);
    expect(tree().activeNodeId).toBeNull();
  });

  it('should seat an EMPTY GRID — a root holding nothing is a resting state', () => {
    store().hydrateFromServer(WS, snapshot(7, [root]));
    expect(tree().nodes).toEqual([root]);
    expect(tree().activeNodeId).toBeNull();
  });
});

describe('applyRemoteUpdate', () => {
  it('should adopt a newer tree', () => {
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    store().applyRemoteUpdate({ workspaceId: WS, rev: 2, nodes: [root, pane('p1', WS, 0, 'c1'), pane('p2', WS, 1, 'c2')] });
    expect(tree().rev).toBe(2);
    expect(tree().nodes).toHaveLength(3);
  });

  /** A workspace the store has just forgotten must NOT come back. */
  it('should not resurrect a workspace it is no longer tracking', () => {
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    store().forgetWorkspace(WS);
    store().applyRemoteUpdate({ workspaceId: WS, rev: 9, nodes: [root, pane('p1', WS, 0, 'c1')] });
    expect(tree()).toBeUndefined();
  });

  it('should never seat a workspace it has never seen', () => {
    store().applyRemoteUpdate({ workspaceId: 'never-opened', rev: 1, nodes: [root] });
    expect(store().workspaces['never-opened']).toBeUndefined();
  });

  it('should drop an event at a rev it already holds', () => {
    store().hydrateFromServer(WS, snapshot(4, [root, pane('p1', WS, 0, 'c1')]));
    const before = tree();
    store().applyRemoteUpdate({ workspaceId: WS, rev: 4, nodes: [root] });
    expect(tree()).toBe(before);
  });

  /**
   * DOUBLE DELIVERY. The owner of a workspace whose grid is also mounted is in
   * BOTH rooms, so the same write arrives twice. The rev guard is armed
   * synchronously by the first, which is what makes the second free.
   */
  it('should apply the same event delivered on both rooms exactly once', () => {
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    const event = { workspaceId: WS, rev: 2, nodes: [root, pane('p1', WS, 0, 'c1'), pane('p2', WS, 1, 'c2')] };
    store().applyRemoteUpdate(event);
    const afterFirst = tree();
    store().applyRemoteUpdate(event);
    expect(tree()).toBe(afterFirst);
    expect(tree().nodes).toHaveLength(3);
  });

  it('should refuse a broadcast whose tree is invalid', () => {
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    store().applyRemoteUpdate({ workspaceId: WS, rev: 2, nodes: [pane('orphan', 'gone', 0, 'c9')] });
    expect(tree().rev).toBe(1);
  });

  it('should refuse a broadcast carrying a pane with NO parent, which a row can still spell', () => {
    // `null_parent`. Under the previous model this was a legal member and the
    // client would have adopted it as truth — a node it would then never draw.
    const parentless = { nodeType: 'pane', id: 'lost', parentId: null, position: 0, target: null } as unknown as WorkspaceNode;
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    store().applyRemoteUpdate({ workspaceId: WS, rev: 2, nodes: [root, parentless] });
    expect(tree().rev).toBe(1);
  });
});

describe('local writes survive new server truth', () => {
  it('should replay a pending split on top of an adopted snapshot', () => {
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    store().splitPane(WS, 'p1', 'row');
    expect(tree().nodes.filter((n) => n.nodeType === 'pane')).toHaveLength(2);

    // Somebody else adds a pane; our split has not been acked.
    store().applyRemoteUpdate({
      workspaceId: WS,
      rev: 2,
      nodes: [root, pane('p1', WS, 0, 'c1'), pane('remote', WS, 1, 'c2')],
    });

    const panes = tree().nodes.filter((n) => n.nodeType === 'pane');
    // p1, the split's new pane, and the remote one.
    expect(panes).toHaveLength(3);
    expect(panes.some((n) => n.id === 'remote')).toBe(true);
  });

  /**
   * THE RESURRECTION CASE. A pending edit to a node the server destroyed must be
   * DROPPED, not upserted back — and the user has to be told, because their edit
   * is gone.
   */
  it('should drop a pending write whose node the server destroyed, and flag it', () => {
    // A pending edit TO a node — not a removal of it — is the case that matters:
    // replaying it onto a tree the node has left would UPSERT it back, a pane
    // somebody else destroyed returning with its binding intact.
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1'), pane('p2', WS, 1, 'c2')]));
    store().splitPane(WS, 'p2', 'row');
    expect(tree().nodes.some((n) => n.id === 'p2')).toBe(true);

    // The server's truth: p2 is gone entirely.
    store().applyRemoteUpdate({ workspaceId: WS, rev: 2, nodes: [root, pane('p1', WS, 0, 'c1')] });

    expect(tree().nodes.some((n) => n.id === 'p2')).toBe(false);
    expect(store().queueErrors[WS]?.reason).toBe('superseded');
  });
});

describe('the root seed', () => {
  it('should mint a root from the WORKSPACE ID on the first write into an empty tree', () => {
    store().hydrateFromServer(WS, snapshot(0, []));
    store().openConversation(WS, 'c1');
    const seeded = tree().nodes.find((n) => n.nodeType === 'root');
    expect(seeded?.id).toBe(WS);
    expect(tree().nodes.filter((n) => n.nodeType === 'pane')).toHaveLength(1);
  });

  it('should send the seed in the write, so the server is not asked to parent onto nothing', async () => {
    store().hydrateFromServer(WS, snapshot(0, []));
    store().openConversation(WS, 'c1');
    await Promise.resolve();
    const body = JSON.parse(mockFetchWithAuth.mock.calls[0][1].body as string);
    expect(body.put.some((node: WorkspaceNode) => node.nodeType === 'root' && node.id === WS)).toBe(true);
  });

  it('should not mint a second root when one already exists under another id', () => {
    const foreignRoot: WorkspaceNode = { nodeType: 'root', id: 'legacy-root', parentId: null, position: 0, axis: 'row' };
    store().hydrateFromServer(WS, snapshot(2, [foreignRoot]));
    store().openConversation(WS, 'c1');
    expect(tree().nodes.filter((n) => n.nodeType === 'root')).toHaveLength(1);
  });
});

describe('closePane', () => {
  it('should DESTROY the node — closing takes the pane out of the workspace', () => {
    // It used to PARK it: same node, null parent, still a member and still
    // holding its binding. That state is what made a pane the user closed and a
    // pane that lost its parent to a defect the same row.
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1'), pane('p2', WS, 1, 'c2')]));
    expect(store().closePane(WS, 'p2')).toBe('closed');
    expect(tree().nodes.find((n) => n.id === 'p2')).toBeUndefined();
    expect(tree().nodes.map((n) => n.id)).toEqual([WS, 'p1']);
  });

  it('should leave an EMPTY TREE when the last pane closes, and not forget the workspace', () => {
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    expect(store().closePane(WS, 'p1')).toBe('closed');
    expect(tree()).toBeDefined();
    // The node is GONE, not parked. The session stands with a root holding
    // nothing — closing the last pane does not end it.
    expect(tree().nodes.find((n) => n.id === 'p1')).toBeUndefined();
    expect(tree().nodes.find((n) => n.nodeType === 'root')).toBeDefined();
    expect(tree().activeNodeId).toBeNull();
  });

  it('should answer noop for the ROOT — closing a pane is not ending the session', () => {
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    expect(store().closePane(WS, WS)).toBe('noop');
    expect(tree().nodes.find((n) => n.nodeType === 'root')).toBeDefined();
  });

  it('should answer noop for a node this workspace does not hold', () => {
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    expect(store().closePane(WS, 'ghost')).toBe('noop');
  });
});

describe('openConversation', () => {
  it('should focus the node already showing it, and write nothing', () => {
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1'), pane('p2', WS, 1, 'c2')]));
    store().selectNode(WS, 'p1');
    mockFetchWithAuth.mockClear();

    store().openConversation(WS, 'c2');

    expect(tree().activeNodeId).toBe('p2');
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  /**
   * A target held DEEP in the tree. This case used to be about a PARKED node:
   * the command refused it on purpose ("showing it again is a move, and the
   * caller names it"), so the store had to move it back by hand or clicking a
   * parked thread in the sidebar silently did nothing. A holder is always on
   * screen now, so the whole answer is focus — and the property that matters,
   * that no SECOND node is minted for it, is the same one.
   */
  it('should focus a node nested below a split rather than mint a second one', () => {
    const split: WorkspaceNode = { nodeType: 'split', id: 's1', parentId: WS, position: 1, axis: 'column' };
    store().hydrateFromServer(
      WS,
      snapshot(1, [root, pane('p1', WS, 0, 'c1'), split, pane('deep', 's1', 0, 'c2'), pane('beside', 's1', 1, 'c3')]),
    );
    store().selectNode(WS, 'p1');
    mockFetchWithAuth.mockClear();

    store().openConversation(WS, 'c2');

    expect(tree().nodes.filter((n) => n.nodeType === 'pane' && n.target?.id === 'c2')).toHaveLength(1);
    expect(tree().activeNodeId).toBe('deep');
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it('should fill an unbound pane rather than split', () => {
    store().hydrateFromServer(WS, snapshot(1, [root, pane('empty', WS, 0)]));
    store().openConversation(WS, 'c1');
    const filled = tree().nodes.find((n) => n.id === 'empty');
    expect(filled?.nodeType === 'pane' && filled.target?.id).toBe('c1');
  });

  it('should place into an empty grid', () => {
    store().hydrateFromServer(WS, snapshot(1, [root]));
    store().openConversation(WS, 'c1');
    const panes = tree().nodes.filter((n) => n.nodeType === 'pane');
    expect(panes).toHaveLength(1);
    expect(panes[0].parentId).toBe(WS);
  });

  /** The client-only guard the server cannot evaluate. */
  it('should not evict a page pane holding unsaved edits', () => {
    const pagePane: WorkspaceNode = {
      nodeType: 'pane',
      id: 'p1',
      parentId: WS,
      position: 0,
      target: { kind: 'page', id: 'page-1' },
    };
    store().hydrateFromServer(WS, snapshot(1, [root, pagePane]));
    useEditingStore
      .getState()
      .startEditing('doc-1', 'document', { componentName: 'doc', pageId: 'page-1' });

    store().openConversation(WS, 'c1');

    // The dirty page pane survived; the conversation went somewhere else.
    const survivor = tree().nodes.find((n) => n.id === 'p1');
    expect(survivor?.nodeType === 'pane' && survivor.target?.id).toBe('page-1');
    expect(survivor?.parentId).not.toBeNull();
    expect(tree().nodes.some((n) => n.nodeType === 'pane' && n.target?.id === 'c1')).toBe(true);
  });

  it('should not evict a chat pane whose thread the caller knows is no longer live', () => {
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'closed-thread')]));
    store().openConversation(WS, 'c1', { liveConversationIds: new Set(['c1']) });
    const survivor = tree().nodes.find((n) => n.id === 'p1');
    expect(survivor?.nodeType === 'pane' && survivor.target?.id).toBe('closed-thread');
    expect(survivor?.parentId).not.toBeNull();
  });

  it('should never evict a running terminal', () => {
    const shellPane: WorkspaceNode = {
      nodeType: 'pane',
      id: 'p1',
      parentId: WS,
      position: 0,
      target: { kind: 'terminal', id: 'shell-1' },
    };
    store().hydrateFromServer(WS, snapshot(1, [root, shellPane]));
    store().openConversation(WS, 'c1');
    const survivor = tree().nodes.find((n) => n.id === 'p1');
    expect(survivor?.nodeType === 'pane' && survivor.target?.id).toBe('shell-1');
    expect(survivor?.parentId).not.toBeNull();
  });
});

describe('unbindPane', () => {
  it('should replace the node with a fresh unbound one in the same slot', () => {
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1'), pane('p2', WS, 1, 'c2')]));
    store().unbindPane(WS, 'p1');

    const panes = tree().nodes.filter((n) => n.nodeType === 'pane');
    expect(panes).toHaveLength(2);
    expect(panes.some((n) => n.id === 'p1')).toBe(false);
    // The binding did not survive — a binding is for life, so the pane did not.
    expect(panes.some((n) => n.target?.id === 'c1')).toBe(false);
    expect(panes.some((n) => n.target === null)).toBe(true);
  });

  it('should leave the sole pane of a workspace as an unbound pane, not an empty grid', () => {
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    store().unbindPane(WS, 'p1');
    const panes = tree().nodes.filter((n) => n.nodeType === 'pane');
    expect(panes).toHaveLength(1);
    expect(panes[0].target).toBeNull();
    expect(panes[0].parentId).toBe(WS);
  });
});

describe('focus', () => {
  it('should fall back to the first grid pane when the focused node vanishes', () => {
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1'), pane('p2', WS, 1, 'c2')]));
    store().selectNode(WS, 'p2');
    store().applyRemoteUpdate({ workspaceId: WS, rev: 2, nodes: [root, pane('p1', WS, 0, 'c1')] });
    expect(tree().activeNodeId).toBe('p1');
  });

  it('should NOT let a remote edit steal focus from a node that still exists', () => {
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1'), pane('p2', WS, 1, 'c2')]));
    store().selectNode(WS, 'p2');
    store().applyRemoteUpdate({
      workspaceId: WS,
      rev: 2,
      nodes: [root, pane('p1', WS, 0, 'c1'), pane('p2', WS, 1, 'c2'), pane('p3', WS, 2, 'c3')],
    });
    expect(tree().activeNodeId).toBe('p2');
  });

  it('should refuse to focus a node that is not a pane in this workspace', () => {
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    store().selectNode(WS, 'ghost');
    expect(tree().activeNodeId).toBe('p1');
  });
});

describe('the wire', () => {
  it('should POST one write for several local edits, coalesced', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    mockFetchWithAuth.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolveFirst = resolve; }),
    );
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    store().splitPane(WS, 'p1', 'row');
    await Promise.resolve();
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

    // A second edit while the first is on the wire: it must WAIT, not race.
    store().splitPane(WS, 'p1', 'column');
    await Promise.resolve();
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

    resolveFirst?.(jsonResponse(200, snapshot(2, tree().nodes)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('should adopt a 409 body as truth and re-post', async () => {
    const serverTree = [root, pane('p1', WS, 0, 'c1'), pane('remote', WS, 1, 'c9')];
    mockFetchWithAuth
      .mockImplementationOnce(async () => jsonResponse(409, snapshot(7, serverTree)))
      .mockImplementationOnce(() => new Promise<Response>(() => {}));

    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    store().splitPane(WS, 'p1', 'row');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(tree().rev).toBe(7);
    expect(tree().nodes.some((n) => n.id === 'remote')).toBe(true);
    // The split is still applied on top of the newer base.
    expect(tree().nodes.filter((n) => n.nodeType === 'pane')).toHaveLength(3);
    const secondBody = JSON.parse(mockFetchWithAuth.mock.calls[1][1].body as string);
    expect(secondBody.baseRev).toBe(7);
  });

  it('should abandon the queue and flag it on a 400', async () => {
    mockFetchWithAuth
      .mockImplementationOnce(async () => jsonResponse(400, { error: 'nope', code: 'dangling_parent' }))
      // The resync that follows an abandon.
      .mockImplementationOnce(async () => jsonResponse(200, snapshot(2, [root, pane('p1', WS, 0, 'c1')])));

    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    store().splitPane(WS, 'p1', 'row');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store().queueErrors[WS]?.reason).toBe('refused');
    expect(tree().nodes.filter((n) => n.nodeType === 'pane')).toHaveLength(1);
  });

  it('should refuse a 200 body that is not a tree, rather than adopt it', async () => {
    mockFetchWithAuth.mockImplementationOnce(async () => jsonResponse(200, { rev: 9, nodes: 'nope', targets: [] }));
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    store().splitPane(WS, 'p1', 'row');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Rev unchanged; the local split folded into the base so the render is stable.
    expect(tree().rev).toBe(1);
    expect(tree().nodes.filter((n) => n.nodeType === 'pane')).toHaveLength(2);
  });
});

describe('the editing-store registration', () => {
  it('should register while a write is unacked and release when the queue drains', async () => {
    mockFetchWithAuth.mockImplementationOnce(async () =>
      jsonResponse(200, snapshot(2, [root, pane('p1', WS, 0, 'c1')])),
    );
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    store().splitPane(WS, 'p1', 'row');
    expect(useEditingStore.getState().isAnyActive()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useEditingStore.getState().isAnyActive()).toBe(false);
  });
});

/**
 * The fact a merely-LOCAL tree cannot be told from a read one without.
 *
 * `runCommand` seeds a root client-side at rev 0 so the first click composes
 * into one write instead of waiting a round trip — which means presence in
 * `workspaces` is not evidence that any server has answered. Every consumer
 * whose decision would be wrong against a local-only tree reads this instead.
 */
describe('hasServerSnapshot', () => {
  it('given a workspace only ever seeded locally, should report NO server snapshot', () => {
    store().openConversation(WS, 'c1');
    expect(tree()).toBeDefined();
    expect(tree().hasServerSnapshot).toBe(false);
  });

  it('given a snapshot has been adopted, should report a server snapshot', () => {
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    expect(tree().hasServerSnapshot).toBe(true);
  });

  it('should flip on a read that CONFIRMS the local seed exactly, changing nothing else', () => {
    // The one case that isolates `hasServerSnapshot` in the stability
    // comparison: the server answers with precisely the tree this client
    // seeded, at the rev it already holds, so every other field the comparison
    // reads is identical and only `base` goes null → non-null. Without the
    // flag in that comparison the previous object is kept and the tree reads as
    // never-read forever — the readiness signal would never arm.
    store().openConversation(WS, 'c1');
    expect(tree().hasServerSnapshot).toBe(false);

    store().hydrateFromServer(WS, snapshot(tree().rev, tree().nodes));

    expect(tree().hasServerSnapshot).toBe(true);
  });

  it('should keep the SAME tree object when an unchanged snapshot is re-adopted', () => {
    // Referential stability is load-bearing: the sidebar re-seats every listed
    // workspace on every revalidation, and a fresh object per seat re-renders
    // every tree in the app.
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    const first = tree();
    store().hydrateFromServer(WS, snapshot(1, [root, pane('p1', WS, 0, 'c1')]));
    expect(tree()).toBe(first);
  });
});
