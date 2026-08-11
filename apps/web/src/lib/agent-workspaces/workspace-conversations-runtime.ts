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
import { and, eq, exists, isNotNull, sql } from '@pagespace/db/operators';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { agentWorkspaceNodes } from '@pagespace/db/schema/agent-workspace-nodes';
import { pages } from '@pagespace/db/schema/core';
import { conversationPageId } from '@pagespace/lib/conversations/conversation-page';
// Recency, the sort key and the cursor codecs are declared ONCE, in the module
// both history listings import — see that file's header for the drift that
// motivated it.
import {
  recencyExpr,
  sortKeyExpr,
  newestFirst,
  encodeCursor,
  decodeCursor,
  olderThanCursor,
} from '@/lib/conversations/conversation-recency';
// The row shape is declared ONCE, in the wire contract both ends import, so
// the client cannot silently drift from what this file actually emits — see
// that file's header for the bug that motivated it.
import type { PastConversationServerRow } from './past-conversation-dto';

export interface ListAllConversationsPaginatedInput {
  limit?: number;
  /** Always "older than this conversation" — see `listAllConversationsPaginated`'s doc comment for why there is no `after` direction. */
  cursor?: string;
}

export interface PaginatedPastConversationsResult {
  conversations: PastConversationServerRow[];
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

/** `pages.driveId` for a page conversation, `agentWorkspaces.driveId` for a session-bound one, the conversation's own contextId for a `type: 'client'` one (that column holds an optional driveId for API-managed conversations — see `buildCreateConversationPayload`) — else null (a driveless global-assistant conversation). */
const resolvedDriveIdExpr = sql<string | null>`COALESCE(${pages.driveId}, ${agentWorkspaces.driveId}, CASE WHEN ${conversations.type} = 'client' THEN ${conversations.contextId} ELSE NULL END)`;

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
        olderThanCursor(decoded),
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
    .orderBy(...newestFirst())
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
      // Server-only; the route needs it to mint a cursor for a row IT
      // truncates after permission filtering, and `toWireRow` strips it.
      sortKeyValue: row.sortKeyValue,
    })),
    pagination: {
      hasMore,
      nextCursor: hasMore && lastRow ? encodeCursor(lastRow.sortKeyValue, lastRow.conversationId) : null,
      limit: maxLimit,
    },
  };
}
