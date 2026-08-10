/**
 * Where a click on a past-conversation row should go, computed as a pure
 * function of the row's own fields — no I/O, nothing async, fully
 * deterministic and unit-testable with a plain object. The exhaustive
 * `switch` (with a `never` check) means a future `conversations.type` value
 * fails to COMPILE here rather than silently falling through to the wrong
 * branch, which is what a bare `if/else if/else` chain would do.
 */

import type { PastConversationDTO } from '@/lib/agent-workspaces/past-conversation-dto';

/**
 * Exactly the fields of a wire row this decision reads — PICKED from the
 * shared DTO, never re-declared. The predecessor of this type was a private,
 * hand-written interface saying `sessionId` where the server has always said
 * `workspaceId`; it compiled forever and made `row.sessionId` `undefined` on
 * every real row, so the `pane` branch below could never fire (see
 * `past-conversation-dto.ts` for the full account). `Pick` is what stops that
 * happening again: rename a field on the DTO and this line is a compile
 * error, not a silent `undefined`.
 */
export type PastConversationRow = Pick<
  PastConversationDTO,
  'conversationId' | 'type' | 'agentPageId' | 'workspaceId' | 'driveId'
>;

/** Where a `claimable` row's click routes if the claim-into-a-session attempt fails. */
export type ClaimableFallback =
  // No session/workspace id here on purpose: a fallback is only ever reached
  // for a row that HAS no workspace. The field this used to carry was
  // unconditionally null and read by nothing — dead weight that, after the
  // `workspaceId` rename, read as though a fallback could name a workspace.
  | { kind: 'page'; driveId: string; pageId: string; conversationId: string }
  | { kind: 'global'; conversationId: string; driveId: string | null }
  | { kind: 'unavailable' };

export type NavigationTarget =
  /**
   * `sessionId` here is the CLIENT's vocabulary — the field
   * `useAgentSurfaceStore.selectConversation` takes and the name the URL uses
   * — for the id the wire calls `workspaceId`. This is the one place the two
   * names meet, and it is a deliberate translation rather than a shape the
   * server ever sends.
   */
  | { kind: 'pane'; sessionId: string; conversationId: string; agentId: string | null }
  /**
   * A workspace-less `type: 'page'` or `type: 'global'` row — clicking it
   * should spawn a session and claim this SAME conversation into it (see
   * `claim-conversation-in-workspace.ts`), landing it in the pane grid with a
   * real sandbox, rather than opening it read-only outside any session.
   * `fallback` carries exactly what this row would have resolved to before
   * claiming existed — the old `page`/`global` target — so a failed claim
   * (quota, a permission edge) degrades to today's exact behavior instead of
   * a dead end. A claim refused because the conversation ALREADY has a
   * workspace is NOT one of those cases — that refusal names the workspace
   * and the caller opens it (`claimConflictWorkspaceId`).
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
 * A workspace-bound conversation always wins, whatever its `type` — it opens
 * in the pane grid in-place, the one case that never leaves the Agents
 * surface. That is also the rule the past-conversations list exists to serve:
 * a history row clicked ON the Agents surface belongs on the Agents surface.
 *
 * EXCEPT a `type: 'page'` row whose `driveId` came back null: the API masks
 * `driveId` to null (route.ts) ONLY when it already checked and the
 * requester can no longer view that page — a real, live page always belongs
 * to a drive, so this can never be a legitimate "no drive" value. Checking
 * it before the `workspaceId` branch matters because a bound page
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

  if (row.workspaceId) {
    return { kind: 'pane', sessionId: row.workspaceId, conversationId: row.conversationId, agentId: row.agentPageId };
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
        },
      };
    }
    // API-managed (POST /api/v1/conversations) — never bound to a workspace
    // (confirmed: nothing ever binds a `client` row to one) and has no in-app
    // chat surface to open into, and no session claim can grant it one either
    // (claim refuses `type: 'client'` — see `claim-conversation-in-workspace.ts`).
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
