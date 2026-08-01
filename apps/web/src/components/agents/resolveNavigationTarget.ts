/**
 * Where a click on a past-conversation row should go, computed as a pure
 * function of the row's own fields — no I/O, nothing async, fully
 * deterministic and unit-testable with a plain object. The exhaustive
 * `switch` (with a `never` check) means a future `conversations.type` value
 * fails to COMPILE here rather than silently falling through to the wrong
 * branch, which is what a bare `if/else if/else` chain would do.
 */

/**
 * Mirrors `conversations.type` (`packages/db/src/schema/conversations.ts`) —
 * the only values any production code path writes. `'client'` is the rare
 * API-managed conversation created via `POST /api/v1/conversations` (never
 * `'drive'` — that value was never actually written by any code path; it was
 * a documentation mistake corrected once this got fixed).
 */
export type ConversationKind = 'global' | 'page' | 'client';

export interface PastConversationRow {
  conversationId: string;
  type: ConversationKind;
  agentPageId: string | null;
  sessionId: string | null;
  driveId: string | null;
}

/** Where a `claimable` row's click routes if the claim-into-a-session attempt fails. */
export type ClaimableFallback =
  | { kind: 'page'; driveId: string; pageId: string; conversationId: string; sessionId: string | null }
  | { kind: 'global'; conversationId: string; driveId: string | null }
  | { kind: 'unavailable' };

export type NavigationTarget =
  | { kind: 'pane'; sessionId: string; conversationId: string; agentId: string | null }
  | { kind: 'page'; driveId: string; pageId: string; conversationId: string; sessionId: string | null }
  | { kind: 'global'; conversationId: string; driveId: string | null }
  /**
   * A session-less `type: 'page'` or `type: 'global'` row — clicking it
   * should spawn a session and claim this SAME conversation into it (see
   * `claim-conversation-in-session.ts`), landing it in the pane grid with a
   * real sandbox, rather than opening it read-only outside any session.
   * `fallback` carries exactly what this row would have resolved to before
   * claiming existed — the old `page`/`global` target — so a failed claim
   * (quota, a race, a permission edge) degrades to today's exact behavior
   * instead of a dead end.
   */
  | { kind: 'claimable'; conversationId: string; agentPageId: string | null; driveId: string | null; fallback: ClaimableFallback }
  /**
   * No surface in the app can open this row today. NOT the same as an
   * error — the row still belongs in "every conversation you own", it just
   * has nowhere to click through to yet. Two real cases: a `type: 'page'`
   * row missing its resolvable agent/drive, and a `type: 'client'`
   * (API-managed) conversation, which has no dedicated in-app viewer.
   * Deliberately NOT routed into the global assistant as a fallback — its
   * loader reads the `messages` table, which a `chat_messages`-backed
   * conversation (page/client) can never populate, so that fallback silently
   * opened a blank thread that could never actually show the real history
   * (review finding).
   */
  | { kind: 'unavailable' };

/**
 * A session-bound conversation always wins, whatever its `type` — it opens in
 * the pane grid in-place, the one case that never leaves the Agents surface.
 *
 * EXCEPT a `type: 'page'` row whose `driveId` came back null: the API masks
 * `driveId` to null (route.ts) ONLY when it already checked and the
 * requester can no longer view that page — a real, live page always belongs
 * to a drive, so this can never be a legitimate "no drive" value. Checking
 * it before the `sessionId` branch matters because a session-bound page
 * conversation would otherwise open `AgentPanes` unconditionally; the pane's
 * message fetch enforces the same permission server-side and 403s, so the
 * click would silently fail to show anything (review finding).
 */
export function resolveNavigationTarget(
  row: PastConversationRow,
  currentDriveId: string | undefined,
): NavigationTarget {
  if (row.type === 'page' && !row.driveId) {
    return { kind: 'unavailable' };
  }

  if (row.sessionId) {
    return { kind: 'pane', sessionId: row.sessionId, conversationId: row.conversationId, agentId: row.agentPageId };
  }

  switch (row.type) {
    case 'page': {
      if (!row.agentPageId || !row.driveId) return { kind: 'unavailable' };
      return {
        kind: 'claimable',
        conversationId: row.conversationId,
        agentPageId: row.agentPageId,
        driveId: row.driveId,
        fallback: {
          kind: 'page',
          driveId: row.driveId,
          pageId: row.agentPageId,
          conversationId: row.conversationId,
          sessionId: null,
        },
      };
    }
    // API-managed (POST /api/v1/conversations) — always session-less (confirmed:
    // nothing ever binds a `client` row to a session) and has no in-app chat
    // surface to open into, and no session claim can grant it one either
    // (claim refuses `type: 'client'` — see `claim-conversation-in-session.ts`).
    case 'client':
      return { kind: 'unavailable' };
    case 'global':
      return {
        kind: 'claimable',
        conversationId: row.conversationId,
        agentPageId: null,
        driveId: currentDriveId ?? null,
        fallback: { kind: 'global', conversationId: row.conversationId, driveId: currentDriveId ?? null },
      };
    default: {
      // Exhaustiveness guard: adding a new `ConversationKind` value fails to
      // compile here instead of silently misrouting through this switch.
      const _exhaustive: never = row.type;
      return _exhaustive;
    }
  }
}
