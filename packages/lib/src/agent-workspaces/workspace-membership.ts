/**
 * MEMBERSHIP — "what is in this workspace" — expressed in the node tree and
 * nowhere else.
 *
 * Until this module, a workspace's membership lived in `conversations.workspaceId`
 * (+ `closedInWorkspaceAt`) and its layout lived in pane rows, and nothing kept
 * the two in correspondence. That is why workspaces exist in production holding
 * zero panes, and why a thread could be bound to a workspace and invisible in
 * it: two structures, two write paths, one convention joining them.
 *
 * Here there is one structure. A conversation is IN a workspace exactly when a
 * node of that workspace's tree is bound to it — so admitting a thread and
 * showing a thread are the same write, and there is no second place membership
 * could be recorded, disagree, or fail to be recorded at all.
 *
 * **The three acts, and what each is in the algebra:**
 *
 *  - {@link admit}   — a `create`. The node IS the membership, so this is the
 *                      only thing that makes a thread a member.
 *  - {@link dismiss} — a `move` to no parent. The thread leaves the GRID and
 *                      stays a member. See the module note below.
 *  - {@link readmit} — a `move` back into the grid.
 *
 * **Why dismiss is a `move` and not a `destroy`.** A detached node is still a
 * member (`workspace-node.ts`: "in the workspace and in the sidebar, not on
 * screen"), and three things follow from choosing `move`:
 *
 *  1. The table's global `UNIQUE (targetId) WHERE targetKind = 'chat'` is what
 *     makes the binding write-once — contract invariant 1, "a bound thread
 *     moving to another session is a fork, never a rebind". Under `move` the
 *     row survives for the life of the workspace, so the constraint enforces
 *     the invariant permanently. A `destroy` FREES that index: a closed thread
 *     could then be claimed into a different workspace, which is a rebind
 *     reached by clicking "close".
 *  2. Closing a PANE is already a `move` to no parent ({@link closePane}). If
 *     closing a LISTING were a destroy, the model would again have two removals
 *     with two meanings — the split this epic exists to delete.
 *  3. A close that only changes location is exactly reversible. A close that
 *     destroys is reversible only if nothing took the binding in between, which
 *     is a promise this layer cannot make.
 *
 * The cost is named rather than hidden: a dismissed thread no longer disappears
 * from the workspace's listing, because a workspace's listing is now its
 * members. "Take this out of my workspace entirely" is a different act, and it
 * belongs to history-deletion ({@link expel}), not to a close button.
 *
 * **The cap lives here too**, and that is a consequence rather than an
 * addition. `MAX_SESSION_CONVERSATIONS` bounds the conversations a workspace
 * holds; membership is now a property of the tree, so the bound is a property
 * of the tree, checked in the same locked transaction that writes it. It used
 * to be a `SELECT count(*)` racing the insert it guarded.
 *
 * Pure, like every decision layer in this epic: it takes a node list and
 * returns a write, so the refusals — which are the interesting part — are
 * testable against an array rather than against a database.
 */

import { MAX_SESSION_CONVERSATIONS } from './plan-spawn-worker';
import { create, destroy, move, type NodeWrite } from './workspace-node-algebra';
import {
  childrenOf,
  detachedOf,
  rootOf,
  type NodeAxis,
  type PaneNode,
  type PaneTarget,
  type RootNode,
  type WorkspaceNode,
} from './workspace-node';
import { compile, openConversation, type CommandCode, type Step } from './workspace-node-commands';

/**
 * Why a membership act was refused.
 *
 * Widens {@link CommandCode} by exactly two, and both are membership facts that
 * no command or operation could state:
 *
 *  - `session_full` — the workspace already holds the cap. A count over the
 *    tree, so it cannot disagree with what the tree holds.
 *  - `not_a_member` — the thread has no node here at all. Distinct from
 *    `unknown_node`, which names a node id the caller supplied; here the caller
 *    named a CONVERSATION and the workspace simply does not hold it.
 */
export type MembershipCode = CommandCode | 'session_full' | 'not_a_member' | 'last_member';

/** Mirrors {@link CommandResult} deliberately: one result type at every layer. */
export type MembershipResult =
  | { ok: true; write: NodeWrite }
  | { ok: false; code: MembershipCode; detail: string };

function refuse(code: MembershipCode, detail: string): MembershipResult {
  return { ok: false, code, detail };
}

/** The write that says "nothing to do". A retry, a stale click, an act already performed. */
const NOTHING: MembershipResult = { ok: true, write: { put: [], drop: [] } };

/**
 * The node bound to this target, if the workspace holds one — THE membership
 * question, asked of the tree.
 *
 * Kind and id both, so a page id and a conversation id that happen to collide
 * never answer for each other.
 */
export function memberNode(
  nodes: readonly WorkspaceNode[],
  target: PaneTarget,
): PaneNode | undefined {
  return nodes.find(
    (node): node is PaneNode =>
      node.nodeType === 'pane' && node.target?.kind === target.kind && node.target.id === target.id,
  );
}

/**
 * Every conversation this workspace holds, whether on screen or parked.
 *
 * This is the workspace's thread listing, and it is the SAME list the grid is
 * drawn from — which is the entire point. `annotate-conversation-panes.ts`
 * existed to reconcile a listing with a grid; there is nothing to reconcile
 * once one row answers both.
 */
export function chatMembers(nodes: readonly WorkspaceNode[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.nodeType === 'pane' && node.target?.kind === 'chat') ids.push(node.target.id);
  }
  return ids;
}

/** What {@link admit} needs beyond the thing being admitted. */
export interface AdmitInput {
  /** The thing joining the workspace. */
  target: PaneTarget;
  /** The pane minted for it. Client-minted like every id in this model. */
  newNodeId: string;
  /** The container minted if an attached placement has to split. */
  newSplitId: string;
  /**
   * The root minted if this workspace has no tree at all.
   *
   * A freshly spawned workspace has ZERO rows — `validateTree` calls an empty
   * list `no_root`, so the first membership write is also the write that brings
   * the tree into being. Making that a separate act would reintroduce the
   * moment where the first landed and the second did not, which is the state
   * this epic is deleting.
   */
  newRootId: string;
  /**
   * Put it on screen NOW, or leave it parked.
   *
   * This is what `placeInGrid` narrows to, and the narrowing is the point: the
   * old flag decided whether the thread existed in the grid AT ALL, and a
   * thread it said no to was a member of nothing that could be rendered. Here
   * both answers are membership; only the location differs.
   *
   * A caller with a pane already waiting (the picker binds its own pane after
   * the POST returns) must say `false`, or the placement policy mints a SECOND
   * pane beside the one the client is about to fill.
   */
  attach: boolean;
  /** The split's direction when an attached placement comes to that. */
  axis?: NodeAxis;
  /** Where the user is looking — a preference, honoured only if it resolves. */
  activeNodeId?: string;
  /** The invoking conversation: never evicted by the thing it spawned. */
  excludeTargetId?: string;
}

/** A root that holds nothing: the tree a workspace is born with. */
function newRoot(id: string, axis: NodeAxis): RootNode {
  return { nodeType: 'root', id, parentId: null, position: 0, axis };
}

/** A step that writes exactly what it is given — for the one node no operation mints. */
function staged(write: NodeWrite): Step {
  return () => ({ ok: true, write });
}

/**
 * Take a thread into the workspace.
 *
 * **Idempotent on the target, not on the request.** A workspace that already
 * holds a node for this conversation is already its home: the answer is an
 * empty write, whatever `attach` says and wherever that node currently sits.
 * That is what makes a retried spawn — or a retried claim, or a duplicate
 * delivery — write nothing, without an idempotency memory to consult. Moving an
 * existing member back on screen is {@link readmit}, which is a different
 * question and a different answer.
 *
 * The CAP is checked here, against the tree, and only for a genuine newcomer:
 * a request for a thread the workspace already holds consumed no slot when it
 * arrived and must not be refused by the ceiling it is already inside.
 */
export function admit(nodes: readonly WorkspaceNode[], input: AdmitInput): MembershipResult {
  const { target, newNodeId, newSplitId, newRootId, attach } = input;

  if (memberNode(nodes, target) !== undefined) return NOTHING;

  if (target.kind === 'chat' && chatMembers(nodes).length >= MAX_SESSION_CONVERSATIONS) {
    return refuse(
      'session_full',
      `this workspace already holds ${MAX_SESSION_CONVERSATIONS} conversations`,
    );
  }

  const root = rootOf(nodes);
  if (root === undefined) {
    // The workspace has no tree yet, so this write is both. There is no grid to
    // apply a placement policy to — the newcomer is the first thing in it — so
    // `attach` reduces to "under the root" or "parked", with no split to
    // consider and no pane to give up.
    const axis = input.axis ?? 'row';
    return compile(nodes, [
      staged({ put: [newRoot(newRootId, axis)], drop: [] }),
      (current) =>
        create(current, {
          nodeId: newNodeId,
          target,
          parentId: attach ? newRootId : null,
          index: 0,
        }),
    ]);
  }

  if (!attach) {
    // Parked: in the workspace, off the grid, in the sidebar. `create` mints it
    // there directly — there is deliberately no create-then-detach pair, for
    // the same reason there is no create-then-attach one.
    return create(nodes, { nodeId: newNodeId, target, parentId: null });
  }

  if (target.kind !== 'chat') {
    // `openConversation` is typed to chat because placement is only ever asked
    // for a thread here; a non-chat member arrives parked and is placed by
    // whatever opened it. Unreachable from this module's callers, stated so a
    // future one gets a refusal rather than a mis-typed placement.
    return refuse('invalid_target', `only a conversation is admitted with a placement, not a ${target.kind}`);
  }

  return openConversation(nodes, {
    target: { kind: 'chat', id: target.id },
    newNodeId,
    newSplitId,
    ...(input.axis === undefined ? {} : { axis: input.axis }),
    ...(input.activeNodeId === undefined ? {} : { activeNodeId: input.activeNodeId }),
    // An agent ADDS a surface beside what the user is doing; it never navigates
    // their panes. Only an unbound picker pane may be filled.
    preferSplit: true,
    ...(input.excludeTargetId === undefined ? {} : { excludeTargetId: input.excludeTargetId }),
  });
}

/**
 * Take a thread off the grid, and leave it in the workspace.
 *
 * A `move` to no parent — see the module doc for why this is not a `destroy`.
 * A thread the workspace does not hold is `not_a_member`; one that is already
 * parked writes nothing, so a retried close is observably a no-op rather than
 * an error.
 *
 * There is no never-empty guard, and its absence is a consequence rather than
 * an omission: dismissing changes a node's LOCATION, so it cannot empty a
 * workspace. Closing the last thread on screen leaves an empty grid and a
 * workspace still holding every one of its threads — which is exactly what
 * `closePane` already does to the last pane, now said once instead of twice.
 */
export function dismiss(
  nodes: readonly WorkspaceNode[],
  input: { target: PaneTarget },
): MembershipResult {
  const node = memberNode(nodes, input.target);
  if (node === undefined) {
    return refuse('not_a_member', `no node in this workspace shows ${input.target.kind} "${input.target.id}"`);
  }
  if (node.parentId === null) return NOTHING;

  return compile(nodes, [
    (current) =>
      move(current, {
        nodeId: node.id,
        parentId: null,
        // Leaving the grid is an arrival like any other and it arrives LAST, so
        // the parked order is the order things left. The mover is discounted
        // because `move` measures the destination with it removed.
        index: detachedOf(current).filter((parked) => parked.id !== node.id).length,
      }),
  ]);
}

/**
 * Put a member back on screen.
 *
 * The undo of {@link dismiss}, and a `move` for the same reason: the node never
 * stopped existing, so nothing is minted and no cap is consulted — a member
 * returning to the grid consumes no slot it was not already holding.
 *
 * It lands at the END of the root's own children rather than wherever it was
 * before, and that is deliberate: a node carries its location, not its history,
 * so "where it used to sit" is not a fact this model keeps. Somewhere visible
 * and predictable beats somewhere reconstructed.
 */
export function readmit(
  nodes: readonly WorkspaceNode[],
  input: { target: PaneTarget },
): MembershipResult {
  const node = memberNode(nodes, input.target);
  if (node === undefined) {
    return refuse('not_a_member', `no node in this workspace shows ${input.target.kind} "${input.target.id}"`);
  }
  if (node.parentId !== null) return NOTHING;

  const root = rootOf(nodes);
  if (root === undefined) {
    // A tree holding a parked pane and no root is not a tree this module can
    // repair into one: minting a root here would decide a structure the caller
    // never asked for. `validateTree` calls it `no_root` and so does this.
    return refuse('no_root', 'this workspace has no root to put anything back into');
  }

  return compile(nodes, [
    (current) => move(current, { nodeId: node.id, parentId: root.id, index: childrenOf(current, root.id).length }),
  ]);
}

/**
 * Remove a thread from the workspace ENTIRELY — the one act that is a
 * `destroy`, and the only one.
 *
 * Reserved for history-deletion, where the conversation itself is going away:
 * a node pointing at a thread that no longer exists is a pane that renders
 * nothing and a cap slot nobody can reclaim. Everything a user calls "close"
 * is {@link dismiss}.
 *
 * A thread the workspace does not hold writes nothing rather than refusing —
 * unlike {@link dismiss}, which answers a user's action and owes them the
 * truth. This one runs behind a deletion that has already been authorized, and
 * "it was not there" is the state that deletion asked for.
 */
export function expel(
  nodes: readonly WorkspaceNode[],
  input: {
    target: PaneTarget;
    /**
     * Refuse to take the workspace's LAST conversation — contract invariant 3,
     * "a workspace is never empty", checked where it can still be true.
     *
     * {@link dismiss} needs no such guard because a `move` cannot empty
     * anything; this one can, which is exactly why the guard belongs to this
     * function and not to that one. It is a count over the TREE inside the
     * write's own transaction, where the old version was a `SELECT count(*)`
     * on a second connection racing the delete it guarded.
     */
    requireSurvivor?: boolean;
  },
): MembershipResult {
  const node = memberNode(nodes, input.target);
  if (node === undefined) return NOTHING;
  if (input.requireSurvivor === true && chatMembers(nodes).length <= 1) {
    return refuse(
      'last_member',
      `${input.target.kind} "${input.target.id}" is the only conversation in this workspace`,
    );
  }
  return compile(nodes, [(current) => destroy(current, { nodeId: node.id })]);
}
