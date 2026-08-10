/**
 * `validateTree` — the invariants a flat parent pointer can express but the
 * node types cannot state.
 *
 * The model is FLAT by decision (see `workspace-node.ts`), and this suite is
 * the price of that decision: a nested type cannot spell a cycle, a dangling
 * parent, or two roots, and a flat one can. Every write path on both planes
 * runs this function before persisting, so a gap here is a corrupt tree in the
 * database.
 *
 * Each test drives ONE violation and asserts its `code`, because the code is
 * what the server turns into a rejection and the client logs — the prose
 * `detail` is for humans and is deliberately not asserted on.
 */
import { describe, it, expect } from 'vitest';
import { validateTree, MAX_DEPTH, MAX_NODES } from '../workspace-node-validate';
import type { PaneNode, PaneTarget, RootNode, SplitNode, WorkspaceNode } from '../workspace-node';

function root(): RootNode {
  return { nodeType: 'root', id: 'root-1', parentId: null, position: 0, axis: 'row' };
}

function split(id: string, parentId: string, position: number): SplitNode {
  return { nodeType: 'split', id, parentId, position, axis: 'column' };
}

function pane(id: string, parentId: string, position: number): PaneNode {
  return { nodeType: 'pane', id, parentId, position, target: { kind: 'chat', id: `conv-${id}` } };
}

/**
 * A pane with NO PARENT — the state the model makes unspellable and a ROW can
 * still carry.
 *
 * The cast is the fixture's whole reason for existing. `PaneNode.parentId` is a
 * `string`, so nothing in the package can build one of these; nine
 * mostly-nullable columns can, and `validateTree` is what stands between such a
 * row and a workspace. Every test that uses this is testing the half of the
 * failure shape the previous model could not see, because it had made this state
 * legal and called it "detached".
 */
function parentless(id: string, position = 0): WorkspaceNode {
  return { nodeType: 'pane', id, parentId: null, position, target: null } as unknown as WorkspaceNode;
}

/**
 * A pane bound to a target the caller names. `pane` derives a chat target from
 * the node id, which is what keeps every other fixture's bindings distinct — so
 * the tests about two nodes naming ONE target have to spell the target out.
 */
function showing(
  id: string,
  parentId: string,
  position: number,
  target: PaneTarget,
): PaneNode {
  return { nodeType: 'pane', id, parentId, position, target };
}

/**
 * A tree nested `splitCount` splits deep, whose deepest nodes therefore sit at
 * depth `splitCount + 1`. Every split is given two children so the tree
 * satisfies every OTHER invariant — the depth tests must fail on depth alone,
 * not on a degenerate split the fixture happened to build.
 */
function deepTree(splitCount: number): WorkspaceNode[] {
  const nodes: WorkspaceNode[] = [root()];
  let parentId = 'root-1';
  for (let level = 1; level <= splitCount; level += 1) {
    nodes.push(split(`s${level}`, parentId, 0), pane(`beside-${level}`, parentId, 1));
    parentId = `s${level}`;
  }
  nodes.push(pane('leaf-a', parentId, 0), pane('leaf-b', parentId, 1));
  return nodes;
}

/** A pane carrying an explicit share of its parent. */
function sized(
  id: string,
  parentId: string,
  position: number,
  fraction: number,
): PaneNode {
  return { ...pane(id, parentId, position), fraction };
}

/** A root holding `paneCount` panes, so `paneCount + 1` nodes in all. */
function wideTree(paneCount: number): WorkspaceNode[] {
  const nodes: WorkspaceNode[] = [root()];
  for (let index = 0; index < paneCount; index += 1) {
    nodes.push(pane(`p${index}`, 'root-1', index));
  }
  return nodes;
}

describe('validateTree', () => {
  it('should accept a well-formed tree', () => {
    const nodes: WorkspaceNode[] = [
      root(),
      split('col', 'root-1', 0),
      pane('top', 'col', 0),
      pane('bottom', 'col', 1),
      pane('beside', 'root-1', 1),
    ];
    expect(validateTree(nodes)).toEqual({ ok: true });
  });

  it('should reject a NON-EMPTY list with no root', () => {
    const nodes: WorkspaceNode[] = [pane('orphan', 'gone', 0)];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'no_root' });
  });

  it('should ACCEPT an empty list, which is what destroying the root leaves behind', () => {
    // One removal: `destroy(rootId)` ends the session, and what it leaves is no
    // nodes at all. Calling that `no_root` would make the tree operation that
    // ends a session produce a tree the write path refuses — which is exactly
    // how ending a session became a second mechanism last time.
    expect(validateTree([])).toEqual({ ok: true });
  });

  it('should find the root by its TYPE, which a row can contradict', () => {
    // A pane row carrying a null parent is not a root and must not be read as
    // one — it is `null_parent`, the fault the previous model had no code for
    // because it had made the state legal.
    const nodes: WorkspaceNode[] = [parentless('impostor'), root(), pane('onscreen', 'root-1', 0)];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'null_parent' });
  });

  it('should reject a tree with more than one root', () => {
    const nodes: WorkspaceNode[] = [root(), { ...root(), id: 'root-2' }];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'multiple_roots' });
  });

  it('should reject two nodes sharing an id', () => {
    // Ids are minted on the CLIENT, so a collision is reachable rather than
    // theoretical. Every helper that resolves by id — `findNode`, `childrenOf`,
    // the reachability walk's visited set — silently picks one of the pair, so
    // a colliding tree validates as whichever half the lookups happened to
    // land on and then persists both.
    const nodes: WorkspaceNode[] = [root(), pane('twin', 'root-1', 0), pane('twin', 'root-1', 1)];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'duplicate_id' });
  });

  it('should reject a node whose id is blank, which every later read of the workspace then throws on', () => {
    // The same class as a duplicate id and every bit as invariant: an id is
    // what the whole model resolves by. The difference is where it lands.
    // Postgres stores `''` happily (`text NOT NULL` is satisfied), and
    // `nodeFromRow` then rejects it — and `nodesFromRows` rejects the WHOLE
    // set rather than filtering, deliberately — so the workspace becomes
    // permanently unreadable and the read is the only way in.
    //
    // This is the gate every write path runs, and the wire's primitive is
    // `put(nodes[])`: a client that assembled its own node set never goes
    // through the algebra's operations at all.
    expect(validateTree([{ ...root(), id: '' }])).toMatchObject({ ok: false, code: 'blank_id' });
    expect(validateTree([root(), pane('', 'root-1', 0)])).toMatchObject({
      ok: false,
      code: 'blank_id',
    });
  });

  it('should reject a whitespace-only id, which the row parse’s min-length check would let through', () => {
    // `z.string().min(1)` at the row boundary is satisfied by `'   '`, so this
    // one survives the read and lands as a node nothing can address. The
    // algebra spells the rule as `trim() === ''` in `bind` and `create`; this
    // is the same rule where the set-level write can see it.
    expect(validateTree([root(), pane('   ', 'root-1', 0)])).toMatchObject({
      ok: false,
      code: 'blank_id',
    });
  });

  it('should reject a pane bound to a target with a blank id, which is the same row made unreadable', () => {
    // `targetId` is `z.string().min(1)` on the way back in, so a blank one
    // throws in exactly the same place a blank node id does — and a binding is
    // for life, so nothing later corrects it.
    const nodes: WorkspaceNode[] = [root(), showing('a', 'root-1', 0, { kind: 'chat', id: '  ' })];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'blank_id' });
  });

  it('should reject a parentId naming a node that is not in the set', () => {
    const nodes: WorkspaceNode[] = [root(), pane('orphan', 'column-that-was-closed', 0)];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'dangling_parent' });
  });

  it('should reject a cycle of parent pointers', () => {
    // The violation a nested tree type could not spell, and the whole reason
    // this function exists.
    const nodes: WorkspaceNode[] = [root(), split('a', 'b', 0), split('b', 'a', 0)];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'cycle' });
  });

  it('should reject a node parented to itself', () => {
    const nodes: WorkspaceNode[] = [root(), split('self', 'self', 0)];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'cycle' });
  });

  it('should reject a node that hangs off the tree instead of descending from the root', () => {
    // Acyclic and every pointer resolves, yet nothing renders it: a second root
    // claims no parent, so the descent from the real root never reaches what
    // sits beneath it.
    const nodes: WorkspaceNode[] = [
      root(),
      { ...root(), id: 'root-2', nodeType: 'split', parentId: 'gone' } as unknown as WorkspaceNode,
    ];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'dangling_parent' });

    const stowaway: WorkspaceNode[] = [root(), split('loose', 'loose-2', 0), split('loose-2', 'loose', 1)];
    expect(validateTree(stowaway)).toMatchObject({ ok: false, code: 'cycle' });
  });

  it('should REFUSE a pane with no parent, and name it `null_parent` rather than `unreachable`', () => {
    // The correction. This state used to be legal and called "detached" — in
    // the workspace, off the grid — which meant a pane a user closed and a pane
    // that lost its parent to a defect were the same row. `unreachable` is also
    // true of it and is the wrong thing to say: that describes the consequence
    // (nothing would render it), and the fault is that the node is nowhere.
    const nodes: WorkspaceNode[] = [root(), pane('onscreen', 'root-1', 0), parentless('lost')];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'null_parent' });
  });

  it('should report `null_parent` ahead of a dangling parent elsewhere in the same tree', () => {
    // Both are broken pointers and they break differently. A pointer that named
    // a place now gone is a rebase problem; a pointer that named no place is a
    // writer that never set one. The fixed order means one bad tree always
    // yields the more primitive of the two.
    const nodes: WorkspaceNode[] = [root(), parentless('lost'), pane('dangling', 'nowhere', 1)];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'null_parent' });
  });

  it('should reject a tree nested deeper than MAX_DEPTH', () => {
    expect(validateTree(deepTree(MAX_DEPTH))).toMatchObject({
      ok: false,
      code: 'max_depth_exceeded',
    });
  });

  it('should accept a tree nested exactly MAX_DEPTH deep', () => {
    // The cap is inclusive. An off-by-one here rejects a grid a user built.
    expect(validateTree(deepTree(MAX_DEPTH - 1))).toEqual({ ok: true });
  });

  it('should reject a tree of more than MAX_NODES nodes', () => {
    expect(validateTree(wideTree(MAX_NODES))).toMatchObject({
      ok: false,
      code: 'max_nodes_exceeded',
    });
  });

  it('should accept a tree of exactly MAX_NODES nodes', () => {
    // The cap is inclusive, and it has to clear the largest grid the model
    // this replaces could express (64 columns × 16 panes ≈ 1089 nodes once
    // migrated) or Phase 3 would reject production workspaces.
    expect(validateTree(wideTree(MAX_NODES - 1))).toEqual({ ok: true });
  });

  it('should reject a split left holding a single child', () => {
    // The algebra collapses a split down to one member on `move`. This is the
    // check that proves it did.
    const nodes: WorkspaceNode[] = [root(), split('lonely', 'root-1', 0), pane('only', 'lonely', 0)];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'degenerate_split' });
  });

  it('should reject a split left holding nothing at all', () => {
    const nodes: WorkspaceNode[] = [root(), split('empty', 'root-1', 0)];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'degenerate_split' });
  });

  it('should accept a split holding more than two children', () => {
    // Two is a floor, not a shape: a column of three panes is ordinary.
    const nodes: WorkspaceNode[] = [
      root(),
      split('col', 'root-1', 0),
      pane('a', 'col', 0),
      pane('b', 'col', 1),
      pane('c', 'col', 2),
    ];
    expect(validateTree(nodes)).toEqual({ ok: true });
  });

  it('should accept a root holding a single pane, which is an ordinary workspace', () => {
    // The root is not a split. A workspace with one pane in it is the state
    // every workspace opens in, and it must not read as degenerate.
    expect(validateTree([root(), pane('only', 'root-1', 0)])).toEqual({ ok: true });
  });

  it('should reject a pane holding children, because a pane is a leaf by definition', () => {
    // Only a root and a split hold children — a pane is a viewport onto ONE
    // target, so a node parented into one is a subtree no renderer has a place
    // for. The types cannot say this: `PaneNode.parentId` is an ordinary
    // string, so nothing stops a bad `move` from naming a pane as a container.
    const nodes: WorkspaceNode[] = [root(), pane('leaf', 'root-1', 0), pane('stowaway', 'leaf', 0)];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'pane_has_children' });
  });

  it('should reject a sibling group where only some members carry a fraction', () => {
    // Absence IS the state — an unsized container splits evenly. A group half
    // sized has no defensible rendering, so it is never half-trusted.
    const nodes: WorkspaceNode[] = [
      root(),
      sized('a', 'root-1', 0, 0.5),
      pane('b', 'root-1', 1),
    ];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'fraction_mixed' });
  });

  it('should reject a sibling group whose fractions do not settle to 1', () => {
    const nodes: WorkspaceNode[] = [
      root(),
      sized('a', 'root-1', 0, 0.5),
      sized('b', 'root-1', 1, 0.3),
    ];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'fraction_sum' });
  });

  it('should reject a NaN fraction, which the sum check alone cannot catch', () => {
    // `Math.abs(NaN - 1) >= FRACTION_EPSILON` is FALSE — every comparison
    // against NaN is — so a group summing to NaN sails through the check that
    // exists to stop exactly this. And NaN is a value this path produces: the
    // client's optimistic resize divides an offset by its container's extent,
    // and a container that has not laid out yet has an extent of 0.
    //
    // It is also self-propagating. Once one NaN persists, every future group
    // holding that node sums to NaN and passes too, so the tree can never
    // again fail the sum check — which is why the guard is on the VALUE and
    // not on the total.
    const nodes: WorkspaceNode[] = [
      root(),
      sized('a', 'root-1', 0, Number.NaN),
      sized('b', 'root-1', 1, 0.5),
    ];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'fraction_not_finite' });
  });

  it('should reject infinite fractions, the same defect wearing a different value', () => {
    // The pair is chosen to sum to NaN, so this tree passes today for the same
    // reason the one above does: an infinity divided out of a zero extent is
    // one signed step away from a NaN, and neither is a share of anything.
    const nodes: WorkspaceNode[] = [
      root(),
      sized('a', 'root-1', 0, Number.POSITIVE_INFINITY),
      sized('b', 'root-1', 1, Number.NEGATIVE_INFINITY),
    ];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'fraction_not_finite' });
  });

  it('should report a non-finite fraction ahead of the sum it would otherwise poison', () => {
    // POSITION, not merely presence. Unlike a NaN, a lone infinity does fail
    // the sum comparison — so a finiteness guard sitting after that comparison
    // would report `fraction_sum` here and send the client off to rebalance
    // shares, which is a repair that cannot converge on an infinity. The terms
    // are judged before the total they feed.
    const nodes: WorkspaceNode[] = [
      root(),
      sized('a', 'root-1', 0, Number.POSITIVE_INFINITY),
      sized('b', 'root-1', 1, 0.5),
    ];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'fraction_not_finite' });
  });

  it('should accept a sibling group whose fractions sum to 1 only within FRACTION_EPSILON', () => {
    // Seven even shares do not add up to exactly 1 in binary floating point.
    // Exact equality here would reject a grid the resize verbs themselves
    // produce, which is what the epsilon exists to prevent.
    const seventh = 1 / 7;
    const shares = [seventh, seventh, seventh, seventh, seventh, seventh, seventh];
    expect(shares.reduce((running, share) => running + share, 0)).not.toBe(1);
    const nodes: WorkspaceNode[] = [
      root(),
      ...shares.map((share, index) => sized(`p${index}`, 'root-1', index, share)),
    ];
    expect(validateTree(nodes)).toEqual({ ok: true });
  });

  it('should accept a sibling group in which no member carries a fraction', () => {
    // Unsized is the opening state of every container, not a defect.
    const nodes: WorkspaceNode[] = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    expect(validateTree(nodes)).toEqual({ ok: true });
  });

  it('should judge each sibling group on its own, not on the fractions of the whole tree', () => {
    // A sized column inside an unsized root: both containers satisfy the
    // invariant, and summing across them would see 2 and reject.
    const nodes: WorkspaceNode[] = [
      root(),
      split('col', 'root-1', 0),
      pane('beside', 'root-1', 1),
      sized('top', 'col', 0, 0.25),
      sized('bottom', 'col', 1, 0.75),
    ];
    expect(validateTree(nodes)).toEqual({ ok: true });
  });

  it('should reject a non-finite share wherever it sits, because it is a fact about ONE number', () => {
    // This check used to live inside the per-container loop, under the skip
    // that exempted the parked group — so a NaN on a parked pane was exempted
    // by POSITION rather than by intent and sailed through. There is no parked
    // group to be exempt from anything now, and the check is still stated over
    // every node rather than per container, because finiteness has no
    // group-level precondition.
    //
    // Postgres `real` takes NaN and Infinity happily, and `nodeFromRow` then
    // throws on the way back — an unreadable workspace, reached by resizing a
    // pane before its container had laid out.
    const notANumber: WorkspaceNode[] = [
      root(),
      sized('a', 'root-1', 0, Number.NaN),
      sized('b', 'root-1', 1, 0.5),
    ];
    expect(validateTree(notANumber)).toMatchObject({ ok: false, code: 'fraction_not_finite' });

    const infinite: WorkspaceNode[] = [
      root(),
      sized('a', 'root-1', 0, Number.POSITIVE_INFINITY),
      sized('b', 'root-1', 1, 0.5),
    ];
    expect(validateTree(infinite)).toMatchObject({ ok: false, code: 'fraction_not_finite' });
  });

  it('should not require an unsized container’s children to carry a share', () => {
    const nodes: WorkspaceNode[] = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    expect(validateTree(nodes)).toEqual({ ok: true });
  });

  it('should reject a sibling group whose positions leave a gap', () => {
    // Contiguous and 0-based is the convention the rows already document; a
    // gap means some verb renumbered part of a group and stopped.
    const nodes: WorkspaceNode[] = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 2)];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'position_contiguity' });
  });

  it('should reject a sibling group where two members claim the same position', () => {
    const nodes: WorkspaceNode[] = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 0)];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'position_contiguity' });
  });

  it('should reject a sibling group numbered from 1 instead of 0', () => {
    const nodes: WorkspaceNode[] = [root(), pane('a', 'root-1', 1), pane('b', 'root-1', 2)];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'position_contiguity' });
  });

  it('should hold a nested container to the same ordering as the root’s own children', () => {
    const nodes: WorkspaceNode[] = [
      root(),
      split('col', 'root-1', 0),
      pane('beside', 'root-1', 1),
      pane('top', 'col', 0),
      pane('bottom', 'col', 3),
    ];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'position_contiguity' });
  });

  it('should not put the ROOT in a sibling group, so its position 0 collides with nothing', () => {
    // The root is a container, not a member of one. It is also the only node
    // with a null parent, which is why grouping by `parentId` can no longer
    // collide it with anything: there is nothing else in that bucket.
    const nodes: WorkspaceNode[] = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    expect(validateTree(nodes)).toEqual({ ok: true });
  });

  it('should reject two panes showing one conversation, the rule the chat unique index states', () => {
    // `UNIQUE (targetId) WHERE targetKind = 'chat'`, in the model. One
    // conversation belongs to exactly one workspace and renders in at most one
    // pane, so a set naming it twice is a set the storage will refuse — and a
    // write path that only learned that from the database would have to unwind
    // an already-applied optimistic edit out of a raw constraint error.
    const nodes: WorkspaceNode[] = [
      root(),
      showing('a', 'root-1', 0, { kind: 'chat', id: 'conv-1' }),
      showing('b', 'root-1', 1, { kind: 'chat', id: 'conv-1' }),
    ];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'duplicate_chat_target' });
  });

  it('should count a node anywhere in the tree, because the index does not read parentId', () => {
    // The unique index is on `targetId` alone; where a node sits has never been
    // part of it. Nesting a duplicate two levels down must not slip past.
    const nodes: WorkspaceNode[] = [
      root(),
      split('col', 'root-1', 0),
      showing('deep', 'col', 0, { kind: 'chat', id: 'conv-1' }),
      pane('filler', 'col', 1),
      showing('shallow', 'root-1', 1, { kind: 'chat', id: 'conv-1' }),
    ];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'duplicate_chat_target' });
  });

  it('should accept two panes showing one page, which the storage deliberately permits', () => {
    // The index is partial on `targetKind = 'chat'`, and that is a decision:
    // opening the same page in two panes is an ordinary thing a user does.
    const nodes: WorkspaceNode[] = [
      root(),
      showing('a', 'root-1', 0, { kind: 'page', id: 'page-1' }),
      showing('b', 'root-1', 1, { kind: 'page', id: 'page-1' }),
    ];
    expect(validateTree(nodes)).toEqual({ ok: true });
  });

  it('should accept two panes showing one terminal, for the same reason', () => {
    const nodes: WorkspaceNode[] = [
      root(),
      showing('a', 'root-1', 0, { kind: 'terminal', id: 'shell-1' }),
      showing('b', 'root-1', 1, { kind: 'terminal', id: 'shell-1' }),
    ];
    expect(validateTree(nodes)).toEqual({ ok: true });
  });

  it('should not read one id across two kinds as a collision', () => {
    // `targetId` is polymorphic — a conversation id and a page id are drawn
    // from different spaces and may coincide. The index is predicated on the
    // KIND, so a check that keyed on the id alone would refuse a legal tree.
    const nodes: WorkspaceNode[] = [
      root(),
      showing('a', 'root-1', 0, { kind: 'chat', id: 'shared-id' }),
      showing('b', 'root-1', 1, { kind: 'page', id: 'shared-id' }),
    ];
    expect(validateTree(nodes)).toEqual({ ok: true });
  });

  it('should reject an unresolvable parentId rather than repairing it by re-parenting to the root', () => {
    // THE failure mode this model exists to make unspellable: a pane silently
    // relocating into a container the user never put it in. A pending move
    // naming a parent another client just deleted must be REJECTED so the
    // client rebases — never "attached to the root" as a fallback, which is
    // how a pane ends up in a different session's grid.
    const nodes: WorkspaceNode[] = [root(), pane('moving', 'column-another-client-deleted', 0)];
    const before = structuredClone(nodes);

    const result = validateTree(nodes);

    expect(result).toMatchObject({ ok: false, code: 'dangling_parent' });
    // The node still names the parent it was given. Nothing was reattached.
    expect(nodes).toEqual(before);
  });

  it('should return a verdict and nothing else, never a repaired tree', () => {
    // A validator, not a fixer. `toEqual` is exact, so a result smuggling back
    // a corrected node list fails here — and the signature has no room for one.
    const valid: WorkspaceNode[] = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 1)];
    expect(validateTree(valid)).toEqual({ ok: true });

    const broken: WorkspaceNode[] = [root(), pane('a', 'root-1', 0), pane('b', 'root-1', 2)];
    expect(validateTree(broken)).toEqual({
      ok: false,
      code: 'position_contiguity',
      detail: expect.any(String),
    });
  });

  // The order violations are reported in is a CONTRACT, not an accident: one
  // bad tree must always yield one code, or a server rejection and a client
  // log would disagree about the same write. Each of these trees breaks two
  // invariants at once and pins which code wins.
  it('should report the node cap ahead of anything else it would also fail', () => {
    // Over the cap, rootless, and every pane dangling — the cap still wins,
    // because it is what bounds the work the other checks would do.
    const oversized = wideTree(MAX_NODES + 1).filter((node) => node.nodeType !== 'root');
    expect(validateTree(oversized)).toMatchObject({ ok: false, code: 'max_nodes_exceeded' });
  });

  it('should report a dangling parent ahead of a cycle elsewhere in the tree', () => {
    // Everything downstream walks parent pointers, so an unresolvable one has
    // to be settled before a walk can be trusted to mean anything.
    const nodes: WorkspaceNode[] = [
      root(),
      split('a', 'b', 0),
      split('b', 'a', 0),
      pane('orphan', 'ghost', 0),
    ];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'dangling_parent' });
  });

  it('should report a degenerate split ahead of an ordering fault in another group', () => {
    const nodes: WorkspaceNode[] = [
      root(),
      split('lonely', 'root-1', 0),
      pane('only', 'lonely', 0),
      pane('gap', 'root-1', 2),
    ];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'degenerate_split' });
  });

  it('should report a fraction fault ahead of an ordering fault in another group', () => {
    // The two live in separate passes precisely so group iteration order
    // cannot decide which one a tree reports.
    const nodes: WorkspaceNode[] = [
      root(),
      split('col', 'root-1', 0),
      sized('top', 'col', 0, 0.5),
      pane('bottom', 'col', 1),
      pane('gap', 'root-1', 2),
    ];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'fraction_mixed' });
  });

  it('should report an ordering fault ahead of a duplicated conversation', () => {
    // The binding rule is the one DOMAIN invariant here and it runs last, after
    // the tree is known to be well formed. A set that is both misnumbered and
    // double-bound has a structural fault, and "your positions are wrong" is
    // the truer thing to say about a tree nothing can render correctly.
    const nodes: WorkspaceNode[] = [
      root(),
      showing('a', 'root-1', 0, { kind: 'chat', id: 'conv-1' }),
      showing('b', 'root-1', 2, { kind: 'chat', id: 'conv-1' }),
    ];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'position_contiguity' });
  });

  it('should leave its input untouched, whether it accepts or rejects', () => {
    // Both fixtures run all the way to the ordering pass — the last thing the
    // validator touches — so a check that "helpfully" renumbered or reseated a
    // node on its way through would show up here.
    const accepted: WorkspaceNode[] = [
      root(),
      split('col', 'root-1', 0),
      sized('top', 'col', 0, 0.4),
      sized('bottom', 'col', 1, 0.6),
      pane('beside', 'root-1', 1),
    ];
    const acceptedBefore = structuredClone(accepted);
    expect(validateTree(accepted)).toEqual({ ok: true });
    expect(accepted).toEqual(acceptedBefore);

    const rejected: WorkspaceNode[] = [
      root(),
      pane('a', 'root-1', 0),
      pane('b', 'root-1', 2),
      pane('c', 'root-1', 3),
    ];
    const rejectedBefore = structuredClone(rejected);
    expect(validateTree(rejected)).toMatchObject({ ok: false, code: 'position_contiguity' });
    expect(rejected).toEqual(rejectedBefore);
  });
});
