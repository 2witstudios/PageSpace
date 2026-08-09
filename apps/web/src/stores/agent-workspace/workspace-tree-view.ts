/**
 * WHAT THE TREE LOOKS LIKE TO A RENDERER — the derivations the sidebar and the
 * pane grid share, as pure functions over a {@link WorkspaceTree}.
 *
 * They live outside React on purpose, and outside the store too. Outside React
 * because every one of them is a decision with edge cases worth testing
 * directly — a detached node, a target with no resolved title, an empty grid —
 * and mounting a component to assert one of those is how a rule ends up
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
  detachedOf,
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

/** Every pane in the workspace — attached AND detached. Membership is presence. */
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
 * The node showing this target, anywhere in the workspace — IN THE GRID OR
 * PARKED.
 *
 * Parked counts, and that is the point: a parked node is off the grid and still
 * a member, still holding its binding. A caller that only looked at the grid
 * would mint a second node for a conversation the workspace already shows,
 * which the table refuses outright for chats.
 */
export function nodeShowing(
  nodes: readonly WorkspaceNode[],
  kind: PaneTargetKind,
  id: string,
): PaneNode | undefined {
  return paneNodesOf(nodes).find((node) => node.target?.kind === kind && node.target.id === id);
}

/** Is this node in the grid (as opposed to parked, or absent)? */
export function isOnGrid(nodes: readonly WorkspaceNode[], nodeId: string): boolean {
  const node = findNode(nodes, nodeId);
  return node !== undefined && node.nodeType === 'pane' && node.parentId !== null;
}

// ---------------------------------------------------------------------------
// The sidebar's rows
// ---------------------------------------------------------------------------

/** Where a member sits, as the sidebar needs to say it. */
export type MemberPlacement =
  /** A node in the grid. Closing the row parks that node. */
  | 'grid'
  /** A node in the workspace with no parent — in the sidebar, off the screen. */
  | 'parked'
  /** No node at all. In the workspace by its own row, never placed. */
  | 'unplaced';

/** One row under an expanded workspace. */
export interface WorkspaceMemberRow {
  /** Stable across a placement change, so a row does not remount when it is parked. */
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
 * THE SIDEBAR'S ONE LIST for a workspace's own artifacts — every page and every
 * shell the tree holds, ATTACHED AND DETACHED ALIKE.
 *
 * **Detached rows are the #2373 guard, restated in the model that replaced it.**
 * The sidebar used to choose between the grid and the thread list, the grid
 * always won because an open workspace always had one, and a thread with no pane
 * row was invisible — in production, one workspace showed 2 of its 3 threads and
 * another 4 of its 10. The flat model removes the choice, but it hands back the
 * same trap in a new shape: a renderer that walks from the root sees only what
 * is on screen, and a parked node is precisely a member that is not. Rendering
 * only the attached tree would reintroduce the bug with a better excuse.
 *
 * Conversations are deliberately NOT here. A thread is a member of a workspace by
 * its own row — `conversations.workspaceId`, which is what "created but never
 * placed" means — so the listing is its membership source and this tree only says
 * where it sits. `conversationPlacement` is that half.
 */
export function artifactRowsOf(tree: WorkspaceTree): WorkspaceMemberRow[] {
  const index = indexTargets(tree.targets);
  const ordered = [...gridPanesOf(tree.nodes), ...detachedOf(tree.nodes)];
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
      placement: node.parentId === null ? 'parked' : 'grid',
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
  return { placement: node.parentId === null ? 'parked' : 'grid', nodeId: node.id };
}
