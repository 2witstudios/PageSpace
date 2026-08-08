/**
 * `validateTree` — the structural invariants of the flat node model.
 *
 * This function is the reason the flat model is safe to choose. A nested tree
 * type cannot express a cycle; a flat parent pointer can. The model is flat
 * deliberately (see `workspace-node.ts`) — rows are flat, the wire is flat, and
 * it is the only shape in which a DETACHED node is not a second bucket beside
 * the tree — and the entire price of that choice is paid here, once, by the
 * single function every write path runs before persisting.
 *
 * It checks EXACTLY what the types cannot state. A root with a parent, a
 * detached split and a pane with an axis are already unspellable, so nothing
 * here re-checks them.
 *
 * **It validates and never repairs.** The only outputs are `ok: true` and a
 * violation; there is no branch anywhere below that reassigns a `parentId`,
 * and there must never be one. A parent that does not resolve is a REJECTED
 * tree, never a node quietly reattached to the root. That fallback is how a
 * pane ends up restructured into a session the user never put it in: a pending
 * move naming a container another client just deleted has to be refused so the
 * client rebases, because "attach it to the root instead" is not a repair, it
 * is a relocation nobody asked for. A node's workspace is its root and its
 * location is its parent, and the two are never allowed to become confusable.
 *
 * Violations are reported in a FIXED order, so one bad tree always yields one
 * code: node cap, duplicate ids, root count, dangling parent, cycle,
 * reachability, depth, split arity, pane leafness, fractions, ordering. The
 * order is not arbitrary — each check assumes what the ones before it
 * established. Everything that resolves a node needs ids to be unique;
 * everything that walks a parent pointer needs the dangling check to have
 * passed; the depth walk needs the cycle check to have passed, which is what
 * lets it run without a visited set; and the fraction SUM needs its terms
 * proven finite, because a NaN loses every comparison it is given.
 */
import { FRACTION_EPSILON } from './workspace-layout-verbs';
import { childrenOf, descendantsOf, detachedOf, rootOf, type WorkspaceNode } from './workspace-node';

/**
 * The most nodes a workspace may hold.
 *
 * Sized against HISTORY, not against taste. The two-level model this replaces
 * allowed 64 columns of 16 panes — 1024 panes, ~1089 nodes once migrated — so
 * the cap has to sit comfortably above the largest grid production can already
 * contain, or the migration would reject real workspaces rather than carry
 * them.
 */
export const MAX_NODES = 2048;

/**
 * The deepest a node may sit below the root, measured in EDGES: the root is 0,
 * a pane sitting directly in it is 1.
 *
 * Root → column → three nested splits → pane is 5, already far past anything a
 * user builds by hand. The cap is a runaway guard, not a design limit.
 */
export const MAX_DEPTH = 8;

/**
 * The result. A discriminated union rather than a boolean or a throw: the
 * server turns a violation into a rejection and the client's optimistic path
 * logs it, and neither can parse prose — hence a machine-readable `code`
 * alongside the human `detail`.
 */
export type TreeValidation = { ok: true } | { ok: false; code: TreeViolationCode; detail: string };

export type TreeViolationCode =
  | 'duplicate_id'
  | 'no_root'
  | 'multiple_roots'
  | 'dangling_parent'
  | 'cycle'
  | 'unreachable'
  | 'max_depth_exceeded'
  | 'max_nodes_exceeded'
  | 'degenerate_split'
  | 'pane_has_children'
  | 'fraction_mixed'
  | 'fraction_not_finite'
  | 'fraction_sum'
  | 'position_contiguity';

function violation(code: TreeViolationCode, detail: string): TreeValidation {
  return { ok: false, code, detail };
}

/**
 * One node's share of its parent, or `undefined` when it has none. The root
 * carries no fraction at all — it has no parent to take a share of — so the
 * union needs narrowing rather than a property read.
 */
function fractionOf(node: WorkspaceNode): number | undefined {
  return node.nodeType === 'root' ? undefined : node.fraction;
}

/** A parent and its children; `parentId: null` marks the parked panes. */
interface SiblingGroup {
  parentId: string | null;
  members: WorkspaceNode[];
}

/**
 * Every set of siblings, in a deterministic order: attached groups by the order
 * their parent's first child appears in the list, then the parked panes.
 *
 * The parked panes are a group — they are ordered in the sidebar, so their
 * `position` still has to be contiguous — but they are NOT a container, and
 * the fraction check below skips them for exactly that reason.
 *
 * The root is in no group at all: it and a parked pane both carry a null
 * parent, and lumping them together would collide the root's `position: 0`
 * with the first parked pane's.
 */
function siblingGroups(nodes: readonly WorkspaceNode[]): SiblingGroup[] {
  const groups: SiblingGroup[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.parentId === null || seen.has(node.parentId)) continue;
    seen.add(node.parentId);
    groups.push({ parentId: node.parentId, members: childrenOf(nodes, node.parentId) });
  }
  const parked = detachedOf(nodes);
  if (parked.length > 0) groups.push({ parentId: null, members: parked });
  return groups;
}

export function validateTree(nodes: readonly WorkspaceNode[]): TreeValidation {
  // First, because it bounds the work every check below does.
  if (nodes.length > MAX_NODES) {
    return violation('max_nodes_exceeded', `${nodes.length} nodes; the cap is ${MAX_NODES}`);
  }

  // Second, because every check below this line resolves nodes BY ID and none
  // of them can mean anything while an id names two nodes. Ids are minted on
  // the client, so a collision is reachable rather than theoretical, and every
  // resolver in the model is a `find` or a `Map` — each silently keeps one of
  // the pair. A colliding tree would therefore be judged on whichever half the
  // lookups happened to land on, and then both halves would be written.
  const seenIds = new Set<string>();
  for (const node of nodes) {
    if (seenIds.has(node.id)) {
      return violation('duplicate_id', `id "${node.id}" names more than one node; ids are unique`);
    }
    seenIds.add(node.id);
  }

  // The root is found by TYPE, never by "the node with no parent" — a parked
  // pane has no parent either, and conflating the two is the bug this whole
  // model exists to remove. An empty list has no root, so an empty workspace
  // is invalid rather than vacuously fine.
  const root = rootOf(nodes);
  if (root === undefined) {
    return violation('no_root', 'no node of type "root"; a workspace has exactly one');
  }
  const roots = nodes.filter((node) => node.nodeType === 'root');
  if (roots.length > 1) {
    return violation(
      'multiple_roots',
      `${roots.length} nodes of type "root" (${roots.map((node) => node.id).join(', ')}); a workspace has exactly one`,
    );
  }

  // Every check below walks parent pointers, so they all assume a pointer
  // resolves. Settle that first, in list order, so the same bad tree always
  // names the same node.
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (node.parentId !== null && !byId.has(node.parentId)) {
      return violation(
        'dangling_parent',
        `node "${node.id}" is parented to "${node.parentId}", which is not in the set`,
      );
    }
  }

  // Walk UP from every node. A parent chain either reaches a null parent or
  // revisits a node it has already stepped through, and the second case is a
  // cycle — the violation a nested type could not express and a flat pointer
  // can. Chains already proven to terminate are memoized, so the whole sweep
  // stays linear rather than quadratic on a deep grid.
  //
  // Walking up rather than down is deliberate: a cycle disjoint from the root
  // is invisible to a walk that starts at the root, and it is exactly the shape
  // a bad `move` would write.
  const terminates = new Set<string>();
  for (const start of nodes) {
    const path = new Set<string>();
    let cursor: WorkspaceNode | undefined = start;
    while (cursor !== undefined && !terminates.has(cursor.id)) {
      if (path.has(cursor.id)) {
        return violation('cycle', `node "${cursor.id}" is its own ancestor`);
      }
      path.add(cursor.id);
      // Resolves for every non-null parent: the dangling check above passed.
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    for (const id of path) terminates.add(id);
  }

  // Reachability, stated separately from the cycle check above even though a
  // node parented into a cycle fails both. They fail differently — one is a
  // pointer that loops, the other a subtree nothing renders — and a reader
  // needs to see both named.
  //
  // The single exception is a DETACHED pane: parked, in the workspace and in
  // the sidebar, deliberately absent from the grid. It is unreachable BY
  // DESIGN, and that is the whole point of the flat model.
  const reachable = new Set([root.id, ...descendantsOf(nodes, root.id).map((node) => node.id)]);
  const parked = new Set(detachedOf(nodes).map((node) => node.id));
  for (const node of nodes) {
    if (!reachable.has(node.id) && !parked.has(node.id)) {
      return violation(
        'unreachable',
        `node "${node.id}" does not descend from the root, so nothing would render it`,
      );
    }
  }

  // Depth is measured in EDGES from the root, so the root itself is 0 and a
  // pane sitting directly in it is 1. Terminates without a visited set: the
  // tree is already known to be acyclic.
  const queue: Array<{ id: string; depth: number }> = [{ id: root.id, depth: 0 }];
  while (queue.length > 0) {
    const { id, depth } = queue.shift() as { id: string; depth: number };
    if (depth > MAX_DEPTH) {
      return violation(
        'max_depth_exceeded',
        `node "${id}" sits ${depth} levels below the root; the cap is ${MAX_DEPTH}`,
      );
    }
    for (const child of childrenOf(nodes, id)) {
      queue.push({ id: child.id, depth: depth + 1 });
    }
  }

  // A split exists only to divide space between siblings, so one holding fewer
  // than two states nothing the parent did not already say. The algebra
  // collapses such a split on `move`; this is what proves it happened. The ROOT
  // is exempt — it is the workspace itself, and a workspace holding one pane,
  // or none at all, is an ordinary state.
  for (const node of nodes) {
    if (node.nodeType !== 'split') continue;
    const children = childrenOf(nodes, node.id);
    if (children.length < 2) {
      return violation(
        'degenerate_split',
        `split "${node.id}" holds ${children.length} children; a split divides at least 2`,
      );
    }
  }

  // A pane is a LEAF by definition: only a root and a split hold children. The
  // types get most of the way there — a split cannot be detached, a pane cannot
  // carry an axis — but they stop short here, because `PaneNode.parentId` is an
  // ordinary string and nothing in it knows what kind of node the id names. So
  // a `move` that names a pane as its destination writes a subtree hanging off
  // a viewport: reachable, acyclic, correctly numbered, and unrenderable.
  //
  // After reachability on purpose. A parked pane holding a stowaway fails both
  // this and the reachability check, and `unreachable` is the truer thing to
  // say about a subtree nothing renders — the test for it pins that.
  for (const node of nodes) {
    if (node.nodeType !== 'pane') continue;
    const children = childrenOf(nodes, node.id);
    if (children.length > 0) {
      return violation(
        'pane_has_children',
        `pane "${node.id}" holds ${children.length} children (${children.map((child) => child.id).join(', ')}); a pane is a leaf`,
      );
    }
  }

  const groups = siblingGroups(nodes);

  // Fractions, per container. The parked panes are skipped: they share no
  // container, so there is nothing for a share to be a share OF.
  for (const group of groups) {
    if (group.parentId === null) continue;
    const fractions = group.members.map(fractionOf);
    const sized = fractions.filter((fraction): fraction is number => fraction !== undefined);
    if (sized.length > 0 && sized.length !== fractions.length) {
      return violation(
        'fraction_mixed',
        `${sized.length} of ${fractions.length} children of "${group.parentId}" carry a fraction; a container is sized or unsized, never both`,
      );
    }
    if (sized.length === 0) continue;

    // BEFORE the sum, and the ordering is the whole point. `Math.abs(NaN - 1)
    // >= FRACTION_EPSILON` is FALSE — every comparison against NaN is — so a
    // group holding one waves itself through the very check written to stop
    // it. The sum can only be trusted once its terms are known to be numbers.
    //
    // Not a hypothetical value. The client's optimistic resize divides a drag
    // offset by its container's extent, and a container that has not laid out
    // yet has an extent of 0. Worse, it is self-propagating: a persisted NaN
    // poisons every future total that includes it, so the sum check would
    // never fire on that container again. An infinity is the same division one
    // signed step away, and just as much not a share of anything.
    for (const member of group.members) {
      const fraction = fractionOf(member);
      if (fraction !== undefined && !Number.isFinite(fraction)) {
        return violation(
          'fraction_not_finite',
          `node "${member.id}" carries a fraction of ${fraction}; a share is a finite number`,
        );
      }
    }

    // Every producer settles its own residual, so real drift stays far below
    // the epsilon; this catches shares that were never rebalanced, not float
    // noise.
    const total = sized.reduce((running, fraction) => running + fraction, 0);
    if (Math.abs(total - 1) >= FRACTION_EPSILON) {
      return violation(
        'fraction_sum',
        `the children of "${group.parentId}" hold ${total} between them, not 1`,
      );
    }
  }

  // `position` is contiguous and 0-based within each sibling group. This is
  // the assertion a contiguous integer buys and pages' fractional `real`
  // positioning could not make at all: a gap or a duplicate means a verb
  // renumbered part of a group and stopped, which shows up as two panes
  // fighting over one slot. Checked in its own pass so a tree with both a
  // fraction and an ordering fault always reports the fraction, whichever
  // group each is in.
  for (const group of groups) {
    const positions = group.members.map((node) => node.position).sort((a, b) => a - b);
    if (!positions.every((value, slot) => value === slot)) {
      const where =
        group.parentId === null ? 'the parked panes' : `the children of "${group.parentId}"`;
      return violation(
        'position_contiguity',
        `${where} hold positions [${positions.join(', ')}]; expected a contiguous 0-based run`,
      );
    }
  }

  return { ok: true };
}
