/**
 * `validateTree` — the structural invariants of the flat node model.
 *
 * This function is the reason the flat model is safe to choose. A nested tree
 * type cannot express a cycle; a flat parent pointer can. The model is flat
 * deliberately (see `workspace-node.ts`) — rows are flat and the wire is flat —
 * and the entire price of that choice is paid here, once, by the single
 * function every write path runs before persisting.
 *
 * It checks EXACTLY what the types cannot state, PLUS ONE THING THEY DO STATE
 * AND A ROW CAN STILL BREAK. A root with a parent and a pane with an axis are
 * unspellable in memory and nothing here re-checks them; a NON-ROOT WITH A NULL
 * PARENT is unspellable in memory too, and `null_parent` checks it anyway,
 * because this function's input can come from nine mostly-nullable columns and
 * a column does not know what a union is. That check is the correction of a
 * real mistake: the previous cut made a null parent a LEGAL resting state
 * ("detached"), so `dangling_parent` covered the half of the failure where a
 * parent pointer resolves to nothing and NOTHING covered the half where it
 * points at nothing at all.
 *
 * With ONE deliberate exception, stated last: a conversation is bound to at
 * most one node OF THIS SET. That is a domain rule rather than a structural
 * one, and it is here because it is a property of a SET of nodes that the TABLE
 * also enforces (`UNIQUE (targetId) WHERE targetKind = 'chat'`) — and this
 * function is what runs before every write. A rule the storage refuses and the
 * model permits is a rejection the client can only receive as a raw constraint
 * error, too late to do anything with.
 *
 * That exception is also the one check here that does NOT cover its constraint
 * completely, and the check's own comment says where the rest lives. The index
 * is keyed on `targetId` alone — no `rootId` — so it is global, while this
 * function's input is one workspace. Every OTHER constraint on the node table
 * carries `rootId`, which is exactly why one workspace's list is enough to
 * settle them.
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
 * code: node cap, blank ids, duplicate ids, root count, null parent, dangling
 * parent, cycle, reachability, depth, split arity, pane leafness, fraction
 * finiteness, the per-container fraction rules, ordering, chat bindings. The
 * order is not arbitrary — each check assumes what the ones before it
 * established. Nothing that resolves a node by id can mean anything until ids
 * are known to be real strings and unique; everything that walks a parent
 * pointer needs BOTH parent checks to have passed; the depth walk needs the
 * cycle check to have passed, which is what lets it run without a visited set;
 * and the fraction SUM needs its terms proven finite, because a NaN loses every
 * comparison it is given.
 *
 * **The EMPTY list is valid**, and that is the top half of this correction
 * rather than a loosening. `destroy(rootId)` is how a session ends — one
 * removal, pointed at the root — and what it leaves behind is no nodes at all.
 * A list with no root and something in it is still `no_root`: that is a
 * workspace whose rows lost their root, which is a fault. Nothing is there to
 * be faulty about an empty one.
 */
import { FRACTION_EPSILON } from './workspace-layout-verbs';
import { childrenOf, descendantsOf, rootOf, type WorkspaceNode } from './workspace-node';

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
  | 'blank_id'
  | 'duplicate_id'
  | 'no_root'
  | 'multiple_roots'
  /**
   * A non-root node whose `parentId` is null. Its own code, and NOT folded into
   * `dangling_parent` or `unreachable`: a pointer that resolves to nothing and a
   * pointer that was never set are different faults with different causes, and
   * "nothing would render it" is a true but downstream thing to say about a node
   * that is not anywhere at all.
   */
  | 'null_parent'
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
  | 'position_contiguity'
  | 'duplicate_chat_target';

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

/**
 * A node's parent pointer, read as STORAGE can spell it rather than as the union
 * promises it.
 *
 * The indirection is load-bearing and is the reason it is a function. Reading
 * `node.parentId` directly after narrowing to a non-root gives the type
 * `string`, so `=== null` narrows to `never` and the compiler is entitled to
 * conclude the check is dead — which it is, for every node this package
 * CONSTRUCTS. It is not dead for the ones it READS: nine mostly-nullable columns,
 * a wire payload, a node set a client assembled. Widening here says exactly that
 * — the value has the type the storage has, not the type the model wishes it
 * had — instead of asserting it away.
 */
function parentPointerOf(node: WorkspaceNode): string | null {
  return node.parentId;
}

/** A parent and its children. Every group has a real container now. */
interface SiblingGroup {
  parentId: string;
  members: WorkspaceNode[];
}

/**
 * Every set of siblings, in a deterministic order: by the order each parent's
 * first child appears in the list.
 *
 * The root is in no group at all — it is the only node with a null parent, and
 * it is a container rather than a member of one.
 */
function siblingGroups(nodes: readonly WorkspaceNode[]): SiblingGroup[] {
  const groups: SiblingGroup[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node.parentId === null || seen.has(node.parentId)) continue;
    seen.add(node.parentId);
    groups.push({ parentId: node.parentId, members: childrenOf(nodes, node.parentId) });
  }
  return groups;
}

export function validateTree(nodes: readonly WorkspaceNode[]): TreeValidation {
  // THE EMPTY WORKSPACE, settled before the root check can call it `no_root`.
  // It is what `destroy(rootId)` leaves behind, and destroying the root is how
  // a session ends — one removal, pointed at the top of the tree instead of at
  // a pane. Everything below is a statement about nodes; there are none.
  if (nodes.length === 0) return { ok: true };

  // First, because it bounds the work every check below does.
  if (nodes.length > MAX_NODES) {
    return violation('max_nodes_exceeded', `${nodes.length} nodes; the cap is ${MAX_NODES}`);
  }

  // Second, and ahead of uniqueness, because a blank id is not an id that is
  // taken — it is not an id at all, and every check below resolves nodes by
  // one. The SHAPE of an id is exactly as invariant as its uniqueness, and this
  // is the gate every write path runs: the wire's primitive is `put(nodes[])`,
  // a node SET, so a client that assembled its own nodes never goes through the
  // algebra's operations at all.
  //
  // It is stated here because nothing downstream can state it. Postgres takes
  // `''` without complaint (`text NOT NULL` is satisfied), and the row parse
  // then refuses it on the way back — and `nodesFromRows` rejects the WHOLE set
  // rather than filtering, deliberately, because dropping the row would be
  // indistinguishable from the user having closed the pane. So one such row
  // makes the workspace permanently unreadable, and the read is the only way
  // in: repair takes a hand-written DELETE against production.
  //
  // `trim()`, not a length test. `z.string().min(1)` at the row boundary is
  // satisfied by `'   '`, so the whitespace-only case is the one that survives
  // the read and lands as a node nothing can address — and `trim()` is already
  // how `bind` and `create` spell the same rule.
  //
  // `targetId` is held to it too, and for the identical reason: the column is
  // `z.string().min(1)` on the way back, a binding is for life, and nothing
  // later corrects a pane bound to nothing.
  for (const node of nodes) {
    if (node.id.trim() === '') {
      return violation('blank_id', 'a node carries a blank id; an id addresses a node, and this one addresses nothing');
    }
    if (node.nodeType === 'pane' && node.target !== null && node.target.id.trim() === '') {
      return violation(
        'blank_id',
        `node "${node.id}" is bound to a ${node.target.kind} with a blank id; a binding is for life, so nothing later corrects it`,
      );
    }
  }

  // Third, because every check below this line resolves nodes BY ID and none
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

  // The root is found by TYPE, never by "the node with no parent". Those two
  // now select the same node — which is the whole correction — and the reason
  // to keep asking the type is that a ROW can disagree with itself, and the
  // next check is what says so.
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

  // A NON-ROOT WITH NO PARENT — the check the previous cut of this model could
  // not have, because it had made that state legal and called it "detached".
  //
  // **It is unspellable in memory and stated here anyway, and that is the
  // point.** `PaneNode.parentId` and `SplitNode.parentId` are both `string`, so
  // no code path in this package can construct one. But this function's input is
  // not always constructed: it is also nine mostly-nullable columns read back
  // through `nodeFromRow`, a wire payload, and — during the migration window — a
  // node set assembled by a client this repo did not ship. A column does not
  // know what a discriminated union is, and `parentId text` takes NULL from
  // anything that writes it. `nodeFromRow` refuses such a row too; this is the
  // set-level statement of the same rule, and BOTH are needed because the wire's
  // primitive is `put(nodes[])` and a caller that assembled its own nodes goes
  // through neither the algebra nor a row parse.
  //
  // BEFORE `dangling_parent`, and the order carries meaning rather than
  // convenience. A tree holding both faults is answered with this one, because
  // "this node is nowhere" is the more primitive statement: a dangling pointer is
  // a node that named a place that is gone, and a null one is a node that named
  // no place at all. Reported ahead of `unreachable` for the same reason — that
  // code is true of this node as well, and it describes the CONSEQUENCE (nothing
  // would render it) rather than the fault.
  for (const node of nodes) {
    if (node.nodeType !== 'root' && parentPointerOf(node) === null) {
      return violation(
        'null_parent',
        `node "${node.id}" is a ${node.nodeType} with no parent; only the root has none, and it has one because it is the root`,
      );
    }
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
  // IT HAS NO EXCEPTIONS. The previous cut exempted a "detached" pane, which is
  // to say it exempted precisely the population that made a lost pane and a
  // closed one look alike. Every node descends from the root or the tree is
  // refused.
  const reachable = new Set([root.id, ...descendantsOf(nodes, root.id).map((node) => node.id)]);
  for (const node of nodes) {
    if (!reachable.has(node.id)) {
      return violation(
        'unreachable',
        `node "${node.id}" does not descend from the root, so nothing would render it`,
      );
    }
  }

  // Depth is measured in EDGES from the root, so the root itself is 0 and a
  // pane sitting directly in it is 1. Terminates without a visited set: the
  // tree is already known to be acyclic.
  //
  // Drained by the `undefined` `shift()` actually returns when empty, rather
  // than by a length check plus a cast that asserts what the check implied —
  // the idiom `descendantsOf` uses, and for the reason it states there: this
  // model's whole thesis is that a cast is a lie the type checker vouches for.
  const queue: Array<{ id: string; depth: number }> = [{ id: root.id, depth: 0 }];
  for (let step = queue.shift(); step !== undefined; step = queue.shift()) {
    const { id, depth } = step;
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
  // types get most of the way there — a pane cannot carry an axis — but they
  // stop short here, because `PaneNode.parentId` is an ordinary string and
  // nothing in it knows what kind of node the id names. So a `move` that names
  // a pane as its destination writes a subtree hanging off a viewport:
  // reachable, acyclic, correctly numbered, and unrenderable.
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

  // Finiteness, over EVERY node and outside the group loop, because it has no
  // group-level precondition: `fraction_mixed` and `fraction_sum` are questions
  // about a container, and this is a question about one number.
  //
  // BEFORE the sum, and the ordering is the whole point. `Math.abs(NaN - 1) >=
  // FRACTION_EPSILON` is FALSE — every comparison against NaN is — so a group
  // holding one waves itself through the very check written to stop it. The sum
  // can only be trusted once its terms are known to be numbers.
  //
  // Not a hypothetical value. The client's optimistic resize divides a drag
  // offset by its container's extent, and a container that has not laid out yet
  // has an extent of 0. Worse, it is self-propagating: a persisted NaN poisons
  // every future total that includes it, so the sum check would never fire on
  // that container again. An infinity is the same division one signed step
  // away, and just as much not a share of anything. Postgres `real` takes both,
  // and the row parse throws on the way back.
  for (const node of nodes) {
    const fraction = fractionOf(node);
    if (fraction !== undefined && !Number.isFinite(fraction)) {
      return violation(
        'fraction_not_finite',
        `node "${node.id}" carries a fraction of ${fraction}; a share is a finite number`,
      );
    }
  }

  const groups = siblingGroups(nodes);

  // Fractions, per container — and every group is a container now, so there is
  // no group here that a share could fail to be a share OF.
  for (const group of groups) {
    const fractions = group.members.map(fractionOf);
    const sized = fractions.filter((fraction): fraction is number => fraction !== undefined);
    if (sized.length > 0 && sized.length !== fractions.length) {
      return violation(
        'fraction_mixed',
        `${sized.length} of ${fractions.length} children of "${group.parentId}" carry a fraction; a container is sized or unsized, never both`,
      );
    }
    if (sized.length === 0) continue;

    // Every term is already known to be finite — the sweep above the loop
    // settled that for every node in the set, which is what makes the
    // comparison below mean anything at all.
    //
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
      return violation(
        'position_contiguity',
        `the children of "${group.parentId}" hold positions [${positions.join(', ')}]; expected a contiguous 0-based run`,
      );
    }
  }

  // A conversation is bound to at most one node IN THIS SET — the part of
  // `UNIQUE (targetId) WHERE targetKind = 'chat'` a set of nodes can settle.
  //
  // **AND THAT IS NOT THE WHOLE INDEX.** Its key is `targetId` ALONE, with no
  // `rootId` in it, so it is global: one conversation, one node, across the
  // entire table. This function is handed ONE workspace's list, so a node in
  // another workspace holding the same conversation is not something it fails to
  // notice — it is something the input does not contain. The rest of the rule is
  // closed at the write path, where the table is: a pre-flight lookup and a
  // catch on the constraint by name, both in
  // `apps/web/src/lib/agent-workspaces/workspace-node-runtime.ts`, over
  // `workspace-node-chat-binding.ts`.
  //
  // It would be easy to write the missing half off as unreachable, on the
  // grounds that a conversation belongs to exactly one workspace
  // (`conversations.workspaceId`, permanent — moving a thread is a FORK, never a
  // rebind). It is not: this branch's own backfill says so in as many words
  // ("a pane naming a conversation in another session is reachable today",
  // `workspace-node-backfill.ts`), which is why that migration has to arbitrate
  // chat claims globally. A pane's target is free-form in the payload and is not
  // held to `conversations.workspaceId` by anything.
  //
  // DO NOT close the gap by giving this function IO. It is pure and it runs on
  // the client, and a global fact is not one an offline reducer can be handed.
  //
  // The within-set half lives here, and not only in `bind`/`create`, because
  // THIS is what every write path runs. The wire primitive is an upsert of a
  // node SET, so a client that assembled its own nodes never goes through the
  // algebra's operations — and without this the duplicate would be learned from
  // a raw index violation, after the optimistic edit is already on screen and in
  // a form the client cannot interpret.
  //
  // LAST, and deliberately: it is the only DOMAIN invariant in a function whose
  // others are all structural, and a tree that is also misnumbered or cyclic has
  // a fault that makes it unrenderable rather than merely unstorable. Nothing
  // below the line needs what it establishes, so it also costs the checks above
  // it nothing.
  //
  // CHAT ONLY, keyed by kind and not by id alone. Pages and terminals carry no
  // such index — opening one page in two panes is a legitimate thing a user
  // does — and `targetId` is polymorphic, so a conversation id and a page id
  // may coincide without either being a collision. An algebra stricter than its
  // storage is a second rule nobody can see, and the two drift.
  const showing = new Map<string, string>();
  for (const node of nodes) {
    if (node.nodeType !== 'pane' || node.target === null || node.target.kind !== 'chat') continue;
    const holder = showing.get(node.target.id);
    if (holder !== undefined) {
      return violation(
        'duplicate_chat_target',
        `nodes "${holder}" and "${node.id}" both show chat "${node.target.id}"; a conversation renders in at most one pane`,
      );
    }
    showing.set(node.target.id, node.id);
  }

  return { ok: true };
}
