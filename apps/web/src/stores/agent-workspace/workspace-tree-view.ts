/**
 * WHAT THE TREE LOOKS LIKE TO A RENDERER — the derivations the sidebar and the
 * pane grid share, as pure functions over a {@link WorkspaceTree}.
 *
 * They live outside React on purpose, and outside the store too. Outside React
 * because every one of them is a decision with edge cases worth testing
 * directly — a thread with no node, a target with no resolved title, an empty
 * grid — and mounting a component to assert one of those is how a rule ends up
 * re-derived slightly differently at the second call site. Outside the store
 * because none of them is state: they are the same list, looked at twice.
 *
 * **The one rule every caller here obeys.** A derivation is `useMemo`'d over the
 * workspace OBJECT the store hands out, never inlined into a zustand selector. A
 * selector that filters returns a fresh array on every call, `Object.is` says it
 * changed, and the subscription loops — which is the bug this file's existence
 * is meant to make hard rather than merely discouraged.
 */

import {
  childrenOf,
  findNode,
  rootOf,
  type PaneNode,
  type PaneTargetKind,
  type WorkspaceNode,
} from '@pagespace/lib/agent-workspaces/workspace-node';
import type { WorkspaceNodeTarget } from '@pagespace/lib/agent-workspaces/workspace-node-wire';
import type { WorkspaceTree } from './useAgentWorkspaceStore';

/** `targets[]` by `kind:id` — the join the nodes deliberately do not carry. */
export function indexTargets(targets: readonly WorkspaceNodeTarget[]): Map<string, WorkspaceNodeTarget> {
  return new Map(targets.map((target) => [`${target.kind}:${target.id}`, target]));
}

export function lookupTarget(
  index: ReadonlyMap<string, WorkspaceNodeTarget>,
  node: PaneNode,
): WorkspaceNodeTarget | undefined {
  return node.target === null ? undefined : index.get(`${node.target.kind}:${node.target.id}`);
}

/**
 * A bound node's display name, with the honest fallback.
 *
 * A target with NO entry in `targets[]` is either gone or one this viewer may
 * not read, and the two are deliberately indistinguishable — so this must never
 * render as an error or as an empty string that collapses the row. The node
 * still exists, still occupies its rectangle, and still has to be closable; it
 * gets the kind's generic name, exactly as an unresolved pane label used to.
 */
export function titleOf(index: ReadonlyMap<string, WorkspaceNodeTarget>, node: PaneNode): string {
  if (node.target === null) return 'New pane';
  const resolved = lookupTarget(index, node);
  if (resolved && resolved.title.trim() !== '') return resolved.title;
  return GENERIC_TITLE[node.target.kind];
}

const GENERIC_TITLE: Record<PaneTargetKind, string> = {
  chat: 'Conversation',
  terminal: 'Shell',
  page: 'Page',
};

/** Every pane in the workspace. Membership is presence, and presence is the tree. */
export function paneNodesOf(nodes: readonly WorkspaceNode[]): PaneNode[] {
  return nodes.filter((node): node is PaneNode => node.nodeType === 'pane');
}

/**
 * The grid's panes in RENDER order — depth first from the root, which is the
 * order a reader's eye takes.
 *
 * Total on cyclic input, like every other walk over this model: a flat parent
 * pointer can express a cycle, and a renderer runs before any write that would
 * have rejected one.
 */
export function gridPanesOf(nodes: readonly WorkspaceNode[]): PaneNode[] {
  const root = rootOf(nodes);
  if (root === undefined) return [];
  const panes: PaneNode[] = [];
  const seen = new Set<string>([root.id]);
  const walk = (parentId: string): void => {
    for (const child of childrenOf(nodes, parentId)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      if (child.nodeType === 'pane') panes.push(child);
      else if (child.nodeType === 'split') walk(child.id);
    }
  };
  walk(root.id);
  return panes;
}

/**
 * The node showing this target, anywhere in the workspace.
 *
 * "Anywhere" is now a statement about DEPTH rather than about a second bucket: a
 * caller that only looked at the root's own children would mint a second node
 * for a conversation the workspace already shows two levels down, which the
 * table refuses outright for chats.
 */
export function nodeShowing(
  nodes: readonly WorkspaceNode[],
  kind: PaneTargetKind,
  id: string,
): PaneNode | undefined {
  return paneNodesOf(nodes).find((node) => node.target?.kind === kind && node.target.id === id);
}

/**
 * Is this node a pane this workspace holds?
 *
 * It used to ask something narrower — "in the grid, as opposed to parked" —
 * because a pane could be one and not the other. It cannot, so the question
 * collapses to presence, and the name is kept because the callers' question did
 * not change: they want to know whether the thing is on screen.
 */
export function isOnGrid(nodes: readonly WorkspaceNode[], nodeId: string): boolean {
  const node = findNode(nodes, nodeId);
  return node !== undefined && node.nodeType === 'pane';
}

// ---------------------------------------------------------------------------
// The pane grid's conversation directory
// ---------------------------------------------------------------------------

/**
 * One conversation the workspace holds, as the grid's pure deciders need it.
 *
 * Structurally identical to `SessionConversationSummary` in
 * `components/agents/panes/workspace-conversations.ts`, and deliberately NOT an
 * import of it: that type describes a row of the `/api/agent-workspaces`
 * LISTING, and this one describes a member of the TREE. They agree because the
 * deciders need the same three facts, not because one is derived from the
 * other — and a store-layer module importing a component-layer type to say so
 * would invert the dependency. Structural assignability is what lets
 * `selectPaneAgent`/`decideClosePane` take either.
 */
export interface WorkspaceConversationMember {
  conversationId: string;
  /** `null` is the Global Assistant — a REAL agent, never "unknown". See below. */
  agentPageId: string | null;
  lastMessageAt: string | null;
}

/**
 * The conversations in one workspace, split by whether their facts have arrived.
 *
 * **Membership and facts come from different halves of the tree, and they have
 * to.** `nodes` is the membership — complete and live, because a structural
 * `session:<id>` broadcast updates it. `targets[]` carries the per-viewer facts
 * (agent, activity) and does NOT ride that broadcast: `applyRemoteUpdate` swaps
 * `base` and carries the previous targets forward, since a room event cannot be
 * redacted per viewer. So a conversation another member just placed is a member
 * here IMMEDIATELY, with no facts, until the next authorized read.
 *
 * Deriving both from `targets` would hide such a member from the switch
 * decision, which would then read "no thread for this agent" and mint a
 * duplicate.
 */
export interface WorkspaceConversationDirectory {
  /** Every conversation the tree holds. The membership question's whole answer. */
  memberConversationIds: Set<string>;
  /** Members whose `targets[]` entry has arrived — the only safe input to an agent-keyed decision. */
  resolved: WorkspaceConversationMember[];
  /** A member exists whose facts have not arrived. Callers must not decide against a partial list. */
  hasUnresolved: boolean;
}

/**
 * THE PANE GRID'S CONVERSATION DIRECTORY, from the tree the grid already holds.
 *
 * This replaced a second read of `GET /api/agent-workspaces`, whose every filter
 * carries `ownerId` — so a workspace owned by ANOTHER drive member (a legitimate
 * shared working context: `decideAgentSessionAccess` grants by drive membership)
 * was never in it, and the grid concluded it knew nothing about a workspace it
 * was rendering. The tree comes from the membership-gated nodes route, which is
 * the same gate the grid passed to exist at all.
 *
 * `null` means NOT RESOLVED YET — never "empty". The distinction is the whole
 * reason this returns a nullable: a close acting on an unverified listing would
 * destroy a node while leaving its thread open server-side, and
 * `decideClosePane` refuses to act until it has a real answer.
 *
 * A merely-LOCAL tree is not an answer either, which is what `hasServerSnapshot`
 * settles: `runCommand` seeds a root client-side at rev 0, so nodes can exist
 * having never been read.
 */
export function conversationDirectoryOf(
  tree: WorkspaceTree | undefined,
): WorkspaceConversationDirectory | null {
  if (tree === undefined || !tree.hasServerSnapshot) return null;

  const index = indexTargets(tree.targets);
  const memberConversationIds = new Set<string>();
  const resolved: WorkspaceConversationMember[] = [];
  let hasUnresolved = false;

  for (const node of paneNodesOf(tree.nodes)) {
    if (node.target === null || node.target.kind !== 'chat') continue;
    const conversationId = node.target.id;
    // `agent_workspace_nodes_chat_target_idx` makes one node per chat a global
    // invariant, so this can only fire on a local tree that has not been through
    // a write yet. Dedupe anyway: the deciders count matches, and a doubled row
    // would make one thread look like two.
    if (memberConversationIds.has(conversationId)) continue;

    memberConversationIds.add(conversationId);

    const target = lookupTarget(index, node);
    if (target === undefined) {
      // NOT pushed with a null agent. `null` means the Global Assistant, so a
      // placeholder would make `findOpenForAgent(list, null)` focus a thread
      // whose agent nobody knows — absence is the only honest encoding.
      hasUnresolved = true;
      continue;
    }
    resolved.push({
      conversationId,
      agentPageId: target.agentPageId,
      lastMessageAt: target.lastMessageAt,
    });
  }

  return { memberConversationIds, resolved, hasUnresolved };
}

// ---------------------------------------------------------------------------
// The sidebar's rows
// ---------------------------------------------------------------------------

/**
 * Where a member sits, as the sidebar needs to say it.
 *
 * TWO CASES, and the missing third is the point. `'parked'` — a node in the
 * workspace with no parent, in the sidebar and off the screen — is gone with the
 * state it named. A member is in the tree or it is not a member, so the only
 * question left is whether this workspace holds a node for the thing at all.
 */
export type MemberPlacement =
  /** A node in this workspace's tree. Closing the row destroys that node. */
  | 'grid'
  /** No node at all — this workspace does not hold it. */
  | 'unplaced';

/** One row under an expanded workspace. */
export interface WorkspaceMemberRow {
  /** Stable across a re-render, so a row does not remount when its tree changes. */
  key: string;
  kind: PaneTargetKind;
  /** The conversation / shell / page this row is about. */
  targetId: string;
  title: string;
  placement: MemberPlacement;
  /** The node showing it, when there is one. */
  nodeId: string | null;
}

/**
 * THE SIDEBAR'S ONE LIST for a workspace's own artifacts — every page the tree
 * holds.
 *
 * **#2373 cannot recur under this model, and that is why there is no second list
 * here.** The sidebar used to choose between the grid and the thread list, the
 * grid always won because an open workspace always had one, and a thread with no
 * pane row was invisible — in production, one workspace showed 2 of its 3 threads
 * and another 4 of its 10. The node-tree cutover removed the choice and then
 * handed the same trap back in a new shape: a renderer walking from the root saw
 * only what was on screen, and a PARKED node was precisely a member that was
 * not — so this function had to concatenate a second list to stay honest. There
 * are no unplaced members now, so walking the tree IS enumerating the members,
 * and there is nothing a caller can forget.
 *
 * Conversations are deliberately NOT here: they are the conversation listing's
 * rows, and `conversationPlacement` is what annotates one with this tree.
 */
export function artifactRowsOf(tree: WorkspaceTree): WorkspaceMemberRow[] {
  const index = indexTargets(tree.targets);
  const ordered = gridPanesOf(tree.nodes);
  const rows: WorkspaceMemberRow[] = [];
  const seen = new Set<string>();
  for (const node of ordered) {
    // Chats are the conversation listing's rows, not the tree's — see the doc
    // above. Terminals get one row per SHELL from the workspace's own shell
    // list, which covers a shell with no pane; listing them here too would
    // double them.
    if (node.target === null || node.target.kind !== 'page') continue;
    const key = `${node.target.kind}:${node.target.id}`;
    // One conversation renders in at most one node, but a PAGE may legitimately
    // be open in two — the sidebar lists the page once, and the first (grid
    // order) node is the one its actions address.
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      key,
      kind: node.target.kind,
      targetId: node.target.id,
      title: titleOf(index, node),
      placement: 'grid',
      nodeId: node.id,
    });
  }
  return rows;
}

/**
 * Where a conversation sits in this tree — the annotation the sidebar puts on a
 * thread row.
 *
 * Read from the LIVE tree, which is the whole point of item 4's last bullet: the
 * row's menu and the row's close action used to read two different things (a
 * server annotation up to 120 seconds old, and the store), so they could
 * disagree about whether "Close" meant "park the pane" or "close the thread".
 * One read, one answer.
 */
export function conversationPlacement(
  tree: WorkspaceTree | undefined,
  conversationId: string,
): { placement: MemberPlacement; nodeId: string | null } {
  if (tree === undefined) return { placement: 'unplaced', nodeId: null };
  const node = nodeShowing(tree.nodes, 'chat', conversationId);
  if (node === undefined) return { placement: 'unplaced', nodeId: null };
  // A node that exists is on the grid. The third answer this used to give —
  // `'parked'`, for a node with no parent — described a state the model no
  // longer has.
  return { placement: 'grid', nodeId: node.id };
}
