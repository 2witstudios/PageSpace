/**
 * THE COMMANDS — the layer where the UI's vocabulary is allowed to live.
 *
 * `split`, `openConversation`, `openPage`, `replaceConversation` and
 * `closePane` are POLICY compiled down to the five operations of
 * `workspace-node-algebra.ts`. None of them is a fact about the data: a split
 * is *insert container → reparent existing child → insert sibling*, and
 * "closing" a pane is a `move` to no parent. They are shapes a toolbar wants.
 *
 * Three properties this suite exists to hold down:
 *
 *  - **A command is atomic.** Either the tree its write produces satisfies
 *    `validateTree`, or nothing is written at all. So the assertions apply the
 *    write and re-validate rather than inspecting the write's shape, and every
 *    rejection test asserts that the result carries no write.
 *  - **A refused command is refused, never repaired.** No unresolvable node or
 *    parent is quietly re-attached to the root; the tests for those assert a
 *    code, never a tree.
 *  - **A stale click is not an error.** A command naming a node that is already
 *    where it was asked to be answers with an empty write, not a throw.
 */
import { describe, it, expect } from 'vitest';
import {
  closePane,
  openConversation,
  openPage,
  replaceConversation,
  split,
  type CommandResult,
} from '../workspace-node-commands';
import { applyNodeWrite, type NodeWrite } from '../workspace-node-algebra';
import { validateTree } from '../workspace-node-validate';
import {
  childrenOf,
  detachedOf,
  findNode,
  type PaneNode,
  type RootNode,
  type SplitNode,
  type WorkspaceNode,
} from '../workspace-node';

function root(): RootNode {
  return { nodeType: 'root', id: 'root-1', parentId: null, position: 0, axis: 'row' };
}

/** A split node. Named for what it is rather than `split`, which is the command. */
function container(id: string, parentId: string, position: number): SplitNode {
  return { nodeType: 'split', id, parentId, position, axis: 'column' };
}

function pane(id: string, parentId: string | null, position: number): PaneNode {
  return { nodeType: 'pane', id, parentId, position, target: { kind: 'chat', id: `conv-${id}` } };
}

/** A pane rendering its picker: in the workspace, showing nothing yet. */
function unbound(id: string, parentId: string | null, position: number): PaneNode {
  return { nodeType: 'pane', id, parentId, position, target: null };
}

/** A pane showing a running shell — never evictable, so placement must split past it. */
function terminal(id: string, parentId: string | null, position: number): PaneNode {
  return { nodeType: 'pane', id, parentId, position, target: { kind: 'terminal', id: `sh-${id}` } };
}

/** The accepted write, or a failure naming the code that came back instead. */
function accepted(result: CommandResult): NodeWrite {
  if (!result.ok) throw new Error(`expected an accepted command, got ${result.code}: ${result.detail}`);
  return result.write;
}

/** The rejection code, or the string `accepted` — so a wrong acceptance reads clearly. */
function refusedWith(result: CommandResult): string {
  return result.ok ? 'accepted' : result.code;
}

/** The tree an accepted command produces. */
function applied(nodes: readonly WorkspaceNode[], result: CommandResult): WorkspaceNode[] {
  return applyNodeWrite(nodes, accepted(result));
}

/** A member's share of its parent, or `undefined` when it has none. */
function shareOf(nodes: readonly WorkspaceNode[], id: string): number | undefined {
  const node = findNode(nodes, id);
  return node === undefined || node.nodeType === 'root' ? undefined : node.fraction;
}

describe('split', () => {
  it('should put a container where the pane was, with the pane and a new unbound one inside it', () => {
    const before = [root(), pane('a', 'root-1', 0)];
    const after = applied(
      before,
      split(before, { nodeId: 'a', axis: 'row', newNodeId: 'fresh', newSplitId: 'box' }),
    );
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['box']);
    expect(childrenOf(after, 'box').map((n) => n.id)).toEqual(['a', 'fresh']);
    expect(findNode(after, 'fresh')).toMatchObject({ nodeType: 'pane', target: null });
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should give the container the axis it was asked for, which is the whole of the old two verbs', () => {
    // `split_right` and `split_down` differed by nothing else.
    const before = [root(), pane('a', 'root-1', 0)];
    const down = applied(
      before,
      split(before, { nodeId: 'a', axis: 'column', newNodeId: 'fresh', newSplitId: 'box' }),
    );
    expect(findNode(down, 'box')).toMatchObject({ nodeType: 'split', axis: 'column' });
  });

  it('should seat the container in the split pane’s own slot, keeping its siblings where they were', () => {
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1), pane('c', 'root-1', 2)];
    const after = applied(
      before,
      split(before, { nodeId: 'b', axis: 'row', newNodeId: 'fresh', newSplitId: 'box' }),
    );
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['a', 'box', 'c']);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should hand the container the split pane’s share, so the parent still sums to one', () => {
    // The pane's share was a share of ITS parent; the container now occupies
    // that slot, so the share goes with the slot and nothing else renumbers.
    const before: WorkspaceNode[] = [
      root(),
      { ...pane('a', 'root-1', 0), fraction: 0.7 },
      { ...pane('b', 'root-1', 1), fraction: 0.3 },
    ];
    const after = applied(
      before,
      split(before, { nodeId: 'a', axis: 'row', newNodeId: 'fresh', newSplitId: 'box' }),
    );
    expect(shareOf(after, 'box')).toBeCloseTo(0.7, 5);
    expect(shareOf(after, 'b')).toBeCloseTo(0.3, 5);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should leave the new container unsized, because nobody has sized it yet', () => {
    // An even split is the opening state and is deliberately not stored as
    // `1/n` rows: writing shares nobody chose would make every split a resize.
    const before: WorkspaceNode[] = [
      root(),
      { ...pane('a', 'root-1', 0), fraction: 0.7 },
      { ...pane('b', 'root-1', 1), fraction: 0.3 },
    ];
    const after = applied(
      before,
      split(before, { nodeId: 'a', axis: 'row', newNodeId: 'fresh', newSplitId: 'box' }),
    );
    expect(shareOf(after, 'a')).toBeUndefined();
    expect(shareOf(after, 'fresh')).toBeUndefined();
  });

  it('should leave the input untouched', () => {
    const before = [root(), pane('a', 'root-1', 0)];
    const snapshot = JSON.parse(JSON.stringify(before)) as WorkspaceNode[];
    split(before, { nodeId: 'a', axis: 'row', newNodeId: 'fresh', newSplitId: 'box' });
    expect(before).toEqual(snapshot);
  });
});

describe('split rejections', () => {
  it('should refuse a node id that does not resolve, rather than splitting something else', () => {
    const before = [root(), pane('a', 'root-1', 0)];
    expect(
      refusedWith(split(before, { nodeId: 'ghost', axis: 'row', newNodeId: 'fresh', newSplitId: 'box' })),
    ).toBe('unknown_node');
  });

  it('should refuse the root, which is the workspace and not a pane in it', () => {
    const before = [root(), pane('a', 'root-1', 0)];
    expect(
      refusedWith(split(before, { nodeId: 'root-1', axis: 'row', newNodeId: 'fresh', newSplitId: 'box' })),
    ).toBe('root_immutable');
  });

  it('should refuse to split a split, which divides space rather than occupying it', () => {
    const before = [root(), container('col', 'root-1', 0), pane('a', 'col', 0), pane('b', 'col', 1)];
    expect(
      refusedWith(split(before, { nodeId: 'col', axis: 'row', newNodeId: 'fresh', newSplitId: 'box' })),
    ).toBe('not_a_pane');
  });

  it('should refuse to split a parked pane, which is in no container for a split to sit in', () => {
    // `SplitNode.parentId` is a `string`, so a parked container is unspellable —
    // there is nothing to repair this into, only a rejection.
    const before = [root(), pane('a', 'root-1', 0), pane('parked', null, 0)];
    expect(
      refusedWith(split(before, { nodeId: 'parked', axis: 'row', newNodeId: 'fresh', newSplitId: 'box' })),
    ).toBe('detached_pane');
  });

  it('should refuse a container id the workspace already holds', () => {
    const before = [root(), pane('a', 'root-1', 0)];
    expect(
      refusedWith(split(before, { nodeId: 'a', axis: 'row', newNodeId: 'fresh', newSplitId: 'a' })),
    ).toBe('duplicate_id');
  });

  it('should refuse a pane id the workspace already holds', () => {
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    expect(
      refusedWith(split(before, { nodeId: 'a', axis: 'row', newNodeId: 'b', newSplitId: 'box' })),
    ).toBe('duplicate_id');
  });

  it('should refuse two new ids that collide with each other rather than with the tree', () => {
    const before = [root(), pane('a', 'root-1', 0)];
    expect(
      refusedWith(split(before, { nodeId: 'a', axis: 'row', newNodeId: 'same', newSplitId: 'same' })),
    ).toBe('duplicate_id');
  });

  it('should write NOTHING when the compiled create is refused, never the container on its own', () => {
    // The atomicity property, and the one place it is observable: the container
    // is staged before the create that completes it, so a command that gave up
    // half way would leave a split holding one child in the caller's tree.
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    const result = split(before, { nodeId: 'a', axis: 'row', newNodeId: 'b', newSplitId: 'box' });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('write');
  });

  it('should refuse a split that would nest past the depth cap, rather than truncating it', () => {
    // Every split NESTS a container, so the cap is reachable by repeating one
    // gesture — see the report's note on `split_down`, which appended instead.
    const before: WorkspaceNode[] = [root()];
    let parent = 'root-1';
    for (let depth = 1; depth < 8; depth += 1) {
      before.push(container(`s${depth}`, parent, 0), pane(`p${depth}`, `s${depth}`, 1));
      parent = `s${depth}`;
    }
    expect(
      refusedWith(split(before, { nodeId: 'p7', axis: 'row', newNodeId: 'fresh', newSplitId: 'box' })),
    ).toBe('max_depth_exceeded');
  });

  it('should refuse to operate on a tree that is already corrupt, rather than writing into it', () => {
    const before = [root(), pane('leaf', 'root-1', 0), pane('impossible', 'leaf', 0)];
    expect(
      refusedWith(split(before, { nodeId: 'leaf', axis: 'row', newNodeId: 'fresh', newSplitId: 'box' })),
    ).toBe('not_a_container');
  });
});

describe('closePane', () => {
  it('should take the pane out of the grid and leave it a member of the workspace', () => {
    // Closing is a `move` to no parent, never a destroy. The node keeps its
    // binding and keeps appearing in the sidebar; it simply leaves the grid.
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    const after = applied(before, closePane(before, { nodeId: 'a' }));
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['b']);
    expect(detachedOf(after).map((n) => n.id)).toEqual(['a']);
    expect(findNode(after, 'a')).toMatchObject({ target: { kind: 'chat', id: 'conv-a' } });
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should append the closed pane after the panes already parked, keeping the sidebar ordered', () => {
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1), pane('parked', null, 0)];
    const after = applied(before, closePane(before, { nodeId: 'a' }));
    expect(detachedOf(after).map((n) => n.id)).toEqual(['parked', 'a']);
    expect(detachedOf(after).map((n) => n.position)).toEqual([0, 1]);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should leave an EMPTY grid when the last pane closes, and not end the workspace', () => {
    // A deliberate behaviour change. In the model this replaces the decision
    // lived half in the reducer (`closePane` no-oped on the last pane) and half
    // in browser code that ended the session. Ending a workspace is an explicit
    // lifecycle act elsewhere; a grid with nothing in it is an ordinary state.
    const before = [root(), pane('only', 'root-1', 0)];
    const after = applied(before, closePane(before, { nodeId: 'only' }));
    expect(childrenOf(after, 'root-1')).toEqual([]);
    expect(detachedOf(after).map((n) => n.id)).toEqual(['only']);
    expect(findNode(after, 'root-1')).toBeDefined();
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should collapse a split its departure left holding one child', () => {
    // The write can never leave a split with one child: `validateTree` rejects
    // one, so without the collapse an ordinary close could not succeed at all.
    const before = [
      root(),
      container('col', 'root-1', 0),
      pane('other', 'root-1', 1),
      pane('a', 'col', 0),
      pane('b', 'col', 1),
    ];
    const after = applied(before, closePane(before, { nodeId: 'a' }));
    expect(findNode(after, 'col')).toBeUndefined();
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['b', 'other']);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should write nothing for a pane that is already out of the grid', () => {
    // A stale click racing another client's close is not an error, and a
    // re-sent close must not bump a rev or broadcast.
    const before = [root(), pane('a', 'root-1', 0), pane('parked', null, 0)];
    expect(accepted(closePane(before, { nodeId: 'parked' }))).toEqual({ put: [], drop: [] });
  });

  it('should refuse a node id that does not resolve', () => {
    const before = [root(), pane('a', 'root-1', 0)];
    expect(refusedWith(closePane(before, { nodeId: 'ghost' }))).toBe('unknown_node');
  });

  it('should refuse the root, which is the workspace itself', () => {
    const before = [root(), pane('a', 'root-1', 0)];
    expect(refusedWith(closePane(before, { nodeId: 'root-1' }))).toBe('root_immutable');
  });

  it('should refuse a split, because closing a column is not closing a pane', () => {
    // A parked split would be garbage: it has no durable target of its own, so
    // there would be nothing in the sidebar to bring it back by.
    const before = [root(), container('col', 'root-1', 0), pane('a', 'col', 0), pane('b', 'col', 1)];
    expect(refusedWith(closePane(before, { nodeId: 'col' }))).toBe('not_detachable');
  });

  it('should leave the input untouched', () => {
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    const snapshot = JSON.parse(JSON.stringify(before)) as WorkspaceNode[];
    closePane(before, { nodeId: 'a' });
    expect(before).toEqual(snapshot);
  });
});

describe('replaceConversation', () => {
  it('should move the replacement into the pane’s slot and park the pane it displaced', () => {
    // TWO MOVES, never a rebind. A bound node's target is fixed for the whole of
    // its life, so swapping what a rectangle shows is a change of location for
    // two nodes — which is what keeps "this pane" and "this conversation"
    // separable, so closing a view never reads as discarding what it showed.
    const before = [root(), pane('shown', 'root-1', 0), pane('other', 'root-1', 1), pane('parked', null, 0)];
    const after = applied(
      before,
      replaceConversation(before, { nodeId: 'shown', target: { kind: 'chat', id: 'conv-parked' } }),
    );
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['parked', 'other']);
    expect(detachedOf(after).map((n) => n.id)).toEqual(['shown']);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should leave both nodes showing exactly what they showed before', () => {
    // The property the two moves buy: no node's target changes, ever.
    const before = [root(), pane('shown', 'root-1', 0), pane('other', 'root-1', 1), pane('parked', null, 0)];
    const after = applied(
      before,
      replaceConversation(before, { nodeId: 'shown', target: { kind: 'chat', id: 'conv-parked' } }),
    );
    expect(findNode(after, 'shown')).toMatchObject({ target: { kind: 'chat', id: 'conv-shown' } });
    expect(findNode(after, 'parked')).toMatchObject({ target: { kind: 'chat', id: 'conv-parked' } });
  });

  it('should seat the replacement in the displaced pane’s own slot, not at the end of the group', () => {
    const before = [
      root(),
      pane('a', 'root-1', 0),
      pane('shown', 'root-1', 1),
      pane('c', 'root-1', 2),
      pane('parked', null, 0),
    ];
    const after = applied(
      before,
      replaceConversation(before, { nodeId: 'shown', target: { kind: 'chat', id: 'conv-parked' } }),
    );
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['a', 'parked', 'c']);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should take the replacement from wherever it already is, including elsewhere in the grid', () => {
    const before = [
      root(),
      container('col', 'root-1', 0),
      pane('shown', 'root-1', 1),
      pane('elsewhere', 'col', 0),
      pane('stays', 'col', 1),
    ];
    const after = applied(
      before,
      replaceConversation(before, { nodeId: 'shown', target: { kind: 'chat', id: 'conv-elsewhere' } }),
    );
    // Its old container was left holding one child, so the algebra collapsed it.
    expect(findNode(after, 'col')).toBeUndefined();
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['stays', 'elsewhere']);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should collapse the container when the replacement was the displaced pane’s only sibling', () => {
    const before = [
      root(),
      container('col', 'root-1', 0),
      pane('other', 'root-1', 1),
      pane('shown', 'col', 0),
      pane('sibling', 'col', 1),
    ];
    const after = applied(
      before,
      replaceConversation(before, { nodeId: 'shown', target: { kind: 'chat', id: 'conv-sibling' } }),
    );
    expect(findNode(after, 'col')).toBeUndefined();
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['sibling', 'other']);
    expect(detachedOf(after).map((n) => n.id)).toEqual(['shown']);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should park an unbound pane it displaces like any other, rather than discarding it', () => {
    const before = [root(), unbound('picker', 'root-1', 0), pane('parked', null, 0)];
    const after = applied(
      before,
      replaceConversation(before, { nodeId: 'picker', target: { kind: 'chat', id: 'conv-parked' } }),
    );
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['parked']);
    expect(detachedOf(after).map((n) => n.id)).toEqual(['picker']);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should write nothing when the pane already shows what it was asked to show', () => {
    const before = [root(), pane('shown', 'root-1', 0)];
    expect(
      accepted(replaceConversation(before, { nodeId: 'shown', target: { kind: 'chat', id: 'conv-shown' } })),
    ).toEqual({ put: [], drop: [] });
  });

  it('should refuse a target no node in the workspace holds, because it moves one in and mints none', () => {
    // Ids are the caller's, so this command has no id to mint a replacement
    // with — a target nothing shows is a caller working from a stale snapshot.
    const before = [root(), pane('shown', 'root-1', 0)];
    expect(
      refusedWith(replaceConversation(before, { nodeId: 'shown', target: { kind: 'chat', id: 'conv-ghost' } })),
    ).toBe('invalid_target');
  });

  it('should refuse a target of the right id but the wrong kind', () => {
    const before = [root(), pane('shown', 'root-1', 0), pane('parked', null, 0)];
    expect(
      refusedWith(replaceConversation(before, { nodeId: 'shown', target: { kind: 'page', id: 'conv-parked' } })),
    ).toBe('invalid_target');
  });

  it('should refuse a node id that does not resolve', () => {
    const before = [root(), pane('shown', 'root-1', 0), pane('parked', null, 0)];
    expect(
      refusedWith(replaceConversation(before, { nodeId: 'ghost', target: { kind: 'chat', id: 'conv-parked' } })),
    ).toBe('unknown_node');
  });

  it('should refuse the root, which shows nothing of its own', () => {
    const before = [root(), pane('shown', 'root-1', 0), pane('parked', null, 0)];
    expect(
      refusedWith(replaceConversation(before, { nodeId: 'root-1', target: { kind: 'chat', id: 'conv-parked' } })),
    ).toBe('root_immutable');
  });

  it('should refuse a split, which is a division of space and not a viewport', () => {
    const before = [
      root(),
      container('col', 'root-1', 0),
      pane('a', 'col', 0),
      pane('b', 'col', 1),
      pane('parked', null, 0),
    ];
    expect(
      refusedWith(replaceConversation(before, { nodeId: 'col', target: { kind: 'chat', id: 'conv-parked' } })),
    ).toBe('not_a_pane');
  });

  it('should refuse a parked pane, which displays nothing there is anything to swap', () => {
    const before = [root(), pane('a', 'root-1', 0), pane('parked', null, 0), pane('other', null, 1)];
    expect(
      refusedWith(replaceConversation(before, { nodeId: 'parked', target: { kind: 'chat', id: 'conv-other' } })),
    ).toBe('detached_pane');
  });

  it('should refuse to operate on a tree that is already corrupt, rather than writing into it', () => {
    const before = [root(), pane('shown', 'root-1', 0), pane('impossible', 'shown', 0), pane('parked', null, 0)];
    expect(
      refusedWith(replaceConversation(before, { nodeId: 'shown', target: { kind: 'chat', id: 'conv-parked' } })),
    ).toBe('not_a_container');
  });

  it('should leave the input untouched', () => {
    const before = [root(), pane('shown', 'root-1', 0), pane('parked', null, 0)];
    const snapshot = JSON.parse(JSON.stringify(before)) as WorkspaceNode[];
    replaceConversation(before, { nodeId: 'shown', target: { kind: 'chat', id: 'conv-parked' } });
    expect(before).toEqual(snapshot);
  });
});

/**
 * THE PLACEMENT POLICY, ported. The rules below are the ones
 * `resolveOpenPlacement` already held, restated in the node model's terms:
 * prefer a replaceable pane, prefer the active one among those, never evict a
 * terminal or the invoking conversation, and split rather than take anything
 * away. What is new is only what the flat model made expressible — an empty
 * grid, and a node parked outside it.
 */
describe('openConversation', () => {
  const opening = { newNodeId: 'fresh', newSplitId: 'box' } as const;

  it('should fill an unbound pane rather than minting a second one', () => {
    const before = [root(), unbound('picker', 'root-1', 0)];
    const after = applied(
      before,
      openConversation(before, { ...opening, target: { kind: 'chat', id: 'conv-1' } }),
    );
    expect(findNode(after, 'picker')).toMatchObject({ target: { kind: 'chat', id: 'conv-1' } });
    expect(findNode(after, 'fresh')).toBeUndefined();
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should mint beside a bound pane and park it, because a binding is for life', () => {
    // The old model's `assign` onto a bound pane REPOINTED it. A target is fixed
    // for a node's life here, so the same gesture is a new node in that slot and
    // the old one parked — the conversation it showed is still one click away.
    const before = [root(), pane('shown', 'root-1', 0), pane('other', 'root-1', 1)];
    const after = applied(
      before,
      openConversation(before, { ...opening, target: { kind: 'chat', id: 'conv-1' } }),
    );
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['fresh', 'other']);
    expect(findNode(after, 'fresh')).toMatchObject({ target: { kind: 'chat', id: 'conv-1' } });
    expect(detachedOf(after).map((n) => n.id)).toEqual(['shown']);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should prefer the ACTIVE pane over an earlier eligible one', () => {
    // "Show me this" means "here, where I am looking" — not "in the leftmost
    // slot that happens to fit".
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    const after = applied(
      before,
      openConversation(before, { ...opening, target: { kind: 'chat', id: 'conv-1' }, activeNodeId: 'b' }),
    );
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['a', 'fresh']);
    expect(detachedOf(after).map((n) => n.id)).toEqual(['b']);
  });

  it('should fall back to the first eligible pane when the active one is not', () => {
    const before = [root(), pane('a', 'root-1', 0), terminal('sh', 'root-1', 1)];
    const after = applied(
      before,
      openConversation(before, { ...opening, target: { kind: 'chat', id: 'conv-1' }, activeNodeId: 'sh' }),
    );
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['fresh', 'sh']);
  });

  it('should never evict a terminal — a running PTY has no reattach UI', () => {
    const before = [root(), terminal('sh', 'root-1', 0)];
    const after = applied(
      before,
      openConversation(before, { ...opening, target: { kind: 'chat', id: 'conv-1' } }),
    );
    expect(childrenOf(after, 'box').map((n) => n.id)).toEqual(['sh', 'fresh']);
    expect(findNode(after, 'fresh')).toMatchObject({ target: { kind: 'chat', id: 'conv-1' } });
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should bind the new pane at the mint on the split path, never as a second step', () => {
    // A create-then-bind pair has a moment where the first landed and the second
    // did not, which is the state production is in today.
    const before = [root(), terminal('sh', 'root-1', 0)];
    const write = accepted(
      openConversation(before, { ...opening, target: { kind: 'chat', id: 'conv-1' } }),
    );
    const minted = write.put.find((node) => node.id === 'fresh');
    expect(minted).toMatchObject({ target: { kind: 'chat', id: 'conv-1' } });
  });

  it('should split along the axis it was given, and beside the pane by default', () => {
    const before = [root(), terminal('sh', 'root-1', 0)];
    const after = applied(
      before,
      openConversation(before, { ...opening, target: { kind: 'chat', id: 'conv-1' }, axis: 'column' }),
    );
    expect(findNode(after, 'box')).toMatchObject({ axis: 'column' });

    const beside = applied(
      before,
      openConversation(before, { ...opening, target: { kind: 'chat', id: 'conv-1' } }),
    );
    expect(findNode(beside, 'box')).toMatchObject({ axis: 'row' });
  });

  it('should split from the ACTIVE pane when nothing is replaceable', () => {
    const before = [root(), terminal('one', 'root-1', 0), terminal('two', 'root-1', 1)];
    const after = applied(
      before,
      openConversation(before, { ...opening, target: { kind: 'chat', id: 'conv-1' }, activeNodeId: 'two' }),
    );
    expect(childrenOf(after, 'box').map((n) => n.id)).toEqual(['two', 'fresh']);
  });

  it('should under preferSplit fill ONLY an unbound pane', () => {
    // An agent ADDS a surface beside what the user is doing; it never navigates
    // the user's panes.
    const bound = [root(), pane('shown', 'root-1', 0)];
    const afterBound = applied(
      bound,
      openConversation(bound, { ...opening, target: { kind: 'chat', id: 'conv-1' }, preferSplit: true }),
    );
    expect(childrenOf(afterBound, 'box').map((n) => n.id)).toEqual(['shown', 'fresh']);

    const picker = [root(), unbound('picker', 'root-1', 0)];
    const afterPicker = applied(
      picker,
      openConversation(picker, { ...opening, target: { kind: 'chat', id: 'conv-1' }, preferSplit: true }),
    );
    expect(findNode(afterPicker, 'picker')).toMatchObject({ target: { kind: 'chat', id: 'conv-1' } });
  });

  it('should never evict the excluded target — a tool call must not eat its own invoker', () => {
    const before = [root(), pane('invoker', 'root-1', 0)];
    const after = applied(
      before,
      openConversation(before, {
        ...opening,
        target: { kind: 'chat', id: 'conv-1' },
        excludeTargetId: 'conv-invoker',
      }),
    );
    expect(childrenOf(after, 'box').map((n) => n.id)).toEqual(['invoker', 'fresh']);
    expect(detachedOf(after)).toEqual([]);
  });

  it('should write nothing when a pane in the grid already shows the target', () => {
    // Focus is client-local — it does not restore across devices and no row
    // carries it — so "it is already there" persists nothing at all.
    const before = [root(), pane('shown', 'root-1', 0), unbound('picker', 'root-1', 1)];
    expect(
      accepted(openConversation(before, { ...opening, target: { kind: 'chat', id: 'conv-shown' } })),
    ).toEqual({ put: [], drop: [] });
  });

  it('should place into an EMPTY grid, which the model this replaces could not represent', () => {
    // A grid with nothing in it is now an ordinary state, because closing the
    // last pane leaves one.
    const before = [root(), pane('parked', null, 0)];
    const after = applied(
      before,
      openConversation(before, { ...opening, target: { kind: 'chat', id: 'conv-1' } }),
    );
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['fresh']);
    expect(findNode(after, 'fresh')).toMatchObject({ target: { kind: 'chat', id: 'conv-1' } });
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should ignore an activeNodeId that does not resolve rather than refusing the placement', () => {
    // The active node is a PREFERENCE, never the subject of the command: it says
    // where the user is looking, and the destination is always a pane that
    // demonstrably exists. Refusing here would lose the pane over a stale focus.
    const before = [root(), pane('a', 'root-1', 0)];
    const after = applied(
      before,
      openConversation(before, { ...opening, target: { kind: 'chat', id: 'conv-1' }, activeNodeId: 'ghost' }),
    );
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['fresh']);
  });

  it('should ignore an activeNodeId that names a parked pane, which is in no grid to look at', () => {
    const before = [root(), pane('a', 'root-1', 0), pane('parked', null, 0)];
    const after = applied(
      before,
      openConversation(before, {
        ...opening,
        target: { kind: 'chat', id: 'conv-1' },
        activeNodeId: 'parked',
      }),
    );
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['fresh']);
  });

  it('should leave the input untouched', () => {
    const before = [root(), pane('a', 'root-1', 0)];
    const snapshot = JSON.parse(JSON.stringify(before)) as WorkspaceNode[];
    openConversation(before, { ...opening, target: { kind: 'chat', id: 'conv-1' } });
    expect(before).toEqual(snapshot);
  });

  describe('the injected refusal (what the client adds, and the server does not)', () => {
    it('should AND it with the shared predicate, never replace it', () => {
      // A terminal stays ineligible even when the injection would allow it.
      const before = [root(), terminal('sh', 'root-1', 0)];
      const after = applied(
        before,
        openConversation(before, {
          ...opening,
          target: { kind: 'chat', id: 'conv-1' },
          isReplaceable: () => true,
        }),
      );
      expect(childrenOf(after, 'box').map((n) => n.id)).toEqual(['sh', 'fresh']);
    });

    it('should let it veto a pane the shared predicate would have accepted', () => {
      // The shape of the client's dirty-page and live-conversation guards, which
      // read state the server cannot see.
      const before = [root(), pane('doc', 'root-1', 0), pane('chat', 'root-1', 1)];
      const after = applied(
        before,
        openConversation(before, {
          ...opening,
          target: { kind: 'chat', id: 'conv-1' },
          isReplaceable: (candidate) => candidate.id !== 'doc',
        }),
      );
      expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['doc', 'fresh']);
    });

    it('should not consult it for a target that is already showing', () => {
      // Focus is not a replacement, so a refusal has nothing to say about it.
      const before = [root(), pane('shown', 'root-1', 0)];
      expect(
        accepted(
          openConversation(before, {
            ...opening,
            target: { kind: 'chat', id: 'conv-shown' },
            isReplaceable: () => false,
          }),
        ),
      ).toEqual({ put: [], drop: [] });
    });
  });
});

describe('openConversation rejections', () => {
  const opening = { newNodeId: 'fresh', newSplitId: 'box' } as const;

  it('should refuse to mint a second node for a target a PARKED node already holds', () => {
    // Two nodes bound to one conversation is the duplicate-view bug that the
    // focus rule exists to prevent; a parked node is still the workspace's node
    // for that conversation. Bringing it back is a `move` the caller names.
    const before = [root(), pane('a', 'root-1', 0), pane('parked', null, 0)];
    expect(
      refusedWith(openConversation(before, { ...opening, target: { kind: 'chat', id: 'conv-parked' } })),
    ).toBe('already_bound');
  });

  it('should refuse a target with a blank id, which would bind the new pane to nothing for good', () => {
    // `bind` refuses this and `create` does not, so the fill path and the split
    // path would otherwise disagree about the same request.
    const before = [root(), unbound('picker', 'root-1', 0)];
    expect(refusedWith(openConversation(before, { ...opening, target: { kind: 'chat', id: '  ' } }))).toBe(
      'invalid_target',
    );
  });

  it('should refuse a new pane id the workspace already holds', () => {
    const before = [root(), terminal('sh', 'root-1', 0), pane('fresh', 'root-1', 1)];
    expect(
      refusedWith(openConversation(before, { ...opening, target: { kind: 'chat', id: 'conv-1' } })),
    ).toBe('duplicate_id');
  });

  it('should refuse a new container id the workspace already holds', () => {
    // Both panes are terminals, so nothing is replaceable and the placement has
    // to split — which is the only path that mints a container.
    const before = [root(), terminal('sh', 'root-1', 0), terminal('box', 'root-1', 1)];
    expect(
      refusedWith(openConversation(before, { ...opening, target: { kind: 'chat', id: 'conv-1' } })),
    ).toBe('duplicate_id');
  });

  it('should refuse a workspace with no root, rather than inventing one to place into', () => {
    expect(refusedWith(openConversation([], { ...opening, target: { kind: 'chat', id: 'conv-1' } }))).toBe(
      'no_root',
    );
  });

  it('should refuse to operate on a tree that is already corrupt', () => {
    const before = [root(), pane('leaf', 'root-1', 0), pane('impossible', 'leaf', 0)];
    expect(
      refusedWith(openConversation(before, { ...opening, target: { kind: 'chat', id: 'conv-1' } })),
    ).toBe('not_a_container');
  });
});

describe('openPage', () => {
  const opening = { newNodeId: 'fresh', newSplitId: 'box' } as const;

  it('should run the same placement policy for a page target', () => {
    const before = [root(), unbound('picker', 'root-1', 0)];
    const after = applied(before, openPage(before, { ...opening, target: { kind: 'page', id: 'page-1' } }));
    expect(findNode(after, 'picker')).toMatchObject({ target: { kind: 'page', id: 'page-1' } });
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should split past a terminal for a page exactly as it does for a conversation', () => {
    const before = [root(), terminal('sh', 'root-1', 0)];
    const after = applied(before, openPage(before, { ...opening, target: { kind: 'page', id: 'page-1' } }));
    expect(childrenOf(after, 'box').map((n) => n.id)).toEqual(['sh', 'fresh']);
    expect(findNode(after, 'fresh')).toMatchObject({ target: { kind: 'page', id: 'page-1' } });
  });

  it('should write nothing when a pane already shows that page', () => {
    const before: WorkspaceNode[] = [
      root(),
      { nodeType: 'pane', id: 'doc', parentId: 'root-1', position: 0, target: { kind: 'page', id: 'page-1' } },
    ];
    expect(accepted(openPage(before, { ...opening, target: { kind: 'page', id: 'page-1' } }))).toEqual({
      put: [],
      drop: [],
    });
  });

  it('should not confuse a page with a conversation that happens to share an id', () => {
    // The old policy compared target ids alone; the node model carries the kind
    // beside the id, so the comparison uses both.
    const before = [root(), pane('shown', 'root-1', 0)];
    const after = applied(before, openPage(before, { ...opening, target: { kind: 'page', id: 'conv-shown' } }));
    expect(findNode(after, 'fresh')).toMatchObject({ target: { kind: 'page', id: 'conv-shown' } });
  });
});

describe('render order', () => {
  it('should read the grid depth first, so “the first eligible pane” is the first one on screen', () => {
    // A breadth-first walk would answer `other` here. The two agreed while the
    // model was two levels deep, which is why nothing pinned it before.
    const before = [
      root(),
      container('col', 'root-1', 0),
      pane('other', 'root-1', 1),
      pane('top', 'col', 0),
      pane('bottom', 'col', 1),
    ];
    const after = applied(
      before,
      openConversation(before, {
        newNodeId: 'fresh',
        newSplitId: 'box',
        target: { kind: 'chat', id: 'conv-1' },
      }),
    );
    expect(childrenOf(after, 'col').map((n) => n.id)).toEqual(['fresh', 'bottom']);
    expect(detachedOf(after).map((n) => n.id)).toEqual(['top']);
    expect(validateTree(after)).toEqual({ ok: true });
  });
});

/**
 * NO FALLBACK RE-PARENTING — the failure mode this whole layer is shaped
 * against, and the reason the count of `parentId` assignments on a failure path
 * has to be zero. A pending command naming a container another client just
 * deleted has to be REFUSED so the caller rebases: "put it on the root instead"
 * is not a repair, it is a relocation nobody asked for, and it is how a pane
 * ends up restructured into a session the user never put it in.
 */
describe('a refused command is refused, never repaired', () => {
  it('should not re-attach a parked pane to the root in order to split it', () => {
    // Two parked panes and one in the grid, so a `?? root` fallback would land
    // the container in a free slot and SUCCEED — the pane would silently
    // reappear on screen in a place nobody put it. The setup is deliberate: with
    // a single parked pane the same fallback trips over a position collision
    // instead, and a refusal for the wrong reason is not this property.
    const before = [root(), pane('a', 'root-1', 0), pane('first', null, 0), pane('parked', null, 1)];
    const result = split(before, { nodeId: 'parked', axis: 'row', newNodeId: 'fresh', newSplitId: 'box' });
    expect(refusedWith(result)).toBe('detached_pane');
    expect(result).not.toHaveProperty('write');
  });

  it('should refuse a command whose result would still hold a parent that resolves to nothing', () => {
    const before = [root(), pane('a', 'root-1', 0), pane('orphan', 'ghost-column', 0)];
    expect(refusedWith(closePane(before, { nodeId: 'a' }))).toBe('dangling_parent');
  });

  it('should refuse to place into a grid whose only pane hangs off a container that is gone', () => {
    const before = [root(), pane('stranded', 'ghost-column', 0)];
    expect(
      refusedWith(
        openConversation(before, {
          newNodeId: 'fresh',
          newSplitId: 'box',
          target: { kind: 'chat', id: 'conv-1' },
        }),
      ),
    ).toBe('dangling_parent');
  });
});
