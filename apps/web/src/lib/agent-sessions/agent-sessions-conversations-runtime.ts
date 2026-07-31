/**
 * Cross-type "past conversations" listing for the Agents surface's default
 * middle-panel view — every conversation the requester owns, whatever kind it
 * is (ran inside an agent-sandbox session, a plain page-agent chat, the
 * global assistant, or the rare API-only `type: 'client'` conversation
 * created via `POST /api/v1/conversations`), newest first, with real cursor
 * pagination (agent_sessions rows are never deleted, so history grows
 * unbounded over a user's lifetime — the same reason
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
import { and, desc, eq, exists, isNotNull, or, sql } from '@pagespace/db/operators';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { agentSessions } from '@pagespace/db/schema/agent-sessions';
import { pages, chatMessages } from '@pagespace/db/schema/core';

export interface PastConversationRow {
  conversationId: string;
  title: string | null;
  type: string;
  /** The page id when `type === 'page'`, else null. */
  agentPageId: string | null;
  /** The agent page's own title (distinct from the conversation's own title), when `type === 'page'`. */
  pageTitle: string | null;
  /** Real recency — see `recencyExpr` below. Never simply `conversations.lastMessageAt`, which stays null forever for `type: 'page'`. */
  lastMessageAt: Date | null;
  createdAt: Date;
  sessionId: string | null;
  /** '' when the session has no display name, mirroring `toAgentSessionDTO`'s `name ?? ''`. */
  sessionName: string | null;
  sessionEndedAt: Date | null;
  /** Resolved from the page's drive, the session's drive, or (for `type: 'client'`) the conversation's own contextId. Null only for a driveless global-assistant conversation. */
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

/**
 * Keeps conversations that never got a first message out of "history" — same
 * rule `globalConversationRepository` applies. NOT a single table: despite
 * `messages`' own doc comment claiming to be "unified... for all conversation
 * types", only `type: 'global'` content actually lands there — `type: 'page'`
 * AND `type: 'client'` conversations write to the older `chat_messages` table
 * instead (both share the same underlying send path,
 * `saveMessageToDatabase`/`chatMessageRepository`). Checking only `messages`
 * here silently excluded every one of those conversations from this listing
 * (review finding).
 *
 * Matched on `chatMessages.conversationId` ALONE — no `pageId` join. A
 * `type: 'client'` conversation's `chat_messages` rows can carry a DIFFERENT
 * `pageId` per message (the v1 completions API lets each request target a
 * different agent page; only `conversationId` scopes a thread), so a `pageId`
 * equality would just never match for that type. `conversationId` is a
 * cuid2 — already globally unique — so it never needed the extra key even
 * for `type: 'page'`.
 */
const hasActiveMessage = or(
  exists(
    db
      .select({ one: sql`1` })
      .from(messages)
      .where(and(eq(messages.conversationId, conversations.id), eq(messages.isActive, true))),
  ),
  exists(
    db
      .select({ one: sql`1` })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.conversationId, conversations.id),
          eq(chatMessages.isActive, true),
          sql`${chatMessages.status} != 'streaming'`,
        ),
      ),
  ),
)!;

/**
 * The real "last activity" timestamp — NOT `conversations.lastMessageAt`,
 * which nothing ever sets for `type: 'page'`/`type: 'client'` conversations
 * (their send path writes only `chat_messages`; grepping every
 * `.set({...lastMessageAt...})` call in this codebase turns up exactly two
 * call sites, both in the global-assistant message routes). Sorting or
 * displaying recency by `conversations.lastMessageAt` alone left every
 * page-agent conversation permanently ordered by its CREATION time, however
 * recently it was actually used (review finding). Mirrors
 * `conversationRepository.listConversations`'s own `MAX(chat_messages."createdAt")
 * GROUP BY "conversationId"` derivation, as a correlated subquery here since
 * this listing needs ONE sortable expression across heterogeneous source
 * tables. Falls back to `conversations.lastMessageAt` for `type: 'global'`
 * rows (where that column IS the source of truth).
 */
const recencyExpr = sql<Date | null>`COALESCE(
  (SELECT MAX(${chatMessages.createdAt}) FROM chat_messages
   WHERE ${chatMessages.conversationId} = ${conversations.id}
     AND ${chatMessages.isActive} = true
     AND ${chatMessages.status} != 'streaming'),
  ${conversations.lastMessageAt}
)`;

/**
 * The sort/cursor key. NOT just `recencyExpr`: a brand-new agent-session
 * conversation can have zero messages yet — recency null — and still needs a
 * sensible position (its own creation time).
 */
const sortKeyExpr = sql<Date>`COALESCE(${recencyExpr}, ${conversations.createdAt})`;

/** `pages.driveId` for a page conversation, `agentSessions.driveId` for a session-bound one, the conversation's own contextId for a `type: 'client'` one (that column holds an optional driveId for API-managed conversations — see `buildCreateConversationPayload`) — else null (a driveless global-assistant conversation). */
const resolvedDriveIdExpr = sql<string | null>`COALESCE(${pages.driveId}, ${agentSessions.driveId}, CASE WHEN ${conversations.type} = 'client' THEN ${conversations.contextId} ELSE NULL END)`;

/**
 * The cursor is an OPAQUE token encoding the sort key the caller last saw —
 * NOT just a bare conversationId re-resolved against LIVE data. `sortKeyExpr`
 * is derived from `chat_messages`, which can change between one page fetch
 * and the next: if the cursor conversation receives a new message in that
 * window, re-deriving its sortKey fresh would shift the boundary FORWARD,
 * re-admitting rows already shown on the previous page. Worse, if the cursor
 * row disappeared entirely (deleted), a live re-lookup finds nothing and
 * silently applies no boundary at all, returning page one again instead of
 * the requested next page (review finding). Freezing the observed sort key
 * into the cursor itself removes the live dependency — and the extra DB
 * round-trip a live lookup needed — entirely.
 */
export function encodeCursor(sortKey: Date | string, id: string): string {
  // The driver doesn't hydrate a raw computed SQL expression into a real
  // `Date` the way it does a schema-known timestamp COLUMN (confirmed
  // against real Postgres: `sortKeyExpr`'s runtime value is a string despite
  // its `sql<Date>` type) — normalize defensively rather than trust the type.
  const date = sortKey instanceof Date ? sortKey : new Date(sortKey);
  return Buffer.from(JSON.stringify({ sortKey: date.toISOString(), id })).toString('base64url');
}

export function decodeCursor(cursor: string): { sortKey: Date; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { sortKey?: unknown }).sortKey !== 'string' ||
      typeof (parsed as { id?: unknown }).id !== 'string'
    ) {
      return null;
    }
    const sortKey = new Date((parsed as { sortKey: string }).sortKey);
    if (Number.isNaN(sortKey.getTime())) return null;
    return { sortKey, id: (parsed as { id: string }).id };
  } catch {
    // Malformed/tampered cursor — same treatment as a cursor whose id no
    // longer resolves to anything: ignored, not an error (fails open to
    // page one, consistent with how this listing already treats an unknown
    // cursor id).
    return null;
  }
}

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
      OR (${conversations.type} = 'client' AND ${conversations.contextId} = ${driveId})
    )`);
  }

  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (decoded) {
      conditions.push(
        sql`(${sortKeyExpr} < ${decoded.sortKey} OR (${sortKeyExpr} = ${decoded.sortKey} AND ${conversations.id} < ${decoded.id}))`,
      );
    }
  }

  const rows = await db
    .select({
      conversationId: conversations.id,
      title: conversations.title,
      type: conversations.type,
      contextId: conversations.contextId,
      lastMessageAt: recencyExpr,
      sortKeyValue: sortKeyExpr,
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
  const lastRow = page.length > 0 ? page[page.length - 1] : null;

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
      nextCursor: hasMore && lastRow ? encodeCursor(lastRow.sortKeyValue, lastRow.conversationId) : null,
      limit: maxLimit,
    },
  };
}
