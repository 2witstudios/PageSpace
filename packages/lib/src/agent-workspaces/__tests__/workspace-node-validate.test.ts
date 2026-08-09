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

function pane(id: string, parentId: string | null, position: number): PaneNode {
  return { nodeType: 'pane', id, parentId, position, target: { kind: 'chat', id: `conv-${id}` } };
}

/**
 * A pane bound to a target the caller names. `pane` derives a chat target from
 * the node id, which is what keeps every other fixture's bindings distinct — so
 * the tests about two nodes naming ONE target have to spell the target out.
 */
function showing(
  id: string,
  parentId: string | null,
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
  parentId: string | null,
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

  it('should reject a tree with no root', () => {
    const nodes: WorkspaceNode[] = [pane('parked', null, 0)];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'no_root' });
  });

  it('should reject an empty list, because a workspace without a root is not vacuously fine', () => {
    expect(validateTree([])).toMatchObject({ ok: false, code: 'no_root' });
  });

  it('should find the root by its type even when a parked pane comes first in the list', () => {
    // The root and a parked pane both carry a null parent, so "the node with
    // no parent" identifies neither. A validator that took the first null
    // parent would crown the parked pane and declare the real grid unreachable
    // — which is the confusion between membership and location that this whole
    // model exists to remove.
    const nodes: WorkspaceNode[] = [pane('parked', null, 0), root(), pane('onscreen', 'root-1', 0)];
    expect(validateTree(nodes)).toEqual({ ok: true });
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
    // Acyclic and every pointer resolves, yet nothing renders it: the chain
    // terminates at a parked pane rather than at the root.
    const nodes: WorkspaceNode[] = [root(), pane('parked', null, 0), pane('stowaway', 'parked', 0)];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'unreachable' });
  });

  it('should accept a detached pane, which is in the workspace but off the grid', () => {
    // The one exception to reachability, and the reason the model is flat: a
    // parked pane is a member with no location, not a second bucket.
    const nodes: WorkspaceNode[] = [root(), pane('onscreen', 'root-1', 0), pane('parked', null, 0)];
    expect(validateTree(nodes)).toEqual({ ok: true });
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

  it('should ignore the fractions a parked pane kept from the container it left', () => {
    // Detaching a pane out of a sized column does not scrub the share it held
    // there, so parked panes routinely carry stale fractions that neither
    // agree with each other nor add up. Judging them as a container would make
    // every detach have to rewrite them; they are a list, so it does not.
    const nodes: WorkspaceNode[] = [
      root(),
      pane('onscreen', 'root-1', 0),
      sized('parked-a', null, 0, 0.25),
      sized('parked-b', null, 1, 0.6),
      pane('parked-c', null, 2),
    ];
    expect(validateTree(nodes)).toEqual({ ok: true });
  });

  it('should reject a non-finite share on a PARKED pane, which no container is there to sum', () => {
    // Skipping `fraction_mixed` and `fraction_sum` for the parked panes is
    // right — they share no container, so there is nothing for a share to be a
    // share OF. Finiteness is not that kind of check: it is a property of ONE
    // number, and the parked group was exempt from it by position rather than
    // by intent.
    //
    // The consequence is the same one the attached case has: Postgres `real`
    // takes NaN and Infinity happily, and `nodeFromRow` then throws on the way
    // back — an unreadable workspace, reached by parking a pane the client
    // resized before its container had laid out.
    const parkedNaN: WorkspaceNode[] = [
      root(),
      pane('onscreen', 'root-1', 0),
      sized('parked', null, 0, Number.NaN),
    ];
    expect(validateTree(parkedNaN)).toMatchObject({ ok: false, code: 'fraction_not_finite' });

    const parkedInfinity: WorkspaceNode[] = [
      root(),
      pane('onscreen', 'root-1', 0),
      sized('parked', null, 0, Number.POSITIVE_INFINITY),
    ];
    expect(validateTree(parkedInfinity)).toMatchObject({ ok: false, code: 'fraction_not_finite' });
  });

  it('should not require a parked pane to carry a share of anything', () => {
    // The parked panes are a list, not a container. They have no parent whose
    // space they divide, so a fraction invariant over them is meaningless.
    const nodes: WorkspaceNode[] = [
      root(),
      pane('onscreen', 'root-1', 0),
      pane('parked-a', null, 0),
      pane('parked-b', null, 1),
    ];
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

  it('should hold the parked panes to the same ordering as any other group', () => {
    // They are not a container, but they ARE a list the sidebar renders in
    // order, so a gap here is the same defect wearing a different hat.
    const nodes: WorkspaceNode[] = [
      root(),
      pane('onscreen', 'root-1', 0),
      pane('parked-a', null, 0),
      pane('parked-b', null, 3),
    ];
    expect(validateTree(nodes)).toMatchObject({ ok: false, code: 'position_contiguity' });
  });

  it('should not let the root and the parked panes collide over index 0', () => {
    // Both carry a null parent, so a validator that grouped siblings by
    // parentId alone would see the root's 0 and a parked pane's 0 as a clash.
    // The root belongs to no sibling group at all.
    const nodes: WorkspaceNode[] = [root(), pane('onscreen', 'root-1', 0), pane('parked', null, 0)];
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

  it('should count a PARKED node as showing its conversation, because the index does not read parentId', () => {
    // A detached node is off the grid and still a member of the workspace,
    // still holding its binding, still one row under the unique index. Letting
    // a parked conversation be shown again would be the algebra permitting
    // exactly what the table goes on rejecting.
    const nodes: WorkspaceNode[] = [
      root(),
      showing('onscreen', 'root-1', 0, { kind: 'chat', id: 'conv-1' }),
      showing('parked', null, 0, { kind: 'chat', id: 'conv-1' }),
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
      pane('parked', null, 0),
    ];
    const acceptedBefore = structuredClone(accepted);
    expect(validateTree(accepted)).toEqual({ ok: true });
    expect(accepted).toEqual(acceptedBefore);

    const rejected: WorkspaceNode[] = [
      root(),
      pane('a', 'root-1', 0),
      pane('b', 'root-1', 2),
      pane('parked', null, 3),
    ];
    const rejectedBefore = structuredClone(rejected);
    expect(validateTree(rejected)).toMatchObject({ ok: false, code: 'position_contiguity' });
    expect(rejected).toEqual(rejectedBefore);
  });
});
