/**
 * WHO MAY ACCESS AN AI CONVERSATION — the one predicate behind every
 * conversation-scoped subscription surface (Agent-Session Single Source of
 * Truth epic, Phase 2; spec docs/2.0-architecture/agent-sessions.md §3).
 *
 * The rule, in one line: **owner OR (isShared AND page access)**.
 *
 * Page access alone is NOT the right question: a page channel carries every
 * conversation on that page, and conversations are PRIVATE by default — so
 * authorizing on "can this user view the page" would hand one member's
 * private conversation to every other member. The conversation's own facts
 * decide:
 *   - the owner always has access, from any device;
 *   - a non-owner has access only when the conversation is explicitly shared
 *     AND it is a page conversation whose page the user can view. A shared
 *     GLOBAL conversation has no page to share through, so a non-owner never
 *     has access to it (matching decide-session-access.ts: a null-drive
 *     session is owner-only by construction).
 *
 * Fails closed: a conversation with no row is not shared, so callers must
 * treat "no row" as owner-unknown and deny non-owners.
 *
 * Enforced at three points, all through this module so they cannot drift:
 *   1. the realtime `join_conversation` handler (apps/realtime/src/index.ts),
 *   2. `POST /api/ai/chat/stream-join/[messageId]`,
 *   3. `GET /api/ai/chat/active-streams`,
 * (2 and 3 via apps/web/src/lib/ai/core/stream-subscription-authz.ts).
 */

import { getUserAccessLevel } from './permissions';

/** The conversation facts the access decision needs — a subset of a `conversations` row. */
export interface ConversationAccessRow {
  /** The conversation's owner (`conversations.userId`). */
  userId: string;
  isShared: boolean;
  /** 'global' | 'page' | 'drive'. */
  type: string;
  /** null for global; the pageId for page conversations. */
  contextId: string | null;
}

/**
 * Pure core of the predicate — every IO wrapper (below, and the batched
 * stream filter in apps/web) reduces to this one decision so the three
 * enforcement points cannot disagree.
 */
export const decideConversationAccess = ({
  isOwner,
  isShared,
  hasPageAccess,
}: {
  isOwner: boolean;
  isShared: boolean;
  hasPageAccess: boolean;
}): boolean => isOwner || (isShared && hasPageAccess);

/**
 * May `userId` access (subscribe to / observe) `conversation`?
 *
 * Owner short-circuits with no IO. A shared page conversation costs one
 * `getUserAccessLevel` check; everything else denies without IO.
 */
export const canAccessConversation = async (
  userId: string,
  conversation: ConversationAccessRow,
  deps: {
    /** Injectable for tests; defaults to the centralized permission check. */
    getPageAccess?: (userId: string, pageId: string) => Promise<boolean>;
  } = {},
): Promise<boolean> => {
  if (conversation.userId === userId) return true;
  if (conversation.isShared !== true) return false;
  // Only a page conversation has a page to share through.
  if (conversation.type !== 'page' || !conversation.contextId) return false;

  const getPageAccess =
    deps.getPageAccess ??
    (async (uid: string, pageId: string) => (await getUserAccessLevel(uid, pageId)) !== null);

  const hasPageAccess = await getPageAccess(userId, conversation.contextId);
  return decideConversationAccess({ isOwner: false, isShared: true, hasPageAccess });
};
