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
 * **THE TWO ACTS, and what each is in the algebra:**
 *
 *  - {@link admit} — a `create`. The node IS the membership, so this is the
 *                    only thing that makes a thread a member.
 *  - {@link expel} — a `destroy`. The node goes, so the membership goes.
 *
 * **There were four, and the correction is why there are two.** `dismiss` was a
 * `move` to no parent — "the thread leaves the GRID and stays a member" — and
 * `readmit` was the `move` back. Both existed only because a node could be
 * parked, and a parked node is precisely the state that makes a pane a user
 * closed indistinguishable from a pane that lost its parent to a defect. With
 * one place for a node to be, "off the grid but still a member" is not a state,
 * so the two moves have nothing to describe and closing a thread out of a
 * workspace IS removing it from the workspace.
 *
 * **What that costs, stated rather than hidden.** The old `dismiss` argument
 * had a real point in it: the table's global
 * `UNIQUE (targetId) WHERE targetKind = 'chat'` makes a binding write-once, and
 * a `destroy` FREES that index — so a thread closed out of one workspace can
 * afterwards be admitted into another. Under the parked model that was called a
 * "rebind reached by clicking close" and refused. It is now the honest reading:
 * a thread whose node is gone is a member of no workspace, and admitting a
 * member-of-nothing somewhere is an ordinary admission, not a rebind of a live
 * membership. The thread's HISTORY is untouched either way — `conversations` is
 * not what this writes. What is genuinely given up is the guarantee that a
 * thread's workspace is permanent for the life of the thread; what is bought is
 * that "in this workspace" has exactly one meaning and exactly one witness.
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
import { create, destroy, type NodeWrite } from './workspace-node-algebra';
import {
  rootOf,
  type NodeAxis,
  type PaneNode,
  type PaneTarget,
  type RootNode,
  type WorkspaceNode,
} from './workspace-node';
import {
  compile,
  openConversation,
  openPage,
  openShell,
  type CommandCode,
  type CommandResult,
  type Step,
} from './workspace-node-commands';

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
 *
 * **`last_member` is gone**, and it is worth saying why rather than leaving a
 * reader to notice. It refused the removal of a workspace's LAST conversation,
 * enforcing "a workspace is never empty" — an invariant that only had teeth
 * while emptiness meant something. It meant something because a two-level grid
 * could not represent zero panes and because "the last one closed" was the
 * inference that ended a session. Neither is true: an empty tree is an ordinary
 * resting state, and a session ends when someone destroys its root. A refusal
 * defending a state nobody can reach is a refusal that only ever fires on
 * legitimate work.
 *
 * `session_full` stays, and the difference is the direction. It is a CEILING on
 * what a workspace holds, not a floor under it, so nothing about emptiness
 * ceasing to mean anything touches it.
 */
export type MembershipCode = CommandCode | 'session_full' | 'not_a_member';

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
 * Every conversation this workspace holds.
 *
 * This is the workspace's thread listing, and it is the SAME list the grid is
 * drawn from — which is the entire point. `annotate-conversation-panes.ts`
 * existed to reconcile a listing with a grid; there is nothing to reconcile
 * once one row answers both, and nothing to qualify with "on screen or parked"
 * once there is one place to be.
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
  /** The split's direction when the placement comes to that. */
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
 * Run the placement policy for whichever kind is arriving.
 *
 * The three `open*` commands are one function with a fixed `kind` (see
 * `workspace-node-commands.ts`), and this dispatch exists only to hand each of
 * them a target it is typed for. It replaces a refusal: `admit` used to accept a
 * placement for CHAT alone and answer `invalid_target` for anything else,
 * because every other kind arrived parked and was placed by whoever opened it.
 * Nothing arrives parked, so every kind needs a place, and the policy already
 * served all three.
 */
function place(
  nodes: readonly WorkspaceNode[],
  target: PaneTarget,
  input: AdmitInput,
): CommandResult {
  const shared = {
    newNodeId: input.newNodeId,
    newSplitId: input.newSplitId,
    ...(input.axis === undefined ? {} : { axis: input.axis }),
    ...(input.activeNodeId === undefined ? {} : { activeNodeId: input.activeNodeId }),
    // The admitting caller ADDS a surface; it never navigates the user's panes.
    // Only an unbound pane may be filled — which is also what makes the picker
    // path land in the very pane the user is looking at, rather than minting a
    // second one beside it.
    preferSplit: true,
    ...(input.excludeTargetId === undefined ? {} : { excludeTargetId: input.excludeTargetId }),
  };
  switch (target.kind) {
    case 'chat':
      return openConversation(nodes, { ...shared, target: { kind: 'chat', id: target.id } });
    case 'terminal':
      return openShell(nodes, { ...shared, target: { kind: 'terminal', id: target.id } });
    case 'page':
      return openPage(nodes, { ...shared, target: { kind: 'page', id: target.id } });
  }
}

/**
 * Take a thread into the workspace, AND ONTO THE SCREEN, because those are the
 * same act.
 *
 * There is no `attach` flag any more. It chose between a placed node and a
 * parked one, and a parked node is the state this correction deletes — so the
 * choice it offered was between membership and a membership nothing could
 * render. Every admission places.
 *
 * **Idempotent on the target, not on the request.** A workspace that already
 * holds a node for this conversation is already its home: the answer is an
 * empty write, wherever that node sits. That is what makes a retried spawn — or
 * a retried claim, or a duplicate delivery — write nothing, without an
 * idempotency memory to consult.
 *
 * The CAP is checked here, against the tree, and only for a genuine newcomer:
 * a request for a thread the workspace already holds consumed no slot when it
 * arrived and must not be refused by the ceiling it is already inside.
 */
export function admit(nodes: readonly WorkspaceNode[], input: AdmitInput): MembershipResult {
  const { target, newNodeId, newRootId } = input;

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
    // it goes straight under the root this same write mints.
    const axis = input.axis ?? 'row';
    return compile(nodes, [
      staged({ put: [newRoot(newRootId, axis)], drop: [] }),
      (current) => create(current, { nodeId: newNodeId, target, parentId: newRootId, index: 0 }),
    ]);
  }

  return place(nodes, target, input);
}

/**
 * Remove a thread from the workspace — the removal, addressed by TARGET instead
 * of by node id.
 *
 * A `destroy`, and the ONLY removal this layer has. `dismiss` used to sit beside
 * it as a `move` to no parent, so that closing a thread took it off the grid
 * while leaving it a member; that distinction required a place for a member to
 * be that was not the tree, and there is none. Closing a thread out of a
 * workspace and removing it from the workspace are one act, which is why they
 * are one function.
 *
 * **A thread the workspace does not hold is `not_a_member` and writes nothing.**
 * The answer is a refusal rather than a silent success because the caller that
 * asks on a user's behalf is owed the truth; the caller that asks behind an
 * authorized history-deletion treats `not_a_member` as the state it wanted, and
 * says so at its own call site rather than by having a second function here.
 *
 * **There is no survivor guard.** `requireSurvivor` refused to take a
 * workspace's last conversation, upholding "a workspace is never empty" — see
 * {@link MembershipCode} for why that invariant no longer defends anything. A
 * workspace holding no conversations is a workspace holding no conversations;
 * ending it is `destroy(root)`, which someone has to ask for.
 */
export function expel(
  nodes: readonly WorkspaceNode[],
  input: { target: PaneTarget },
): MembershipResult {
  const node = memberNode(nodes, input.target);
  if (node === undefined) {
    return refuse('not_a_member', `no node in this workspace shows ${input.target.kind} "${input.target.id}"`);
  }
  return compile(nodes, [(current) => destroy(current, { nodeId: node.id })]);
}
