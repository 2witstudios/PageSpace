/**
 * Cross-type "past conversations" listing for the Agents surface's default
 * middle-panel view — every conversation the requester owns, whatever kind it
 * is (ran inside an agent-sandbox session, a plain page-agent chat, the
 * global assistant, or the rare API-only `type: 'drive'` conversation), newest
 * first, with real cursor pagination (agent_sessions rows are never deleted,
 * so history grows unbounded over a user's lifetime — the same reason
 * `globalConversationRepository.listConversationsPaginated` exists rather
 * than a single unbounded fetch).
 *
 * Deliberately lives beside (not inside) `agent-sessions-runtime.ts`: that
 * file wires the session STORE abstraction; this is a plain cross-table read
 * with no session-lifecycle decision in it, mirroring how
 * `listSessionConversationsBulk` already queries `conversations` directly
 * rather than through the store.
 */

import { db } from '@pagespace/db/db';
import { and, desc, eq, exists, isNotNull, sql } from '@pagespace/db/operators';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { agentSessions } from '@pagespace/db/schema/agent-sessions';
import { pages } from '@pagespace/db/schema/core';

export interface PastConversationRow {
  conversationId: string;
  title: string | null;
  type: string;
  /** The page id when `type === 'page'`, else null. */
  agentPageId: string | null;
  /** The agent page's own title (distinct from the conversation's own title), when `type === 'page'`. */
  pageTitle: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  sessionId: string | null;
  /** '' when the session has no display name, mirroring `toAgentSessionDTO`'s `name ?? ''`. */
  sessionName: string | null;
  sessionEndedAt: Date | null;
  /** Resolved from the page's drive, the session's drive, or (for `type: 'drive'`) the conversation's own contextId. Null only for a driveless global-assistant conversation. */
  driveId: string | null;
}

export interface ListAllConversationsPaginatedInput {
  limit?: number;
  /** Always "older than this conversation" — see `listAllConversationsPaginated`'s doc comment for why there is no `after` direction. */
  cursor?: string;
}

export interface PaginatedPastConversationsResult {
  conversations: PastConversationRow[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
    limit: number;
  };
}

/** Keeps conversations that never got a first message out of "history" — same rule `globalConversationRepository` applies. */
const hasActiveMessage = exists(
  db
    .select({ one: sql`1` })
    .from(messages)
    .where(and(eq(messages.conversationId, conversations.id), eq(messages.isActive, true))),
);

/**
 * The sort/cursor key. NOT just `lastMessageAt`: unlike the global-chat
 * listing (which only ever lists conversations already known to have
 * messages), a brand-new agent-session conversation can have zero messages
 * yet — `lastMessageAt` null — and still needs a sensible recency position.
 */
const sortKeyExpr = sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt})`;

/** `pages.driveId` for a page conversation, `agentSessions.driveId` for a session-bound one, the conversation's own contextId for a `type: 'drive'` one — else null (a driveless global-assistant conversation). */
const resolvedDriveIdExpr = sql<string | null>`COALESCE(${pages.driveId}, ${agentSessions.driveId}, CASE WHEN ${conversations.type} = 'drive' THEN ${conversations.contextId} ELSE NULL END)`;

/**
 * Cursor pagination is unidirectional ("older than `cursor`") on purpose —
 * not a `direction: 'before' | 'after'` toggle like
 * `globalConversationRepository.listConversationsPaginated`'s. This listing's
 * only consumer (`AgentsPastConversationsList`) never asks to go "forward":
 * its Prev button replays an already-fetched, SWR-cached earlier page rather
 * than re-querying the server. An `after` branch would need the ORDER BY
 * direction inverted (ascending toward the cursor, then reversed back to
 * descending for display) to return the page truly adjacent to the cursor —
 * a real algorithm this listing has no caller to exercise or verify, so it
 * doesn't exist here rather than existing unverified and wrong (caught in
 * review: an earlier version reused the `>` comparator under an unchanged
 * `ORDER BY ... DESC`, which returns the globally newest matches instead of
 * the page adjacent to the cursor).
 */
export async function listAllConversationsPaginated(
  filter: { ownerId: string; driveId?: string },
  options: ListAllConversationsPaginatedInput = {},
): Promise<PaginatedPastConversationsResult> {
  const { limit = 20, cursor } = options;
  const maxLimit = Math.min(Math.max(limit, 1), 100);

  const conditions = [
    eq(conversations.userId, filter.ownerId),
    eq(conversations.isActive, true),
    hasActiveMessage,
  ];

  // Deliberately NOT filtering out `closedInSessionAt IS NOT NULL` here: a
  // conversation closed from its session is still valid past-conversation
  // HISTORY, just no longer part of the session's LIVE tree — that exclusion
  // belongs to `listSessionConversationsBulk` (the sidebar), not this listing.

  if (filter.driveId) {
    const driveId = filter.driveId;
    // A driveless global-assistant conversation is never shown in drive-scoped
    // mode — there is no drive for it to belong to.
    conditions.push(sql`(
      (${conversations.type} = 'page' AND ${pages.driveId} = ${driveId})
      OR (${isNotNull(conversations.sessionId)} AND ${agentSessions.driveId} = ${driveId})
      OR (${conversations.type} = 'drive' AND ${conversations.contextId} = ${driveId})
    )`);
  }

  if (cursor) {
    const [cursorRow] = await db
      .select({ sortKey: sortKeyExpr, id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, cursor))
      .limit(1);

    if (cursorRow) {
      conditions.push(
        sql`(${sortKeyExpr} < ${cursorRow.sortKey} OR (${sortKeyExpr} = ${cursorRow.sortKey} AND ${conversations.id} < ${cursorRow.id}))`,
      );
    }
  }

  const rows = await db
    .select({
      conversationId: conversations.id,
      title: conversations.title,
      type: conversations.type,
      contextId: conversations.contextId,
      lastMessageAt: conversations.lastMessageAt,
      createdAt: conversations.createdAt,
      sessionId: conversations.sessionId,
      sessionName: agentSessions.name,
      sessionEndedAt: agentSessions.endedAt,
      pageTitle: pages.title,
      driveId: resolvedDriveIdExpr,
    })
    .from(conversations)
    .leftJoin(agentSessions, eq(conversations.sessionId, agentSessions.id))
    .leftJoin(pages, and(eq(conversations.contextId, pages.id), eq(conversations.type, 'page')))
    .where(and(...conditions))
    .orderBy(desc(sortKeyExpr), desc(conversations.id))
    .limit(maxLimit + 1);

  const hasMore = rows.length > maxLimit;
  const page = hasMore ? rows.slice(0, maxLimit) : rows;

  return {
    conversations: page.map((row) => ({
      conversationId: row.conversationId,
      title: row.title,
      type: row.type,
      agentPageId: row.type === 'page' ? row.contextId : null,
      pageTitle: row.pageTitle,
      lastMessageAt: row.lastMessageAt,
      createdAt: row.createdAt,
      sessionId: row.sessionId,
      sessionName: row.sessionName,
      sessionEndedAt: row.sessionEndedAt,
      driveId: row.driveId,
    })),
    pagination: {
      hasMore,
      nextCursor: hasMore && page.length > 0 ? page[page.length - 1].conversationId : null,
      limit: maxLimit,
    },
  };
}
