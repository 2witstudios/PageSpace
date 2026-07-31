/**
 * Where a click on a past-conversation row should go, computed as a pure
 * function of the row's own fields — no I/O, nothing async, fully
 * deterministic and unit-testable with a plain object. The exhaustive
 * `switch` (with a `never` check) means a future `conversations.type` value
 * fails to COMPILE here rather than silently falling through to the wrong
 * branch, which is what a bare `if/else if/else` chain would do.
 */

/** Mirrors `conversations.type` (`packages/db/src/schema/conversations.ts`) — the only values ever written. */
export type ConversationKind = 'global' | 'page' | 'drive';

export interface PastConversationRow {
  conversationId: string;
  type: ConversationKind;
  agentPageId: string | null;
  sessionId: string | null;
  driveId: string | null;
}

export type NavigationTarget =
  | { kind: 'pane'; sessionId: string; conversationId: string; agentId: string | null }
  | { kind: 'page'; driveId: string; pageId: string; conversationId: string; sessionId: string | null }
  | { kind: 'drive'; driveId: string }
  | { kind: 'global'; conversationId: string; driveId: string | null };

/**
 * A session-bound conversation always wins, whatever its `type` — it opens in
 * the pane grid in-place, the one case that never leaves the Agents surface.
 */
export function resolveNavigationTarget(
  row: PastConversationRow,
  currentDriveId: string | undefined,
): NavigationTarget {
  if (row.sessionId) {
    return { kind: 'pane', sessionId: row.sessionId, conversationId: row.conversationId, agentId: row.agentPageId };
  }

  switch (row.type) {
    case 'page': {
      if (!row.agentPageId || !row.driveId) {
        // A page conversation with no resolvable page/drive is unreachable —
        // the safest place to land is wherever the global assistant lives.
        return { kind: 'global', conversationId: row.conversationId, driveId: currentDriveId ?? null };
      }
      return {
        kind: 'page',
        driveId: row.driveId,
        pageId: row.agentPageId,
        conversationId: row.conversationId,
        sessionId: null,
      };
    }
    case 'drive': {
      if (!row.driveId) {
        return { kind: 'global', conversationId: row.conversationId, driveId: currentDriveId ?? null };
      }
      return { kind: 'drive', driveId: row.driveId };
    }
    case 'global':
      return { kind: 'global', conversationId: row.conversationId, driveId: currentDriveId ?? null };
    default: {
      // Exhaustiveness guard: adding a new `ConversationKind` value fails to
      // compile here instead of silently misrouting through this switch.
      const _exhaustive: never = row.type;
      return _exhaustive;
    }
  }
}
