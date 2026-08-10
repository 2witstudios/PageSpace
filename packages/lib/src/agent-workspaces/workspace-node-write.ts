/**
 * THE WRITE DECISION — everything `POST /nodes` decides before it touches a row.
 *
 * Pure, and separated from the store for the reason every other decision in
 * this epic is: the refusals are the interesting part, and they should be
 * testable against a list of nodes rather than against a database. The DB shell
 * next door (`services/agent-workspaces/workspace-node-store.ts`) does exactly
 * what this returns and decides nothing.
 *
 * **It refuses; it never repairs.** There is no `parentId` assignment anywhere
 * in this file — not on a success path and certainly not on a failure one. A
 * `put` whose result leaves a node parented to something that is not in the set
 * is a REJECTED write, not a node re-attached to the root. That fallback is how
 * a pane ends up restructured into a session the user never put it in: a pending
 * move naming a container another client just deleted has to be refused so the
 * client rebases, because "attach it to the root instead" is not a repair, it is
 * a relocation nobody asked for.
 *
 * **The order of the four checks is load-bearing:**
 *
 *  1. SCOPE, first and unconditionally. A payload naming another workspace is
 *     malformed however fresh its `baseRev` is, and it must never be answered
 *     with 409 + truth — "here is the state to rebase against" would invite the
 *     caller to send the same cross-workspace payload again against a newer rev.
 *  2. REV. A stale caller is told the truth and rebases; nothing below runs,
 *     because a tree reduced against a rev that is gone says nothing about the
 *     tree that is actually there.
 *  3. VALIDITY of the APPLIED RESULT — not of the payload. A payload is a delta,
 *     and a delta cannot be judged: dropping a container is legal exactly when
 *     the same write re-parents its children, and only the result knows.
 *  4. CHANGE. A write that produces the tree already stored bumps no rev and
 *     broadcasts nothing — the "declined" convention the model this replaces
 *     spelled as `next !== state`, and the reason a retried POST is observably
 *     as well as structurally a no-op.
 *
 * **And then the fifth thing, which is not a check.** What the caller named is
 * not what the STORAGE has to be told to do, because the node table's self-FK
 * cascades — see {@link persistedWrite}. Deriving the storage instruction here,
 * beside the tree it was judged against, is the only place it can be derived
 * from the OLD shape of the tree at all.
 */

import { readFraction } from './workspace-fractions';
import { descendantsOf, upsertNodes, removeNodes, type WorkspaceNode } from './workspace-node';
import { validateTree, type TreeViolationCode } from './workspace-node-validate';
import { nodeOfWire, type WireWorkspaceNode } from './workspace-node-wire';

/**
 * What the store is told to do: rows to remove, then rows to upsert. NOT the
 * caller's `put`/`drop` — see {@link persistedWrite}.
 */
export interface PersistedNodeWrite {
  put: WorkspaceNode[];
  drop: string[];
}

/**
 * What the decision comes to.
 *
 * `foreign_scope` and `invalid` are both refusals that write nothing, and they
 * are kept apart because the caller's fix differs: one is a payload that names
 * the wrong session (a client bug — retrying cannot help), the other is a tree
 * that would not stand up (rebase and recompute). `stale` is not a failure at
 * all; it is an answer carrying the truth.
 */
export type NodeWriteDecision =
  | { status: 'foreign_scope'; detail: string }
  | { status: 'stale' }
  | { status: 'invalid'; code: TreeViolationCode; detail: string }
  | { status: 'ok'; nodes: WorkspaceNode[]; persist: PersistedNodeWrite; changed: boolean };

export interface NodeWriteRequest {
  /** The workspace from the URL — the ONLY thing that decides where rows land. */
  workspaceId: string;
  /** The rev the atomic read returned, describing `nodes` exactly. */
  rev: number;
  /** The workspace's nodes as that same read saw them. */
  nodes: readonly WorkspaceNode[];
  baseRev: number;
  put: readonly WireWorkspaceNode[];
  drop: readonly string[];
}

/**
 * Two nodes that would render and persist identically.
 *
 * Fractions compare through {@link readFraction}, the SAME funnel the store's
 * read uses, because the `fraction` column is a Postgres `real`: a double
 * written out does not read back bit-identical, and without a shared
 * quantization every re-send of a sized tree would look like a change, bump a
 * rev and broadcast. Snapping both sides to one grid makes the round trip an
 * identity.
 */
function sameNode(left: WorkspaceNode, right: WorkspaceNode): boolean {
  if (left.nodeType !== right.nodeType) return false;
  if (left.parentId !== right.parentId || left.position !== right.position) return false;
  const leftAxis = left.nodeType === 'pane' ? null : left.axis;
  const rightAxis = right.nodeType === 'pane' ? null : right.axis;
  if (leftAxis !== rightAxis) return false;
  const leftTarget = left.nodeType === 'pane' ? left.target : null;
  const rightTarget = right.nodeType === 'pane' ? right.target : null;
  if (leftTarget?.kind !== rightTarget?.kind || leftTarget?.id !== rightTarget?.id) return false;
  const leftShare = left.nodeType === 'root' ? null : readFraction(left.fraction);
  const rightShare = right.nodeType === 'root' ? null : readFraction(right.fraction);
  return leftShare === rightShare;
}

/**
 * ONE NODE SAID TWICE IN ONE PAYLOAD IS ONE NODE — and only when the two
 * sayings agree.
 *
 * The idempotency this model runs on is "the same write applied twice is the
 * same result", and until this function that held only ACROSS payloads: a
 * retried POST re-upserts its nodes and lands where the first one did. Within a
 * single payload the same repetition was fatal, because {@link upsertNodes}
 * replaces by id against the STORED nodes and appends everything else in order
 * — it does not collapse a repeat inside `changed` — so both copies reached
 * {@link validateTree} and came back `duplicate_id`, a 400 the client treats as
 * unrecoverable.
 *
 * That is not a hypothetical shape. It is the ROOT SEED. A workspace with no
 * tree is seeded by whichever write first needs a root, and BOTH ends mint one:
 * the browser prepends `seedRoot`'s node so its optimistic tree has somewhere to
 * put a pane, and the server prepends its own inside the lock so the write is
 * legal whatever the client sent. Both come from `rootSeedFor(workspaceId)` and
 * are therefore the identical node — the convergence the deterministic id was
 * chosen FOR — and they met in one `put`, where the convergence did not apply.
 * Every first command against an empty tree failed.
 *
 * **Identical only, deliberately.** Two DIFFERENT nodes claiming one id is a
 * real fault with a real code, and collapsing it last-wins would judge a tree on
 * whichever half survived and then store that half silently. Those repeats are
 * left in place so the validator still refuses them. What is dropped is
 * strictly the repetition that says nothing: same id, same everything
 * {@link sameNode} compares, so the payload means the same with it as without.
 *
 * Done HERE rather than at the seed's call site because the duplicate must also
 * leave `persist.put`: a multi-row `INSERT … ON CONFLICT DO UPDATE` carrying one
 * key twice is a Postgres error ("cannot affect row a second time"), so a fix
 * that only satisfied the validator would trade the 400 for a 500.
 */
function collapseRepeats(incoming: readonly WorkspaceNode[]): WorkspaceNode[] {
  const kept: WorkspaceNode[] = [];
  const byId = new Map<string, WorkspaceNode>();
  for (const node of incoming) {
    const seen = byId.get(node.id);
    if (seen !== undefined && sameNode(seen, node)) continue;
    byId.set(node.id, node);
    kept.push(node);
  }
  return kept;
}

/**
 * TRANSLATE THE DECIDED TREE INTO A STORAGE INSTRUCTION, and it is NOT the
 * caller's `put`/`drop`.
 *
 * Two things force the translation, and both are properties of the table rather
 * than of the model:
 *
 * **The drop set is derived, not taken.** A `drop` naming a node that is not
 * there is tolerated — `removeNodes` ignores unknown ids, and it must, because
 * that is precisely what a REPLAY looks like: the first POST removed the node,
 * the retry names it again. And a node in BOTH `put` and `drop` resolves as
 * "put wins" (drop-then-upsert), so it is not removed at all. Both fall out of
 * asking what is in `nodes` and not in `next`, rather than of trusting the
 * payload's arithmetic.
 *
 * **THE CASCADE.** `agent_workspace_nodes`'s composite self-FK is
 * `ON DELETE CASCADE`, so removing a container removes its whole subtree in the
 * database — which is a gift when destroying a column and a data-loss bug when
 * COLLAPSING one. The algebra's `collapseInto` produces exactly that shape: a
 * split that drops to one child is dropped, and the survivor inherits its place,
 * so the write is `drop: [container], put: [survivor]`. If the survivor is
 * itself a container, ITS children did not move and are therefore not in `put`
 * at all — and the cascade would take them, leaving a split with no children in
 * a tree the validator already approved. The write would report success and the
 * next read would come back short.
 *
 * So every node that SURVIVES into `next` while sitting beneath a removed node
 * in the OLD tree is added to the upsert. The delete runs first and takes them;
 * the upsert puts them straight back, unchanged, in the same statement as their
 * re-parented ancestor. Deliberately NOT solved by upserting before deleting:
 * that ordering makes two nodes hold one chat target for the duration of the
 * transaction, which the table's `UNIQUE (targetId) WHERE targetKind = 'chat'`
 * refuses immediately — closing one hole by opening another.
 */
function persistedWrite(
  nodes: readonly WorkspaceNode[],
  next: readonly WorkspaceNode[],
  changedPut: readonly WorkspaceNode[],
): PersistedNodeWrite {
  const surviving = new Set(next.map((node) => node.id));
  const removed = nodes.filter((node) => !surviving.has(node.id)).map((node) => node.id);

  // Descendants in the OLD tree — the shape the database still holds, and the
  // only shape that can say what the cascade will reach.
  const cascaded = new Set<string>();
  for (const id of removed) {
    for (const descendant of descendantsOf(nodes, id)) cascaded.add(descendant.id);
  }

  const staged = new Set(changedPut.map((node) => node.id));
  const rescued = next.filter((node) => cascaded.has(node.id) && !staged.has(node.id));

  return { put: [...changedPut, ...rescued], drop: removed };
}

/**
 * Decide one `{baseRev, put, drop}` against the workspace as the atomic read saw
 * it. See the module doc for why the checks run in this order.
 */
export function decideNodeWrite(request: NodeWriteRequest): NodeWriteDecision {
  const { workspaceId, rev, nodes, baseRev, put, drop } = request;

  // 1. SCOPE. This route is one of only two places a node's workspace can
  //    change, and a payload that reassigns one is the "panes restructure into a
  //    different session" failure arriving over the wire. The ENTIRE write is
  //    refused, not the offending node: a partially applied restructuring is a
  //    tree neither the sender nor the server ever intended.
  const foreign = put.find((node) => node.rootId !== undefined && node.rootId !== workspaceId);
  if (foreign !== undefined) {
    return {
      status: 'foreign_scope',
      detail: `node "${foreign.id}" claims workspace ${foreign.rootId}, but this write is scoped to ${workspaceId}`,
    };
  }

  // 2. REV.
  if (baseRev !== rev) return { status: 'stale' };

  // The payload's nodes, with any node it named twice IDENTICALLY reduced to
  // one. See {@link collapseRepeats}: the root seed arrives from both ends of a
  // first write, and everything below — the validated tree, the change
  // measurement, the storage instruction — must see one of it.
  const incoming = collapseRepeats(put.map(nodeOfWire));

  // 3. VALIDITY OF THE RESULT. Drop then upsert, so an id named in BOTH
  //    resolves as PUT WINS — which is the decision `persistedWrite` below
  //    depends on: it strips such an id from the DELETE so the table's cascade
  //    cannot take the children of a node the validated tree still holds.
  //
  //    NOT `applyNodeWrite`'s order, and the difference is worth stating
  //    because an earlier comment here claimed it was. The algebra folds
  //    put-then-drop (see its docblock: the order is load-bearing for the
  //    cascade), so on the one input where the two orders differ — an id in
  //    both — the algebra drops the node and this keeps it. The algebra's
  //    docblock states the assumption that makes them agree everywhere else:
  //    "a node is never in both", true of every write the algebra BUILDS.
  //    A hand-assembled payload can break it, and then an optimistic client
  //    shows the node gone while the server stores it — corrected by the next
  //    broadcast, which carries the server's tree. Benign, and left alone
  //    deliberately: making the two agree means changing one of two orders that
  //    each exist for a reason, on the rarest input either will ever see.
  const next = upsertNodes(removeNodes(nodes, drop), incoming);
  const validation = validateTree(next);
  if (!validation.ok) return { status: 'invalid', code: validation.code, detail: validation.detail };

  // 4. CHANGE. Measured against what is stored rather than trusted from the
  //    payload: a client re-sending the nodes it already sent is the ordinary
  //    shape of a retry, and it must not bump a rev.
  const before = new Map(nodes.map((node) => [node.id, node]));
  const changedPut = incoming.filter((node) => {
    const previous = before.get(node.id);
    return previous === undefined || !sameNode(previous, node);
  });

  const persist = persistedWrite(nodes, next, changedPut);
  return {
    status: 'ok',
    nodes: next,
    persist,
    // The CALLER's change, not the storage instruction's: the rows rescued from
    // the cascade are re-written unchanged, and a write whose only content is a
    // rescue cannot happen (a rescue implies something was removed).
    changed: changedPut.length > 0 || persist.drop.length > 0,
  };
}
