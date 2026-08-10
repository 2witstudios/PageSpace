/**
 * Cross-type "past conversations" listing for the Agents surface's default
 * middle-panel view — every conversation the requester owns, whatever kind it
 * is (ran inside an agent-sandbox session, a plain page-agent chat, the
 * global assistant, or the rare API-only `type: 'client'` conversation
 * created via `POST /api/v1/conversations`), newest first, with real cursor
 * pagination (agent_workspaces rows are never deleted, so history grows
 * unbounded over a user's lifetime — the same reason
 * `globalConversationRepository.listConversationsPaginated` exists rather
 * than a single unbounded fetch).
 *
 * Deliberately lives beside (not inside) `agent-workspaces-runtime.ts`: that
 * file wires the session STORE abstraction; this is a plain cross-table read
 * with no session-lifecycle decision in it, mirroring how
 * `listSessionConversationsBulk` already queries `conversations` directly
 * rather than through the store.
 */

import { db } from '@pagespace/db/db';
import { and, desc, eq, exists, isNotNull, sql } from '@pagespace/db/operators';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { agentWorkspaceNodes } from '@pagespace/db/schema/agent-workspace-nodes';
import { pages } from '@pagespace/db/schema/core';
import { conversationPageId } from '@pagespace/lib/conversations/conversation-page';

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
  workspaceId: string | null;
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
 * rule `globalConversationRepository` applies.
 *
 * ONE table since the message-table merge (epic "Agent-Session Single Source
 * of Truth", Phase 4 / D6 — reader cutover). This used to be an `OR` of two
 * `EXISTS`: `messages` for `type: 'global'` and `chat_messages` for
 * `type: 'page'` / `type: 'client'`. Both legs now live in `messages`.
 *
 * Matched on `conversationId` ALONE — no page predicate, exactly as the
 * legacy `chat_messages` leg was. A `type: 'client'` conversation's rows can
 * carry a DIFFERENT `pageId` per row (the v1 completions API lets each
 * request target a different agent page; only `conversationId` scopes a
 * thread), so a page equality would never match for that type.
 * `conversationId` is a cuid2 — globally unique — so it never needed the
 * extra key even for `type: 'page'`.
 *
 * The `status != 'streaming'` filter, previously carried by the
 * `chat_messages` leg only, is now applied uniformly: a conversation whose
 * only row is a mid-flight placeholder has no history to show, whatever its
 * type. In practice this is invisible on global threads — the send pipeline
 * persists the user's `complete` row before it inserts the assistant
 * placeholder, so a global conversation can never be placeholder-only in a
 * committed state.
 */


const hasActiveMessage = exists(
  db
    .select({ one: sql`1` })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversations.id),
        eq(messages.isActive, true),
        sql`${messages.status} != 'streaming'`,
      ),
    ),
);

/**
 * The real "last activity" timestamp — NOT `conversations.lastMessageAt`,
 * which nothing ever sets for `type: 'page'`/`type: 'client'` conversations
 * (grepping every `.set({...lastMessageAt...})` call in this codebase turns up
 * exactly two call sites, both in the global-assistant message routes).
 * Sorting or displaying recency by `conversations.lastMessageAt` alone left
 * every page-agent conversation permanently ordered by its CREATION time,
 * however recently it was actually used (review finding).
 *
 * Reads the unified `messages` table since the merge (Phase 4 / D6). The
 * `COALESCE` fallback to `lastMessageAt` is KEPT rather than deleted: it still
 * carries a conversation whose messages were all soft-deleted or are all
 * mid-flight, and — during the expand window — one whose legacy rows the
 * backfill has not copied across yet. For a global thread the two agree to
 * within the write itself (`lastMessageAt` is stamped in the same transaction
 * as the row), so the MAX simply becomes the more precise of the two.
 */
const recencyExpr = sql<Date | null>`COALESCE(
  (SELECT MAX(${messages.createdAt}) FROM messages
   WHERE ${messages.conversationId} = ${conversations.id}
     AND ${messages.isActive} = true
     AND ${messages.status} != 'streaming'),
  ${conversations.lastMessageAt}
)`;

/**
 * The sort/cursor key. NOT just `recencyExpr`: a brand-new agent-session
 * conversation can have zero messages yet — recency null — and still needs a
 * sensible position (its own creation time).
 */
const sortKeyExpr = sql<Date>`COALESCE(${recencyExpr}, ${conversations.createdAt})`;

/** `pages.driveId` for a page conversation, `agentWorkspaces.driveId` for a session-bound one, the conversation's own contextId for a `type: 'client'` one (that column holds an optional driveId for API-managed conversations — see `buildCreateConversationPayload`) — else null (a driveless global-assistant conversation). */
const resolvedDriveIdExpr = sql<string | null>`COALESCE(${pages.driveId}, ${agentWorkspaces.driveId}, CASE WHEN ${conversations.type} = 'client' THEN ${conversations.contextId} ELSE NULL END)`;

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
  // against real Postgres via drizzle's own query builder: `sortKeyExpr`'s
  // runtime value is a STRING, e.g. `"2026-07-28 12:00:00.123456"`, with full
  // microsecond precision — Postgres timestamps carry six fractional digits,
  // a plain JS `Date` only three). Round-tripping that string through
  // `new Date(...).toISOString()` truncates it to milliseconds — verified
  // against the real test DB that this silently collapses two distinct
  // sub-millisecond sort keys onto the same encoded value, making the next
  // page's boundary re-admit a row it should have excluded (review finding).
  // Preserve a string AS GIVEN; only a genuine `Date` (e.g. a plain
  // `createdAt` fallback, which is already millisecond-limited at the
  // column level) goes through `toISOString()`.
  const encoded = typeof sortKey === 'string' ? sortKey : sortKey.toISOString();
  return Buffer.from(JSON.stringify({ sortKey: encoded, id })).toString('base64url');
}

export function decodeCursor(cursor: string): { sortKey: string; id: string } | null {
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
    const sortKey = (parsed as { sortKey: string }).sortKey;
    // Validate it's a real, parseable timestamp — but return the ORIGINAL
    // string, not a `new Date(sortKey)` reconstruction, which would
    // re-truncate any sub-millisecond precision right back out again.
    if (Number.isNaN(new Date(sortKey).getTime())) return null;
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
 * The chat-bound nodes, as a joinable relation — a thread's MEMBERSHIP.
 *
 * A plain `leftJoin` on `agent_workspace_nodes` would also match this thread's
 * page and terminal siblings, so the `targetKind = 'chat'` predicate has to sit
 * INSIDE the joined relation rather than in the outer WHERE: in the outer one it
 * would turn the left join into an inner one for every row it did not match, and
 * quietly drop every conversation that belongs to no workspace.
 *
 * At most one row per conversation by construction — the table's global
 * `UNIQUE (targetId) WHERE targetKind = 'chat'` — so this join can never
 * multiply the listing.
 *
 * BUILT PER CALL, not once at module scope. A subquery alias is cheap to
 * construct, and building it at import time makes importing this module do
 * query-builder work — which every suite that mocks `db` then has to model,
 * for a value none of them use.
 */
function membershipNodeRelation() {
  return db
    .select({ targetId: agentWorkspaceNodes.targetId, rootId: agentWorkspaceNodes.rootId })
    .from(agentWorkspaceNodes)
    .where(eq(agentWorkspaceNodes.targetKind, 'chat'))
    .as('membership_node');
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
  const membershipNode = membershipNodeRelation();
  const maxLimit = Math.min(Math.max(limit, 1), 100);

  const conditions = [
    eq(conversations.userId, filter.ownerId),
    eq(conversations.isActive, true),
    hasActiveMessage,
  ];

  // Deliberately NOT filtering by where a thread's node SITS: a conversation
  // closed off its workspace's grid is still valid past-conversation HISTORY,
  // just parked — and a thread in no workspace at all is history too. This
  // listing is about what a user has said, not about what is on screen.

  if (filter.driveId) {
    const driveId = filter.driveId;
    // A driveless global-assistant conversation is never shown in drive-scoped
    // mode — there is no drive for it to belong to.
    conditions.push(sql`(
      (${conversations.type} = 'page' AND ${pages.driveId} = ${driveId})
      OR (${isNotNull(membershipNode.rootId)} AND ${agentWorkspaces.driveId} = ${driveId})
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
      // MEMBERSHIP, from the tree — the node that binds this thread names the
      // workspace it belongs to, where this used to read the conversation's own
      // column. A thread with no node is in no workspace and gets a null here:
      // that is the only shape of "not a member" there is now, because the node
      // IS the membership and there is no off-grid state for one to sit in. The
      // thread itself is untouched either way — it stays in this listing as
      // past-conversation history.
      workspaceId: membershipNode.rootId,
      sessionName: agentWorkspaces.name,
      sessionEndedAt: agentWorkspaces.endedAt,
      pageTitle: pages.title,
      driveId: resolvedDriveIdExpr,
    })
    .from(conversations)
    .leftJoin(membershipNode, eq(membershipNode.targetId, conversations.id))
    .leftJoin(agentWorkspaces, eq(agentWorkspaces.id, membershipNode.rootId))
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
      agentPageId: conversationPageId(row),
      pageTitle: row.pageTitle,
      lastMessageAt: row.lastMessageAt,
      createdAt: row.createdAt,
      workspaceId: row.workspaceId,
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
