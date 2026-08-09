/**
 * ONE ANSWER TO "WHAT IS IN THIS WORKSPACE" (issue #2373).
 *
 * `/api/agent-workspaces` used to return two collections per workspace — the
 * flat conversation list AND the pane grid — and leave the client to choose.
 * `AgentsSidebar` chose the grid (`chatPanes ?? session.conversations`), and an
 * open workspace always HAS a grid, so the pane branch always won. A thread
 * whose pane row did not exist was therefore invisible, however correct its
 * conversation row.
 *
 * That is not an edge case. This PR closes the worst source of it (placement
 * used to be skipped entirely whenever the SDK handed `spawn_session` no
 * `toolCallId`), but "created but not placed" remains a legitimate resting
 * state, not a failure: placement is best-effort by design, and a thread
 * created without `placeInGrid` is never placed at all. Measured in
 * production at the time of the bug: one workspace had 3 threads and 2 panes,
 * another had 10 threads and 4 panes. Six of that second workspace's threads
 * could not be seen or reached from the sidebar at all.
 *
 * So the grid stops being a second list and becomes an ANNOTATION on the one
 * list. Every thread appears; a placed one additionally knows where it sits.
 *
 * Pure and total: no IO, no clock, no throw. The grid is untrusted input from
 * a row read — a pane may name a conversation that is not in this workspace's
 * listing (a cross-workspace target the label resolver gates separately), and
 * that pane simply annotates nothing.
 *
 * The annotation runs list-to-grid and never the reverse, which is a decision,
 * not an oversight. The listing is capped at `MAX_SESSION_CONVERSATIONS` (100
 * by `lastMessageAt`), so a pane whose thread ranks past that cap gets no
 * sidebar row, where the deleted `PaneRow` path would have synthesised one. We
 * accept that: the sidebar lists a workspace's THREADS, and inventing a row out
 * of a pane is precisely the second source of truth this module exists to
 * remove. The pane itself still renders in the grid, which reads the store's
 * geometry rather than this listing, so the thread stays visible and closable
 * where it is actually open. Trading a >100-thread edge for the ordinary
 * freshly-spawned-worker case measured above is the right side of that bet.
 */

import type { PersistedColumnState } from '@pagespace/lib/agent-workspaces/contract';

/** A thread's placement in its workspace's grid. */
export interface ConversationPanePlacement {
  paneId: string;
  columnId: string;
  /** Position within the column — grid order without re-reading the grid. */
  orderIndex: number;
}

/** The subset of a listing entry this function reads and writes. */
interface PlaceableConversation {
  conversationId: string;
}

/**
 * Index a grid by the conversation each `chat` pane addresses.
 *
 * Only `chat` panes name a conversation — a terminal, a page pane or a
 * still-unbound pane addresses something else or nothing, and must not shadow
 * a thread. FIRST placement wins: a conversation open in two panes of one grid
 * is legal, and the sidebar shows one row for the thread rather than two.
 */
function paneByConversationId(
  grid: readonly PersistedColumnState[] | null | undefined,
): Map<string, ConversationPanePlacement> {
  const byConversation = new Map<string, ConversationPanePlacement>();
  if (!grid) return byConversation;

  for (const column of grid) {
    column.panes.forEach((pane, orderIndex) => {
      const scope = pane.scope;
      if (!scope || scope.kind !== 'chat' || !scope.targetId) return;
      if (byConversation.has(scope.targetId)) return;
      byConversation.set(scope.targetId, {
        paneId: pane.id,
        columnId: column.id,
        orderIndex,
      });
    });
  }
  return byConversation;
}

/**
 * Annotate a workspace's threads with their pane placement, preserving the
 * caller's ordering.
 *
 * Order is deliberately NOT re-derived from the grid. The listing arrives
 * newest-activity-first (`listSessionConversationsBulk`'s `ROW_NUMBER() OVER
 * (... ORDER BY lastMessageAt DESC)`), which is the order a sidebar reader
 * wants; grid position is geometry for the pane surface, and sorting the
 * sidebar by it would make a thread jump when someone rearranged panes.
 * Callers that want grid order have `pane.columnId` / `pane.orderIndex`.
 */
export function annotateConversationsWithPanes<T extends PlaceableConversation>(
  conversations: readonly T[],
  grid: readonly PersistedColumnState[] | null | undefined,
): (T & { pane: ConversationPanePlacement | null })[] {
  const byConversation = paneByConversationId(grid);
  return conversations.map((conversation) => ({
    ...conversation,
    pane: byConversation.get(conversation.conversationId) ?? null,
  }));
}
