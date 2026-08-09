/**
 * The five operations of the node algebra — `create`, `move`, `bind`,
 * `resize`, `destroy`.
 *
 * Written against the decision that these five describe THE DATA MODEL, not
 * the UI's vocabulary. The twelve wire verbs of `workspace-layout-verbs.ts`
 * named ergonomic gestures (`split_right`, `close_pane`, `reorder_columns`),
 * which is why that reducer reads like a description of the toolbar. The
 * ergonomic gestures become commands COMPOSED from these five; none of them
 * are tested here.
 *
 * Two properties this suite exists to hold down:
 *
 *  - **Every accepted result satisfies `validateTree`.** So most assertions
 *    apply the write and re-validate rather than inspecting the write's shape.
 *  - **A refused operation is refused, never repaired.** In particular there is
 *    no parent that fails to resolve and gets quietly re-attached to the root;
 *    that is a live failure mode in the model this replaces, and the tests for
 *    it assert a rejection code, not a tree.
 */
import { describe, it, expect } from 'vitest';
import {
  applyNodeWrite,
  bind,
  create,
  destroy,
  move,
  resize,
  type NodeOperationResult,
  type NodeWrite,
} from '../workspace-node-algebra';
import { validateTree } from '../workspace-node-validate';
import {
  childrenOf,
  detachedOf,
  findNode,
  type PaneNode,
  type PaneTarget,
  type RootNode,
  type SplitNode,
  type WorkspaceNode,
} from '../workspace-node';

function root(): RootNode {
  return { nodeType: 'root', id: 'root-1', parentId: null, position: 0, axis: 'row' };
}

function split(id: string, parentId: string, position: number): SplitNode {
  return { nodeType: 'split', id, parentId, position, axis: 'column' };
}

function pane(id: string, parentId: string | null, position: number): PaneNode {
  return { nodeType: 'pane', id, parentId, position, target: { kind: 'chat', id: `conv-${id}` } };
}

/** A pane rendering its picker: in the workspace, showing nothing yet. */
function unbound(id: string, parentId: string | null, position: number): PaneNode {
  return { nodeType: 'pane', id, parentId, position, target: null };
}

/**
 * A pane bound to a target the caller names. `pane` derives a chat target from
 * the node id, which is what keeps every other fixture's bindings distinct —
 * so the tests about two nodes naming ONE target have to spell the target out.
 */
function showing(
  id: string,
  parentId: string | null,
  position: number,
  target: PaneTarget,
): PaneNode {
  return { nodeType: 'pane', id, parentId, position, target };
}

/** The accepted write, or a failure naming the code that came back instead. */
function accepted(result: NodeOperationResult): NodeWrite {
  if (!result.ok) throw new Error(`expected an accepted operation, got ${result.code}: ${result.detail}`);
  return result.write;
}

/** The rejection code, or the string `accepted` — so a wrong acceptance reads clearly. */
function refusedWith(result: NodeOperationResult): string {
  return result.ok ? 'accepted' : result.code;
}

/** A member's share of its parent, or `undefined` when it has none. */
function shareOf(nodes: readonly WorkspaceNode[], id: string): number | undefined {
  const node = findNode(nodes, id);
  return node === undefined || node.nodeType === 'root' ? undefined : node.fraction;
}

/** The tree an accepted operation produces. */
function applied(nodes: readonly WorkspaceNode[], result: NodeOperationResult): WorkspaceNode[] {
  return applyNodeWrite(nodes, accepted(result));
}

describe('create', () => {
  it('should mint a pane already carrying its parent, so no second transition has to place it', () => {
    const before = [root()];
    const after = applied(before, create(before, { nodeId: 'p1', target: null, parentId: 'root-1' }));
    expect(findNode(after, 'p1')?.parentId).toBe('root-1');
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should refuse a parent that does not resolve, rather than parking the pane on the root', () => {
    // The failure mode this whole module is shaped against. A pending create
    // naming a container another client just deleted has to be REFUSED so the
    // caller rebases; "put it on the root instead" is not a repair, it is a
    // relocation nobody asked for.
    const result = create([root()], { nodeId: 'p1', target: null, parentId: 'ghost-column' });
    expect(refusedWith(result)).toBe('unknown_parent');
  });

  it('should refuse an id the workspace already holds', () => {
    // `validateTree` does not check id uniqueness, and `upsertNodes` would
    // silently REPLACE the sitting node rather than mint a second one — so an
    // id collision reads as a successful create that quietly ate a pane.
    const before = [root(), pane('p1', 'root-1', 0)];
    const result = create(before, { nodeId: 'p1', target: null, parentId: 'root-1' });
    expect(refusedWith(result)).toBe('duplicate_id');
  });

  it('should refuse a pane as a parent, because a pane is a leaf', () => {
    const before = [root(), pane('p1', 'root-1', 0)];
    const result = create(before, { nodeId: 'p2', target: null, parentId: 'p1' });
    expect(refusedWith(result)).toBe('not_a_container');
  });

  it('should place the pane at the index it was given and renumber the siblings it displaced', () => {
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    const after = applied(
      before,
      create(before, { nodeId: 'fresh', target: null, parentId: 'root-1', index: 1 }),
    );
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['a', 'fresh', 'b']);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should refuse an index past the end of the sibling group rather than clamping it', () => {
    const before = [root(), pane('a', 'root-1', 0)];
    const result = create(before, { nodeId: 'fresh', target: null, parentId: 'root-1', index: 5 });
    expect(refusedWith(result)).toBe('invalid_index');
  });

  it('should refuse a NaN index, which slicing would read as position zero', () => {
    const before = [root(), pane('a', 'root-1', 0)];
    const result = create(before, {
      nodeId: 'fresh',
      target: null,
      parentId: 'root-1',
      index: Number.NaN,
    });
    expect(refusedWith(result)).toBe('invalid_index');
  });

  it('should refuse a fractional index, which slicing would round to somewhere else', () => {
    // `slice(0, 0.5)` is `slice(0, 0)` and `slice(0.5)` is the whole list, so a
    // fractional slot lands at the front while reading as though it were honoured.
    // Unlike NaN and Infinity it survives a bare range check, so the integer test
    // is the only thing that catches it.
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    const result = create(before, { nodeId: 'fresh', target: null, parentId: 'root-1', index: 0.5 });
    expect(refusedWith(result)).toBe('invalid_index');
  });

  it('should refuse a pane minted onto a conversation another node already shows', () => {
    // The database states this as `UNIQUE (targetId) WHERE targetKind = 'chat'`,
    // so the write would come back a raw constraint violation — a failure the
    // model already knew was impossible, arriving as something the client cannot
    // interpret and after the optimistic pane is already on screen.
    const before = [root(), showing('a', 'root-1', 0, { kind: 'chat', id: 'conv-1' })];
    const result = create(before, {
      nodeId: 'fresh',
      target: { kind: 'chat', id: 'conv-1' },
      parentId: 'root-1',
    });
    expect(refusedWith(result)).toBe('target_already_shown');
  });

  it('should mint a second pane onto one page, which the storage deliberately permits', () => {
    // Chat-scoped, exactly as the unique index is. Opening one page twice is a
    // thing users do, and an algebra stricter than its storage is a second rule
    // nobody can see.
    const before = [root(), showing('a', 'root-1', 0, { kind: 'page', id: 'page-1' })];
    const after = applied(
      before,
      create(before, { nodeId: 'fresh', target: { kind: 'page', id: 'page-1' }, parentId: 'root-1' }),
    );
    expect(findNode(after, 'fresh')).toMatchObject({ target: { kind: 'page', id: 'page-1' } });
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should mint a parked pane when given no parent, because detached is a state and not a second act', () => {
    const before = [root()];
    const after = applied(before, create(before, { nodeId: 'parked', target: null, parentId: null }));
    expect(detachedOf(after).map((n) => n.id)).toEqual(['parked']);
    expect(validateTree(after)).toEqual({ ok: true });
  });
});

describe('move', () => {
  it('should take a pane out of the tree when given no parent, which is what closing one is', () => {
    // There is no `close_pane` here. Leaving the tree is a location change like
    // any other, so it is the same operation as arriving in it.
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    const after = applied(before, move(before, { nodeId: 'a', parentId: null, index: 0 }));
    expect(detachedOf(after).map((n) => n.id)).toEqual(['a']);
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['b']);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should reorder a node within its parent and renumber the whole group', () => {
    const before = [
      root(),
      pane('a', 'root-1', 0),
      pane('b', 'root-1', 1),
      pane('c', 'root-1', 2),
    ];
    const after = applied(before, move(before, { nodeId: 'c', parentId: 'root-1', index: 0 }));
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['c', 'a', 'b']);
    expect(childrenOf(after, 'root-1').map((n) => n.position)).toEqual([0, 1, 2]);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should carry a node between parents, leaving both groups contiguous', () => {
    const before = [
      root(),
      split('left', 'root-1', 0),
      split('right', 'root-1', 1),
      pane('a', 'left', 0),
      pane('b', 'left', 1),
      pane('c', 'left', 2),
      pane('d', 'right', 0),
      pane('e', 'right', 1),
    ];
    const after = applied(before, move(before, { nodeId: 'b', parentId: 'right', index: 0 }));
    expect(childrenOf(after, 'right').map((n) => n.id)).toEqual(['b', 'd', 'e']);
    expect(childrenOf(after, 'left').map((n) => n.position)).toEqual([0, 1]);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should give a node arriving under a new parent an even share, never the one it held elsewhere', () => {
    // A share chosen against one container means nothing in another: 60% of a
    // narrow column is not 60% of the grid. So the arrival is a NEWCOMER, and the
    // container it left renormalizes around the gap.
    const before: WorkspaceNode[] = [
      root(),
      { ...split('left', 'root-1', 0), fraction: 0.5 },
      { ...split('right', 'root-1', 1), fraction: 0.5 },
      { ...pane('a', 'left', 0), fraction: 0.6 },
      { ...pane('b', 'left', 1), fraction: 0.2 },
      { ...pane('c', 'left', 2), fraction: 0.2 },
      { ...pane('d', 'right', 0), fraction: 0.9 },
      { ...pane('e', 'right', 1), fraction: 0.1 },
    ];
    const after = applied(before, move(before, { nodeId: 'a', parentId: 'right', index: 0 }));
    expect(shareOf(after, 'a')).toBeCloseTo(1 / 3, 4);
    expect(shareOf(after, 'b')).toBeCloseTo(0.5, 4);
    expect(shareOf(after, 'c')).toBeCloseTo(0.5, 4);
    expect(validateTree(after)).toEqual({ ok: true });
  });
});

describe('move rejections', () => {
  it('should refuse a node id that does not resolve', () => {
    const before = [root(), pane('a', 'root-1', 0)];
    expect(refusedWith(move(before, { nodeId: 'ghost', parentId: 'root-1', index: 0 }))).toBe(
      'unknown_node',
    );
  });

  it('should refuse to move the root, which is the workspace itself', () => {
    const before = [root(), split('col', 'root-1', 0), pane('a', 'col', 0), pane('b', 'col', 1)];
    expect(refusedWith(move(before, { nodeId: 'root-1', parentId: 'col', index: 0 }))).toBe(
      'root_immutable',
    );
  });

  it('should refuse a destination parent that does not resolve, rather than falling back to the root', () => {
    const before = [root(), pane('a', 'root-1', 0)];
    expect(refusedWith(move(before, { nodeId: 'a', parentId: 'ghost-column', index: 0 }))).toBe(
      'unknown_parent',
    );
  });

  it('should refuse a pane as a destination, because a pane holds no children', () => {
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    expect(refusedWith(move(before, { nodeId: 'a', parentId: 'b', index: 0 }))).toBe(
      'not_a_container',
    );
  });

  it('should refuse a node as its own parent', () => {
    const before = [root(), split('col', 'root-1', 0), pane('a', 'col', 0), pane('b', 'col', 1)];
    expect(refusedWith(move(before, { nodeId: 'col', parentId: 'col', index: 0 }))).toBe(
      'parent_in_subtree',
    );
  });

  it('should refuse a destination inside the moving node\u2019s own subtree, which would orphan the branch', () => {
    const before = [
      root(),
      split('outer', 'root-1', 0),
      split('inner', 'outer', 0),
      pane('a', 'outer', 1),
      pane('b', 'inner', 0),
      pane('c', 'inner', 1),
    ];
    expect(refusedWith(move(before, { nodeId: 'outer', parentId: 'inner', index: 0 }))).toBe(
      'parent_in_subtree',
    );
  });

  it('should refuse to park a split, which has no durable target to be parked with', () => {
    const before = [root(), split('col', 'root-1', 0), pane('a', 'col', 0), pane('b', 'col', 1)];
    expect(refusedWith(move(before, { nodeId: 'col', parentId: null, index: 0 }))).toBe(
      'not_detachable',
    );
  });

  it('should refuse a slot the destination does not have, measured after the node has left its old one', () => {
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    // Two children, and `a` is one of them, so the slots after it leaves are 0 and 1.
    expect(refusedWith(move(before, { nodeId: 'a', parentId: 'root-1', index: 2 }))).toBe(
      'invalid_index',
    );
  });
});

describe('degenerate splits', () => {
  it('should collapse a split a move left holding one child, putting that child in the split’s place', () => {
    // Not an optimization. `validateTree` rejects a one-child split, so without
    // the collapse an ordinary close would be an operation that cannot succeed.
    const before = [
      root(),
      split('col', 'root-1', 0),
      pane('other', 'root-1', 1),
      pane('a', 'col', 0),
      pane('b', 'col', 1),
    ];
    const after = applied(before, move(before, { nodeId: 'a', parentId: null, index: 0 }));
    expect(findNode(after, 'col')).toBeUndefined();
    expect(findNode(after, 'b')?.parentId).toBe('root-1');
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['b', 'other']);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should hand the surviving child the split’s own share, so the parent still sums to one', () => {
    const before: WorkspaceNode[] = [
      root(),
      { ...split('col', 'root-1', 0), fraction: 0.7 },
      { ...pane('other', 'root-1', 1), fraction: 0.3 },
      { ...pane('a', 'col', 0), fraction: 0.5 },
      { ...pane('b', 'col', 1), fraction: 0.5 },
    ];
    const after = applied(before, move(before, { nodeId: 'a', parentId: null, index: 0 }));
    expect(findNode(after, 'b')).toMatchObject({ parentId: 'root-1', fraction: 0.7 });
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should collapse a split into the very group the moved node is arriving in', () => {
    const before = [
      root(),
      split('col', 'root-1', 0),
      pane('other', 'root-1', 1),
      pane('a', 'col', 0),
      pane('b', 'col', 1),
    ];
    const after = applied(before, move(before, { nodeId: 'a', parentId: 'root-1', index: 0 }));
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['a', 'b', 'other']);
    expect(validateTree(after)).toEqual({ ok: true });
  });
});

describe('bind', () => {
  it('should fill an empty slot', () => {
    const before = [root(), unbound('a', 'root-1', 0)];
    const after = applied(before, bind(before, { nodeId: 'a', target: { kind: 'chat', id: 'conv-1' } }));
    expect(findNode(after, 'a')).toMatchObject({ target: { kind: 'chat', id: 'conv-1' } });
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should refuse a pane that is already showing something, because a binding is for life', () => {
    // Swapping what a pane displays is two moves, one layer up. Allowing a
    // rebind here would make a pane the same object as its conversation, and we
    // chose the other side of that deliberately.
    const before = [root(), pane('a', 'root-1', 0)];
    const result = bind(before, { nodeId: 'a', target: { kind: 'page', id: 'page-1' } });
    expect(refusedWith(result)).toBe('already_bound');
  });

  it('should refuse a conversation another node in the workspace already shows', () => {
    // One conversation → one workspace → at most one pane, which the table
    // enforces as `UNIQUE (targetId) WHERE targetKind = 'chat'`. The algebra is
    // where a caller is supposed to learn this, BEFORE the optimistic bind is
    // applied and the write goes out to be answered with a raw index violation.
    const before = [
      root(),
      showing('a', 'root-1', 0, { kind: 'chat', id: 'conv-1' }),
      unbound('b', 'root-1', 1),
    ];
    const result = bind(before, { nodeId: 'b', target: { kind: 'chat', id: 'conv-1' } });
    expect(refusedWith(result)).toBe('target_already_shown');
  });

  it('should refuse a conversation only a PARKED node shows, because detaching is not unbinding', () => {
    // A detached pane is still a member of the workspace and still holds its
    // binding — and the unique index does not read `parentId` at all, so a
    // rule that let a parked node's conversation be re-bound would be a rule
    // the storage goes on refusing.
    const before = [
      root(),
      showing('parked', null, 0, { kind: 'chat', id: 'conv-1' }),
      unbound('b', 'root-1', 0),
    ];
    const result = bind(before, { nodeId: 'b', target: { kind: 'chat', id: 'conv-1' } });
    expect(refusedWith(result)).toBe('target_already_shown');
  });

  it('should still fill a slot with a page a second pane already shows', () => {
    const before = [
      root(),
      showing('a', 'root-1', 0, { kind: 'page', id: 'page-1' }),
      unbound('b', 'root-1', 1),
    ];
    const after = applied(before, bind(before, { nodeId: 'b', target: { kind: 'page', id: 'page-1' } }));
    expect(findNode(after, 'b')).toMatchObject({ target: { kind: 'page', id: 'page-1' } });
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should still fill a slot with a terminal a second pane already shows', () => {
    // The constraint is chat-scoped and terminals sit outside it. Extending the
    // rule to them would put the algebra ahead of the storage it validates for,
    // and the stricter of two rules that disagree is the invisible one.
    const before = [
      root(),
      showing('a', 'root-1', 0, { kind: 'terminal', id: 'shell-1' }),
      unbound('b', 'root-1', 1),
    ];
    const after = applied(
      before,
      bind(before, { nodeId: 'b', target: { kind: 'terminal', id: 'shell-1' } }),
    );
    expect(findNode(after, 'b')).toMatchObject({ target: { kind: 'terminal', id: 'shell-1' } });
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should refuse a pane re-bound to the very conversation it already shows as already_bound', () => {
    // The pane showing the target IS the node being bound, so nothing is being
    // shown twice — the fault is that a binding is for life, which is a
    // different bug with a different fix. Pinned so the new rule cannot drift
    // into answering for this one.
    const before = [root(), pane('a', 'root-1', 0)];
    const result = bind(before, { nodeId: 'a', target: { kind: 'chat', id: 'conv-a' } });
    expect(refusedWith(result)).toBe('already_bound');
  });

  it('should refuse a split, which shows nothing of its own', () => {
    const before = [root(), split('col', 'root-1', 0), pane('a', 'col', 0), pane('b', 'col', 1)];
    const result = bind(before, { nodeId: 'col', target: { kind: 'chat', id: 'conv-1' } });
    expect(refusedWith(result)).toBe('not_a_pane');
  });

  it('should refuse the root', () => {
    const before = [root(), unbound('a', 'root-1', 0)];
    const result = bind(before, { nodeId: 'root-1', target: { kind: 'chat', id: 'conv-1' } });
    expect(refusedWith(result)).toBe('root_immutable');
  });

  it('should refuse a node id that does not resolve', () => {
    const before = [root(), unbound('a', 'root-1', 0)];
    const result = bind(before, { nodeId: 'ghost', target: { kind: 'chat', id: 'conv-1' } });
    expect(refusedWith(result)).toBe('unknown_node');
  });

  it('should refuse a target with a blank id, which would bind the pane to nothing for good', () => {
    // A pane whose target is an empty string is not unbound — it will never
    // render the picker again — so this has to be caught here or not at all.
    const before = [root(), unbound('a', 'root-1', 0)];
    const result = bind(before, { nodeId: 'a', target: { kind: 'chat', id: '  ' } });
    expect(refusedWith(result)).toBe('invalid_target');
  });
});

describe('resize', () => {
  it('should give a node the share it asked for and let its siblings absorb the difference', () => {
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    const after = applied(before, resize(before, { nodeId: 'a', fraction: 0.7 }));
    expect(shareOf(after, 'a')).toBeCloseTo(0.7, 5);
    expect(shareOf(after, 'b')).toBeCloseTo(0.3, 5);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should materialize an unsized container, because an even split stops being derivable', () => {
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1), pane('c', 'root-1', 2)];
    const after = applied(before, resize(before, { nodeId: 'a', fraction: 0.5 }));
    expect(shareOf(after, 'b')).toBeCloseTo(0.25, 5);
    expect(shareOf(after, 'c')).toBeCloseTo(0.25, 5);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should refuse a NaN share, which the validator’s sum check waves through', () => {
    // `Math.abs(NaN - 1) >= FRACTION_EPSILON` is FALSE, so a NaN reaches the
    // database looking like a container that adds up.
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    expect(refusedWith(resize(before, { nodeId: 'a', fraction: Number.NaN }))).toBe(
      'invalid_fraction',
    );
  });

  it('should refuse a share of the whole container or of none of it', () => {
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    expect(refusedWith(resize(before, { nodeId: 'a', fraction: 0 }))).toBe('invalid_fraction');
    expect(refusedWith(resize(before, { nodeId: 'a', fraction: 1 }))).toBe('invalid_fraction');
    expect(refusedWith(resize(before, { nodeId: 'a', fraction: Number.POSITIVE_INFINITY }))).toBe(
      'invalid_fraction',
    );
  });

  it('should refuse the root, which is not a share of anything', () => {
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    expect(refusedWith(resize(before, { nodeId: 'root-1', fraction: 0.5 }))).toBe('root_immutable');
  });

  it('should refuse a parked pane, which sits in no container', () => {
    const before = [root(), pane('a', 'root-1', 0), pane('parked', null, 0)];
    expect(refusedWith(resize(before, { nodeId: 'parked', fraction: 0.5 }))).toBe('not_sizable');
  });

  it('should refuse a lone child, which already owns the whole container', () => {
    const before = [root(), pane('only', 'root-1', 0)];
    expect(refusedWith(resize(before, { nodeId: 'only', fraction: 0.5 }))).toBe('not_sizable');
  });

  it('should refuse a node id that does not resolve', () => {
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    expect(refusedWith(resize(before, { nodeId: 'ghost', fraction: 0.5 }))).toBe('unknown_node');
  });
});

describe('destroy', () => {
  it('should remove the node and its whole subtree, never just the node', () => {
    const before = [
      root(),
      split('col', 'root-1', 0),
      pane('other', 'root-1', 1),
      pane('a', 'col', 0),
      pane('b', 'col', 1),
    ];
    const after = applied(before, destroy(before, { nodeId: 'col' }));
    expect(after.map((n) => n.id).sort()).toEqual(['other', 'root-1']);
    expect(childrenOf(after, 'root-1').map((n) => n.position)).toEqual([0]);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should collapse a split its removal left holding one child', () => {
    const before = [
      root(),
      split('col', 'root-1', 0),
      pane('other', 'root-1', 1),
      pane('a', 'col', 0),
      pane('b', 'col', 1),
    ];
    const after = applied(before, destroy(before, { nodeId: 'a' }));
    expect(findNode(after, 'col')).toBeUndefined();
    expect(childrenOf(after, 'root-1').map((n) => n.id)).toEqual(['b', 'other']);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should remove a parked pane and renumber the ones left beside it', () => {
    const before = [root(), pane('first', null, 0), pane('second', null, 1), pane('third', null, 2)];
    const after = applied(before, destroy(before, { nodeId: 'first' }));
    expect(detachedOf(after).map((n) => n.id)).toEqual(['second', 'third']);
    expect(detachedOf(after).map((n) => n.position)).toEqual([0, 1]);
    expect(validateTree(after)).toEqual({ ok: true });
  });

  it('should refuse the root, because a workspace cannot destroy itself', () => {
    const before = [root(), pane('a', 'root-1', 0)];
    expect(refusedWith(destroy(before, { nodeId: 'root-1' }))).toBe('root_immutable');
  });

  it('should refuse a node id that does not resolve', () => {
    const before = [root(), pane('a', 'root-1', 0)];
    expect(refusedWith(destroy(before, { nodeId: 'ghost' }))).toBe('unknown_node');
  });
});

describe('the result gate', () => {
  it('should refuse to operate on a set in which two nodes already share an id', () => {
    // `validateTree` has nothing to say about this, and every helper resolves an
    // id to the first match — so the second node is not corrupt, it is invisible.
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1), pane('b', 'root-1', 1)];
    expect(refusedWith(resize(before, { nodeId: 'a', fraction: 0.6 }))).toBe('duplicate_id');
  });

  it('should refuse to operate on a set in which a pane already holds children', () => {
    const before = [
      root(),
      pane('leaf', 'root-1', 0),
      pane('other', 'root-1', 1),
      pane('impossible', 'leaf', 0),
    ];
    expect(refusedWith(move(before, { nodeId: 'other', parentId: 'root-1', index: 0 }))).toBe(
      'not_a_container',
    );
  });

  it('should refuse to operate on a container holding a NaN share it is not itself rewriting', () => {
    // A group an operation DOES reseat launders its shares through
    // `rebalanceFractions`, which reads a non-finite one as absent. A group it
    // leaves alone keeps whatever it had, and `validateTree` waves NaN through —
    // so this gate is the only thing between a corrupt share and a `real` column.
    const before: WorkspaceNode[] = [
      root(),
      split('col', 'root-1', 0),
      { ...pane('a', 'col', 0), fraction: Number.NaN },
      { ...pane('b', 'col', 1), fraction: Number.NaN },
      unbound('c', 'root-1', 1),
    ];
    expect(refusedWith(bind(before, { nodeId: 'c', target: { kind: 'chat', id: 'conv-1' } }))).toBe(
      'invalid_fraction',
    );
  });

  it('should refuse to create in a workspace that has no root, rather than inventing one', () => {
    // The root is minted when the workspace is provisioned. There is deliberately
    // no operation here that can bring one into being.
    expect(refusedWith(create([], { nodeId: 'p1', target: null, parentId: null }))).toBe('no_root');
  });
});

describe('every operation', () => {
  it('should leave its input untouched', () => {
    const before = [root(), split('col', 'root-1', 0), pane('a', 'col', 0), pane('b', 'col', 1)];
    const snapshot = JSON.parse(JSON.stringify(before)) as WorkspaceNode[];
    move(before, { nodeId: 'a', parentId: null, index: 0 });
    destroy(before, { nodeId: 'col' });
    resize(before, { nodeId: 'a', fraction: 0.8 });
    create(before, { nodeId: 'fresh', target: null, parentId: 'col' });
    bind(before, { nodeId: 'a', target: { kind: 'page', id: 'page-1' } });
    expect(before).toEqual(snapshot);
  });

  it('should write nothing when asked for the state a node is already in', () => {
    // A re-sent request must not bump a rev or broadcast, which is what the old
    // reducer's `next !== state` check bought and what an empty write buys here.
    const before = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    expect(accepted(move(before, { nodeId: 'a', parentId: 'root-1', index: 0 }))).toEqual({
      put: [],
      drop: [],
    });
  });
});
