/**
 * THE STATE ALGEBRA of the flat node model — `create`, `move`, `bind`,
 * `resize`, `destroy`.
 *
 * These five replace the twelve wire verbs of the deleted `workspace-layout-verbs.ts`
 * (`split_right`, `split_down`, `close_pane`, `reset_pane`, `open_conversation`,
 * `replace_conversation`, `resize_column`, `resize_pane`, `move_pane`,
 * `reorder_columns`, `assign_pane`, `ensure`). Those twelve named ERGONOMIC
 * GESTURES, which is why that reducer reads like a description of the toolbar
 * rather than of the data. These five name what the data can actually do, and
 * every gesture is a command COMPOSED from them one layer up.
 *
 * Two properties hold across all five, and everything below is arranged to
 * make them cheap to see:
 *
 * **They return a WRITE-SET, never a mutated tree.** That is what lets the
 * browser and the server run the identical function — the client applies it
 * optimistically, the server persists it — so there is exactly one definition
 * of what each operation means. Two implementations of "what a close does" is
 * how the model this replaces grew a client and a server that disagreed.
 *
 * **They refuse; they never repair.** Every result is put through
 * `validateTree`, and one that would not pass comes back as a rejection. In
 * particular a `parentId` that does not resolve is a REFUSED operation — there
 * is no `?? root`, no `|| root`, and no "if the parent is missing, use the
 * root" branch anywhere in this file, because that fallback is precisely how a
 * pane ends up restructured into a session the user never put it in. A caller
 * holding a stale snapshot needs to be told to rebase, not quietly obeyed
 * somewhere else.
 *
 * There is also no `attach` here, and there is not meant to be. A node's
 * location is one column and `move` is the only operation that changes it;
 * "attach" is the vocabulary of joining two independently existing systems, and
 * having two systems to join is the bug this model deletes.
 *
 * **AND THERE IS ONE REMOVAL.** `destroy` takes a node and its subtree, and the
 * only thing that changes with the node you point it at is how much goes:
 * `destroy(paneId)` and the pane goes, `destroy(rootId)` and the session goes.
 * An earlier cut refused the root here (`root_immutable`), which did not remove
 * the ability to end a session — it moved it into a SECOND mechanism beside the
 * tree, two removals with two meanings reconciled by convention, which is the
 * thing this epic exists to delete. The root is still immutable for `move`,
 * `bind` and `resize`, because those genuinely make no sense on it; refusing an
 * operation that has no meaning is not a second mechanism.
 */
import {
  currentShares,
  FRACTION_EPSILON,
  rebalanceFractions,
  resizeShare,
} from './workspace-fractions';
import {
  childrenOf,
  descendantsOf,
  findNode,
  removeNodes,
  upsertNodes,
  type PaneNode,
  type PaneTarget,
  type SplitNode,
  type WorkspaceNode,
} from './workspace-node';
import { validateTree, type TreeViolationCode } from './workspace-node-validate';

/**
 * What an operation returns: the nodes to write and the ids to remove.
 *
 * `put` carries only what actually CHANGED, so an operation that asks for the
 * state a node is already in writes nothing — the "declined" convention the
 * model this replaces spelled as `next !== state`, kept honest here so a
 * re-sent request does not bump a rev or broadcast.
 *
 * **TWO THINGS A PERSISTING WRITER OWES THIS TYPE**, neither of them visible
 * from memory, both of them consequences of the composite self-FK
 * `(rootId, parentId) → (rootId, id)`:
 *
 *  - **`put` before `drop`.** The FK is `ON DELETE cascade`, and `drop` names
 *    containers whose children are being REPARENTED rather than deleted. See
 *    {@link applyNodeWrite}.
 *  - **`put` is ONE statement, not a loop.** Its order is whatever
 *    `upsertNodes` produced — replace in place, then append — and nothing
 *    establishes that a parent precedes its children in it. A multi-row
 *    `INSERT … ON CONFLICT DO UPDATE` is immune, because FK triggers fire at
 *    the end of the statement; a row-at-a-time loop is not, and would refuse a
 *    child whose parent has not landed yet.
 */
export interface NodeWrite {
  put: WorkspaceNode[];
  drop: string[];
}

/**
 * Why an operation was refused.
 *
 * A superset of {@link TreeViolationCode}: an operation is refused either
 * because the tree it would have produced is invalid — in which case the
 * validator's own code comes straight back — or for a reason of its own. The
 * two are kept distinct even where they rhyme: `unknown_parent` means the
 * parent the CALLER named is not there, while `dangling_parent` means a node
 * already in the set points at nothing. Same shape, different bug, different
 * fix. `target_already_shown` and the validator's `duplicate_chat_target` are
 * the same pairing: the first is the conversation the CALLER named being
 * already on another node, the second is a set that shows one conversation
 * twice however it came to.
 */
export type NodeOperationCode =
  | TreeViolationCode
  | 'already_bound'
  | 'duplicate_id'
  | 'invalid_fraction'
  | 'invalid_id'
  | 'invalid_index'
  | 'invalid_target'
  | 'not_a_container'
  | 'not_a_pane'
  | 'not_sizable'
  | 'parent_in_subtree'
  | 'root_immutable'
  | 'target_already_shown'
  | 'unknown_node'
  | 'unknown_parent';

/**
 * Mirrors {@link validateTree}'s shape deliberately: a caller handles ONE
 * result type whether the operation was refused for its own reasons or because
 * the tree it would have produced was invalid.
 */
export type NodeOperationResult =
  | { ok: true; write: NodeWrite }
  | { ok: false; code: NodeOperationCode; detail: string };

function reject(code: NodeOperationCode, detail: string): NodeOperationResult {
  return { ok: false, code, detail };
}

/**
 * Apply a write-set. **PUT FIRST, THEN DROP, and the order is load-bearing
 * BECAUSE OF THE CASCADE.** Do not tidy it back.
 *
 * In memory the order cannot be observed: an operation names the nodes it
 * removes and the nodes it writes, a node is never in both, and `removeNodes`
 * removes exactly the ids it is given. In the TABLE it is the difference
 * between a reorder and a data loss. `agent_workspace_nodes` carries a
 * composite self-FK `(rootId, parentId) → (rootId, id)` that is
 * `ON DELETE cascade` — deleting a container takes its whole subtree with it,
 * which the schema documents as a feature — and the collapse path in `move`
 * and `destroy` drops a split whose children are being REPARENTED, not
 * deleted. Those children are correctly absent from `put`, because nothing
 * about them changed. Drop first and the cascade takes them; `put` cannot
 * resurrect what it never named.
 *
 * Applying `put` first re-parents every survivor onto a node that is staying,
 * so by the time the delete runs the dropped container has no children left
 * for the cascade to reach. A write that genuinely destroys a subtree names
 * every row of it in `drop`, so it is unaffected.
 *
 * Idempotent, because `upsertNodes` is: a retried request or a duplicate
 * delivery re-applies to the same state.
 */
export function applyNodeWrite(nodes: readonly WorkspaceNode[], write: NodeWrite): WorkspaceNode[] {
  return removeNodes(upsertNodes(nodes, write.put), write.drop);
}

// ---------------------------------------------------------------------------
// Sibling groups — the unit every structural operation actually edits
// ---------------------------------------------------------------------------

/**
 * A node that sits in a sibling group: everything except the root.
 *
 * The root is in no group at all — `childrenOf` cannot return it, because its
 * parent is null and it is the only node whose parent is. So this is the type of
 * the things `position` and `fraction` are renumbered across.
 */
type MemberNode = PaneNode | SplitNode;

/** One node's share of its parent, or `undefined` when it has none. */
function fractionOf(node: WorkspaceNode): number | undefined {
  return node.nodeType === 'root' ? undefined : node.fraction;
}

/**
 * Re-seat a member's share. An unsized member carries NO key at all rather than
 * an explicit null — the absence IS the state, so a tree this algebra built and
 * one rehydrated from rows compare equal instead of merely rendering the same.
 *
 * DEEP-equal, not byte-equal, and this spread is why: `fraction` is appended,
 * so it lands after `target`, while the row transform emits it before. Same
 * keys, same values, different bytes — so change detection over nodes compares
 * fields and never `JSON.stringify`. Stated in full at `workspace-node-rows.ts`.
 */
function withFraction(node: MemberNode, fraction: number | null): MemberNode {
  if (fraction === null) {
    const { fraction: _unsized, ...rest } = node;
    return rest;
  }
  return { ...node, fraction };
}

/** The ordered members of a sibling group: a parent's children. */
function membersOf(nodes: readonly WorkspaceNode[], parentId: string): MemberNode[] {
  return childrenOf(nodes, parentId).filter((node): node is MemberNode => node.nodeType !== 'root');
}

/** A sibling group's membership, in the order it should end up in. */
interface GroupOrder {
  parentId: string;
  members: readonly MemberNode[];
}

/**
 * Renumber the named groups from 0 and re-establish their shares.
 *
 * Membership is passed IN ORDER rather than inferred from the members'
 * positions, so an insertion or a removal is a list operation the caller wrote
 * down and never an intent this function has to reconstruct from a number.
 * `parentId` is not touched here — a node's parent is set at the call site
 * where the caller's intent is visible, so there is exactly one place per
 * operation to look for it.
 *
 * Shares go through `rebalanceFractions`, the SAME rule the model this replaces
 * uses, imported rather than re-derived: a newcomer takes an even share of the
 * container it joins and the survivors keep their relative proportions inside
 * what is left.
 */
function reseat(nodes: readonly WorkspaceNode[], groups: readonly GroupOrder[]): WorkspaceNode[] {
  let next = [...nodes];
  for (const group of groups) {
    const fractions = rebalanceFractions(group.members.map((member) => member.fraction));
    next = upsertNodes(
      next,
      group.members.map((member, position) => withFraction({ ...member, position }, fractions[position])),
    );
  }
  return next;
}

/** Two nodes that would render and persist identically. */
function sameNode(left: WorkspaceNode, right: WorkspaceNode): boolean {
  if (left.nodeType !== right.nodeType) return false;
  if (left.parentId !== right.parentId || left.position !== right.position) return false;
  if (left.nodeType === 'pane' && right.nodeType === 'pane') {
    if (left.target?.kind !== right.target?.kind || left.target?.id !== right.target?.id) return false;
  }
  if (left.nodeType !== 'pane' && right.nodeType !== 'pane' && left.axis !== right.axis) return false;
  const leftShare = fractionOf(left);
  const rightShare = fractionOf(right);
  if (leftShare === undefined || rightShare === undefined) return leftShare === rightShare;
  return Math.abs(leftShare - rightShare) < FRACTION_EPSILON;
}

/**
 * The write that turns `nodes` into `next` — derived by comparison rather than
 * accumulated as the operation goes, so `put` and `drop` cannot fall out of
 * step with the tree the operation actually validated.
 */
function writeBetween(nodes: readonly WorkspaceNode[], next: readonly WorkspaceNode[]): NodeWrite {
  const before = new Map(nodes.map((node) => [node.id, node]));
  const after = new Set(next.map((node) => node.id));
  return {
    put: next.filter((node) => {
      const previous = before.get(node.id);
      return previous === undefined || !sameNode(previous, node);
    }),
    drop: nodes.filter((node) => !after.has(node.id)).map((node) => node.id),
  };
}

/**
 * A slot a node may be inserted into, given a group that will hold `size`
 * members once it is there — so the last legal slot is `size - 1`.
 *
 * REFUSED, never clamped, and that is a deliberate break from the model this
 * replaces (`movePane` reads `toIndex: 99` as "last"). Clamping is a repair: it
 * turns a caller working from a stale snapshot into a caller that got what it
 * asked for somewhere else, silently.
 *
 * `Number.isInteger` is doing work the range test cannot. The range test alone
 * already closes NaN and Infinity — every comparison against NaN is false, and
 * nothing is `< size` when it is infinite — but a FRACTIONAL index in range
 * passes it, and `slice(0, 0.5)` is `slice(0, 0)` while `slice(0.5)` is the
 * whole list, so slot `0.5` would quietly land at the front.
 */
function isSlot(index: number, size: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < size;
}

/**
 * The OTHER node already showing this target, if there is one — the check that
 * makes `bind` and `create` refuse what the database would.
 *
 * A conversation is bound to at most one node anywhere, which the table states
 * as `UNIQUE (targetId) WHERE targetKind = 'chat'`. Without this the client
 * applies the bind optimistically, the write goes out, and the answer is a raw
 * unique-constraint violation: a failure the model already knew was impossible,
 * arriving in a form the caller cannot interpret and after the state it has to
 * unwind is already on screen. The algebra is where a caller learns this.
 *
 * CHAT ONLY, and keyed by kind rather than by id alone. Pages and terminals sit
 * outside the index deliberately — opening one page in two panes is a
 * legitimate thing a user does — and `targetId` is polymorphic, so a
 * conversation id and a page id may coincide without either being a collision.
 * An algebra stricter than the storage it validates for is a second rule nobody
 * can see, and the two then drift.
 *
 * Every node in the set counts, wherever it sits — the index does not read
 * `parentId` at all, and neither does this.
 */
function shownElsewhere(
  nodes: readonly WorkspaceNode[],
  target: PaneTarget,
  exceptNodeId: string,
): WorkspaceNode | undefined {
  if (target.kind !== 'chat') return undefined;
  return nodes.find(
    (node) =>
      node.id !== exceptNodeId &&
      node.nodeType === 'pane' &&
      node.target !== null &&
      node.target.kind === 'chat' &&
      node.target.id === target.id,
  );
}

/**
 * The one exit every operation takes: the result is validated, and an operation
 * that would produce an invalid tree is REFUSED, never repaired.
 *
 * The three checks ahead of `validateTree` state faults it also states, and
 * they are here for the ORDER and the VOCABULARY rather than for the coverage.
 * `validateTree` reports one code per bad tree in a fixed sequence chosen for a
 * reader of a whole tree; an OPERATION was asked to do one thing, and a caller
 * rebasing on the answer needs the fault that is about what it asked:
 *
 *  - **Two nodes sharing an id** — named before the root count and the parent
 *    pointers, because every helper resolves an id to the FIRST match, so a
 *    collision does not corrupt a tree, it makes one node invisible.
 *  - **A pane holding children** — `not_a_container`, the operation's word for
 *    "you named a leaf as a destination", ahead of the validator's
 *    `unreachable`, which is the truer thing to say about the resulting SET and
 *    the less useful thing to say to the caller.
 *  - **A non-finite share** — `invalid_fraction`, the same code `resize`
 *    returns for a share the caller supplied, so one operation does not answer
 *    with two vocabularies depending on whose share was bad.
 *
 * Nothing is added to `validateTree` lightly, because its violation order is
 * load-bearing — each of its checks assumes what the ones before it
 * established — so extending it is its own change with its own reasoning.
 */
function accept(next: readonly WorkspaceNode[], write: NodeWrite): NodeOperationResult {
  const seen = new Set<string>();
  for (const node of next) {
    if (seen.has(node.id)) return reject('duplicate_id', `two nodes share the id "${node.id}"`);
    seen.add(node.id);
  }

  for (const node of next) {
    if (node.parentId === null) continue;
    const parent = findNode(next, node.parentId);
    if (parent?.nodeType === 'pane') {
      return reject('not_a_container', `node "${node.id}" is parented to pane "${parent.id}", which is a leaf`);
    }
  }

  for (const node of next) {
    const share = fractionOf(node);
    if (share !== undefined && !Number.isFinite(share)) {
      return reject('invalid_fraction', `node "${node.id}" holds a fraction of ${share}`);
    }
  }

  const validation = validateTree(next);
  if (!validation.ok) return reject(validation.code, validation.detail);
  return { ok: true, write };
}

/** Finish an operation: derive its write from the tree it produced, then validate. */
function settle(nodes: readonly WorkspaceNode[], next: readonly WorkspaceNode[]): NodeOperationResult {
  return accept(next, writeBetween(nodes, next));
}

// ---------------------------------------------------------------------------
// The five operations
// ---------------------------------------------------------------------------

/** What `create` mints. `index` defaults to last. */
export interface CreateInput {
  nodeId: string;
  target: PaneTarget | null;
  /** REQUIRED. There is nowhere for a pane to be except under a parent. */
  parentId: string;
  index?: number;
}

/**
 * Mint a pane. IT CARRIES ITS PARENT, and that is the whole point.
 *
 * There is no create-then-attach path here and there must never be one. Under
 * create-then-attach, making something appear on screen takes two successful
 * transitions, so every caller has to reason about the moment where the first
 * landed and the second did not — which is the state production is in today,
 * with workspaces that exist holding zero panes. An atomic create has no such
 * moment.
 *
 * `parentId` is a `string` and there is no detached mint. An earlier cut
 * accepted `null` here and called the result parked, which meant `create` could
 * produce exactly the population that makes a lost pane indistinguishable from a
 * closed one.
 *
 * Ids come from the CALLER, never from in here. The client mints them, so
 * applying the write optimistically needs no round trip to learn what the thing
 * it just drew is called.
 */
export function create(nodes: readonly WorkspaceNode[], input: CreateInput): NodeOperationResult {
  const { nodeId, target, parentId, index } = input;

  // FIRST, ahead of the conflict checks, because a blank id is not an id that
  // is taken — it is not an id at all, and everything below resolves nodes by
  // one. Ids are minted on the CLIENT, so this is a defaulted variable or an
  // off-by-one in id generation, not a hypothetical.
  //
  // It has to be refused HERE because nothing downstream can. `''` satisfies
  // `text NOT NULL`, so the row lands; `nodeFromRow` then refuses it, and
  // `nodesFromRows` rejects the whole set rather than filtering — deliberately,
  // since dropping the row would be indistinguishable from the user having
  // closed the pane. The workspace becomes permanently unreadable, and the read
  // is the only way in: repair takes a hand-written DELETE against production.
  //
  // `trim()`, not a length test, and the same rule `bind` spells: an id of
  // spaces addresses nothing, and it is the one the row parse's
  // `z.string().min(1)` would carry all the way through.
  if (nodeId.trim() === '') {
    return reject('invalid_id', 'a node needs an id; a blank one is stored once and readable never');
  }

  // Then an id already in the set, because it would be UPSERTED over its
  // sitting node rather than minted beside it — a create that reads as a
  // success and quietly ate a pane.
  if (findNode(nodes, nodeId) !== undefined) {
    return reject('duplicate_id', `the workspace already holds a node "${nodeId}"`);
  }

  // Beside it, because it is the same kind of fault: a create naming something
  // the workspace already holds. A pane minted already bound is bound for life,
  // so this is the only moment the conflict can be refused rather than
  // discovered from the index.
  if (target !== null) {
    // The blank-target rule `bind` states at the fill, stated here at the mint.
    // `create` binds at the mint — that is the entire reason `CreateInput`
    // carries a target — so this is the other place a pane can be bound to
    // nothing, and it lands as the same unreadable row a blank node id does.
    // Ahead of `shownElsewhere`, so two panes minted onto nothing are answered
    // with the fault rather than with each other.
    if (target.id.trim() === '') {
      return reject('invalid_target', `pane "${nodeId}" would be minted onto a ${target.kind} target with no id`);
    }
    const taken = shownElsewhere(nodes, target, nodeId);
    if (taken !== undefined) {
      return reject(
        'target_already_shown',
        `node "${taken.id}" already shows chat "${target.id}"; a conversation renders in at most one pane`,
      );
    }
  }

  if (findNode(nodes, parentId) === undefined) {
    return reject('unknown_parent', `no node "${parentId}" to create "${nodeId}" in`);
  }
  // A parent that resolves to a PANE is refused too, but by the gate rather than
  // here: "a pane holds no children" is one invariant of the whole algebra, so it
  // is stated once instead of at each call site that could break it.

  const siblings = membersOf(nodes, parentId);
  // Omitted means last. The group is one longer once the pane is in it, so
  // appending is the slot at `siblings.length`.
  const at = index ?? siblings.length;
  if (!isSlot(at, siblings.length + 1)) {
    return reject('invalid_index', `slot ${at} is not one of the ${siblings.length + 1} a create leaves`);
  }

  const minted: PaneNode = { nodeType: 'pane', id: nodeId, parentId, position: at, target };
  const members = [...siblings.slice(0, at), minted, ...siblings.slice(at)];
  return settle(nodes, reseat([...nodes, minted], [{ parentId, members }]));
}

/** Where `move` puts a node. A destination is always a real container. */
export interface MoveInput {
  nodeId: string;
  /** REQUIRED. "Out of the tree" is not a destination; leaving is a `destroy`. */
  parentId: string;
  index: number;
}

/**
 * THE ONLY OPERATION THAT CHANGES WHERE A NODE IS — reordered inside a parent,
 * or carried between parents.
 *
 * One operation because those are one thing: the model this replaces spent two
 * verbs on them (`move_pane`, `reorder_columns`). It does NOT also mean
 * "leaving", and that is the correction. An earlier cut let `parentId: null`
 * mean out-of-the-tree, so `move` was both a relocation and a removal, and a
 * closed pane and a broken one ended up in the same state. Leaving is
 * {@link destroy}.
 *
 * A node's BINDING is untouched: this moves a rectangle, never what it shows.
 *
 * Sizing follows `movePane`'s rule, because it is the right one — a node
 * arriving under a NEW parent is a newcomer and takes an even share, since a
 * share chosen against one container means nothing in another, while a reorder
 * inside one parent is a permutation and carries each member's own share along.
 */
export function move(nodes: readonly WorkspaceNode[], input: MoveInput): NodeOperationResult {
  const { nodeId, parentId, index } = input;

  const node = findNode(nodes, nodeId);
  if (node === undefined) return reject('unknown_node', `no node "${nodeId}" to move`);
  if (node.nodeType === 'root') {
    return reject('root_immutable', `node "${nodeId}" is the root; the workspace has no outside`);
  }

  if (parentId === nodeId) {
    return reject('parent_in_subtree', `node "${nodeId}" cannot be its own parent`);
  }
  // As in `create`, a pane named as a destination is refused by the gate.
  if (findNode(nodes, parentId) === undefined) {
    return reject('unknown_parent', `no node "${parentId}" to move "${nodeId}" into`);
  }
  // A destination BENEATH the mover takes the whole branch out of the tree
  // with it. `validateTree` would catch the resulting cycle, but "you asked to
  // move a node inside itself" is a different bug from "the tree you wrote
  // loops", and a caller rebasing on the answer needs to see which.
  if (descendantsOf(nodes, nodeId).some((descendant) => descendant.id === parentId)) {
    return reject('parent_in_subtree', `node "${parentId}" is inside "${nodeId}", which cannot hold it`);
  }
  // The `parentId` the moved node carries is always the one the caller supplied.
  // There is no path here on which a parent is chosen rather than given.
  const arriving: MemberNode = { ...node, parentId };

  const origin = node.parentId;
  const sameParent = origin === parentId;
  const destination = membersOf(nodes, parentId).filter((sibling) => sibling.id !== nodeId);
  if (!isSlot(index, destination.length + 1)) {
    return reject('invalid_index', `slot ${index} is not one of the ${destination.length + 1} a move leaves`);
  }

  // A newcomer under a new parent; a permutation keeps its own share.
  const seated = sameParent ? arriving : withFraction(arriving, null);
  const members = [...destination.slice(0, index), seated, ...destination.slice(index)];
  if (sameParent) return settle(nodes, reseat(nodes, [{ parentId, members }]));

  const vacated = membersOf(nodes, origin).filter((sibling) => sibling.id !== nodeId);
  return settle(nodes, collapseInto(nodes, origin, vacated, { parentId, members }));
}

/**
 * Re-seat the destination group and whatever the departure left behind,
 * collapsing the origin if it is a split down to a single child.
 *
 * **A split holding one child states nothing its parent did not already say**,
 * and `validateTree` rejects one — so this is not an optimization, it is what
 * makes an ordinary close an operation that can succeed at all. The survivor
 * takes the split's PLACE: its parent, its slot and its share, which is why the
 * grandparent's shares still sum to 1 without anyone renumbering them.
 *
 * The survivor inheriting the split's `parentId` is the one assignment in this
 * file that moves a node the caller did not name, and it is not a fallback:
 * it happens on a SUCCESS path, to put a node exactly where the container that
 * held it was, never to rescue a pointer that failed to resolve.
 */
function collapseInto(
  nodes: readonly WorkspaceNode[],
  origin: string,
  vacated: readonly MemberNode[],
  destination?: GroupOrder,
): WorkspaceNode[] {
  const arrivals = destination === undefined ? [] : [destination];
  const container = findNode(nodes, origin);
  if (container === undefined || container.nodeType !== 'split' || vacated.length !== 1) {
    return reseat(nodes, [...arrivals, { parentId: origin, members: vacated }]);
  }

  const survivor = withFraction(
    { ...vacated[0], parentId: container.parentId },
    container.fraction ?? null,
  );
  const inherit = (member: MemberNode): MemberNode => (member.id === container.id ? survivor : member);

  // When the moved node is arriving in the very group the split sat in, that
  // group is already being rewritten — so the substitution happens there rather
  // than in a second pass that would renumber the same members twice.
  const groups: GroupOrder[] =
    destination !== undefined && destination.parentId === container.parentId
      ? [{ parentId: destination.parentId, members: destination.members.map(inherit) }]
      : [
          ...arrivals,
          {
            parentId: container.parentId,
            members: membersOf(nodes, container.parentId).map(inherit),
          },
        ];
  return removeNodes(reseat(nodes, groups), [container.id]);
}

/** Which node `destroy` removes, along with everything beneath it. */
export interface DestroyInput {
  nodeId: string;
}

/**
 * Remove a node AND ITS SUBTREE. **THE ONE REMOVAL.**
 *
 * Point it at a pane and the pane goes. Point it at a split and the split and
 * everything under it goes. Point it at the ROOT and the whole session goes —
 * same verb, same meaning, a different target.
 *
 * **Why the root is not refused here.** It was, in the cut this corrects, on the
 * grounds that "a workspace cannot destroy itself". The effect was not that
 * sessions stopped ending; it was that ending one became a SEPARATE LIFECYCLE
 * MECHANISM, because the tree's own removal was forbidden from touching the top
 * of the tree. Two removals with two meanings, reconciled by convention — the
 * exact shape this epic exists to delete, rebuilt at the other end. So the
 * refusal is gone and the root is an ordinary target.
 *
 * The root stays immutable for `move`, `bind` and `resize`. Those are not a
 * second mechanism: a workspace has no outside to move into, shows nothing of
 * its own, and is not a share of anything, so refusing them states that the
 * operations are meaningless rather than that the root is special.
 *
 * **What a destroyed root leaves is an EMPTY NODE SET, and that is a valid
 * tree** (`validateTree` settles the empty list first, ahead of `no_root`).
 * Ending a session has a LIFECYCLE consequence this operation deliberately does
 * not carry — the sandbox teardown and the row's `endedAt` — because those are
 * facts about `agent_workspaces` and this is a function over a node list. The
 * composition lives at the runtime; see `endSession`.
 *
 * Composed rather than special-cased — `[nodeId, ...descendantsOf(nodes,
 * nodeId)]` is the whole of what "destroy a container" means, which is why
 * `removeNodes` takes its ids and does not walk the tree itself.
 *
 * Removing a node can leave its parent a split with one child, which
 * `validateTree` rejects — so this collapses through exactly the path `move`
 * does. Destroying a pane out of a two-pane column and moving it out are the
 * same event as far as the column is concerned.
 */
export function destroy(nodes: readonly WorkspaceNode[], input: DestroyInput): NodeOperationResult {
  const { nodeId } = input;

  const node = findNode(nodes, nodeId);
  if (node === undefined) return reject('unknown_node', `no node "${nodeId}" to destroy`);

  const pruned = removeNodes(nodes, [nodeId, ...descendantsOf(nodes, nodeId).map((n) => n.id)]);
  // The root has no parent group to reseat and no container to collapse: what
  // it leaves is whatever did not descend from it, which in a valid tree is
  // nothing. A straggler survives into `settle` rather than being swept, so a
  // set that somehow held an unreachable node is REFUSED as `no_root` instead of
  // being silently tidied — this operation removes what it names and nothing
  // else, at the top of the tree exactly as at the bottom.
  if (node.nodeType === 'root') return settle(nodes, pruned);

  return settle(nodes, collapseInto(pruned, node.parentId, membersOf(pruned, node.parentId)));
}

/** What `bind` fills an empty slot with. */
export interface BindInput {
  nodeId: string;
  target: PaneTarget;
}

/**
 * Fill an empty slot: give an unbound pane the thing it is a viewport onto.
 *
 * **ONLY a pane whose target is null.** A bound pane's target never changes for
 * the whole of its life, and refusing the rebind is the decision, not an
 * omission: a pane that could be re-pointed is the same object as its
 * conversation, and we chose the other side. Swapping what a pane displays is
 * two `move`s one layer up — the old pane leaves, a new one arrives — which
 * keeps "this rectangle" and "this conversation" separable, so closing a view
 * never reads as discarding what it showed.
 *
 * And only a conversation NO OTHER node shows — see {@link shownElsewhere}. The
 * database refuses that binding, so the algebra has to refuse it first or the
 * caller learns it from a raw index violation with the optimistic edit already
 * applied.
 */
export function bind(nodes: readonly WorkspaceNode[], input: BindInput): NodeOperationResult {
  const { nodeId, target } = input;

  const node = findNode(nodes, nodeId);
  if (node === undefined) return reject('unknown_node', `no node "${nodeId}" to bind`);
  if (node.nodeType === 'root') {
    return reject('root_immutable', `node "${nodeId}" is the root, which shows nothing of its own`);
  }
  if (node.nodeType !== 'pane') {
    return reject('not_a_pane', `node "${nodeId}" is a split; only a pane is a viewport onto anything`);
  }
  if (node.target !== null) {
    return reject(
      'already_bound',
      `pane "${nodeId}" already shows ${node.target.kind} "${node.target.id}"; a binding is for life`,
    );
  }
  // A blank id is the one bad target that does not announce itself. The pane
  // stops being unbound the moment this lands, so it never renders the picker
  // again — and since a binding is for life, there is no second chance to
  // notice.
  //
  // This is one of TWO places it can be caught, and both are needed: a pane
  // reaches a target either by being filled here or by being minted already
  // carrying one, and `create` states the identical rule for the second. Only
  // `validateTree` sees both, plus the `put(nodes[])` write that goes through
  // neither.
  if (target.id.trim() === '') {
    return reject('invalid_target', `pane "${nodeId}" was given a ${target.kind} target with no id`);
  }
  // AFTER `already_bound`, so a pane re-bound to the very target it shows keeps
  // answering with that code. Nothing is being shown twice there — the fault is
  // that a binding is for life, which is a different bug with a different fix,
  // and `shownElsewhere` excludes this node for the same reason.
  const taken = shownElsewhere(nodes, target, nodeId);
  if (taken !== undefined) {
    return reject(
      'target_already_shown',
      `node "${taken.id}" already shows chat "${target.id}"; a conversation renders in at most one pane`,
    );
  }

  return settle(nodes, upsertNodes(nodes, [{ ...node, target }]));
}

/** The share `resize` gives a node of its parent — strictly between 0 and 1. */
export interface ResizeInput {
  nodeId: string;
  fraction: number;
}

/**
 * Set a node's share of its parent and let its siblings absorb the difference
 * in proportion. A container nobody had sized MATERIALIZES here: every member's
 * even share becomes a stored one, because the moment a single member is
 * explicitly sized the others' shares stop being derivable from the count.
 *
 * The share is REFUSED outside `(0, 1)` rather than clamped, which is where
 * this parts company with `resizeColumn`. That verb was total by design — "a
 * 200% column is a caller bug, not a reason to fail a grid" — but a total verb
 * has no way to tell a caller it was wrong, and this algebra does. The
 * `MIN_FRACTION` floor inside `resizeShare` still clamps, and that is a
 * different thing: it is a structural minimum that keeps a pane clickable, not
 * a guess at what the caller meant.
 *
 * Non-finite is checked FIRST and by `Number.isFinite`, not by the range test
 * below it: every comparison against NaN is false, so `NaN <= 0 || NaN >= 1`
 * admits it — and `validateTree` would too, since `Math.abs(NaN - 1) >=
 * FRACTION_EPSILON` is false as well. A NaN share has no other gate.
 */
export function resize(nodes: readonly WorkspaceNode[], input: ResizeInput): NodeOperationResult {
  const { nodeId, fraction } = input;

  const node = findNode(nodes, nodeId);
  if (node === undefined) return reject('unknown_node', `no node "${nodeId}" to resize`);
  if (node.nodeType === 'root') {
    return reject('root_immutable', `node "${nodeId}" is the root; it is not a share of anything`);
  }
  if (!Number.isFinite(fraction)) {
    return reject('invalid_fraction', `a share of ${fraction} is not a number a container can hold`);
  }
  if (fraction <= 0 || fraction >= 1) {
    return reject('invalid_fraction', `a share of ${fraction} is not strictly between 0 and 1`);
  }

  const siblings = membersOf(nodes, node.parentId);
  // A lone member owns its whole container, so a stored share would state
  // nothing the structure does not — and would make a container that had shrunk
  // to one look sized, so the next arrival would rebalance against a number
  // nobody chose. `resizeColumn` and `resizePane` refuse this for the same reason.
  if (siblings.length < 2) {
    return reject('not_sizable', `node "${nodeId}" is alone in "${node.parentId}" and owns all of it`);
  }

  const index = siblings.findIndex((sibling) => sibling.id === nodeId);
  const shares = resizeShare(currentShares(siblings.map((sibling) => sibling.fraction)), index, fraction);
  return settle(
    nodes,
    upsertNodes(nodes, siblings.map((sibling, at) => withFraction(sibling, shares[at]))),
  );
}
