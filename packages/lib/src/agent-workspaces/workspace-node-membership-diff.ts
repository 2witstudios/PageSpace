/**
 * WHICH CHAT THREADS A WRITE TOOK OUT OF A WORKSPACE — the mirror of
 * `introducedPaneTargets`, and the other half of the same question.
 *
 * That function asks what a write BRINGS IN, because bringing a target in is
 * what needs authorizing. This asks what a write TAKES OUT, because taking a
 * chat target out is the one structural change the directory plane has to hear
 * about: membership IS the node, so a chat node leaving the tree is the thread
 * leaving the workspace, and the sidebar's rows come from the LISTING rather
 * than from the tree (`AgentsSidebar`'s `conversationRows` is "keyed by the
 * listing and never by the tree"). The node write's own
 * `workspace:nodes-updated` carries the tree and therefore cannot, even in
 * principle, take a row out of the listing cache.
 *
 * **Set difference against the FINAL tree, never against the write's `drop`.**
 * A `drop` is not a removal — a hand-off moves a target from one node to
 * another by dropping the first and putting the second in the same write, and
 * announcing a close for that would tell every subscriber the thread had left a
 * workspace it never left. The only honest question is whether the target is
 * still held by SOME pane once the write has landed, which is a property of the
 * two trees and of nothing else.
 *
 * Chat only, and for the same reason the binding index is: a page shown in two
 * panes is ordinary, and a terminal's lifecycle is the shell route's. Only a
 * chat target's presence in a tree means membership.
 *
 * Pure, over plain node lists — so the funnel that calls it can be tested
 * without a database and this rule cannot acquire a second copy inside one.
 */

import type { WorkspaceNode } from './workspace-node';

/** Every chat target held by a pane in `nodes`. */
function chatTargetsHeldBy(nodes: readonly WorkspaceNode[]): Set<string> {
  const held = new Set<string>();
  for (const node of nodes) {
    if (node.nodeType !== 'pane') continue;
    if (node.target === null || node.target.kind !== 'chat') continue;
    held.add(node.target.id);
  }
  return held;
}

/**
 * The chat targets held by a pane in `before` and by NO pane in `after`.
 *
 * Order follows `before`, and duplicates cannot occur — the source is a set.
 * The table's `UNIQUE (targetId) WHERE targetKind = 'chat'` makes "held by a
 * pane" and "held by exactly one pane" the same fact, so nothing here has to
 * count.
 */
export function removedChatTargets(
  before: readonly WorkspaceNode[],
  after: readonly WorkspaceNode[],
): string[] {
  const held = chatTargetsHeldBy(after);
  return [...chatTargetsHeldBy(before)].filter((targetId) => !held.has(targetId));
}
