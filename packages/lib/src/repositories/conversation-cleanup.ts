/**
 * Conversation/message cleanup for PERMANENT deletion of a page or a drive.
 *
 * WHY THIS EXISTS AT ALL. `chat_messages.pageId` used to carry
 * `REFERENCES pages(id) ON DELETE CASCADE`, and that FK was the physical net
 * under every page- and drive-deletion path in the codebase: nothing had to
 * remember to clean chat history up, because the database did it. Migration
 * 0253 dropped `chat_messages`, and the net went with it. What replaced it
 * does NOT cover the same ground:
 *
 *   * `conversations.contextId` — the page id for `type='page'`, the drive id
 *     for `type='drive'`/`type='client'` — has never been a foreign key at
 *     all. It is a bare, polymorphic text column.
 *   * `conversations.agentPageId` is `ON DELETE SET NULL`, so deleting a page
 *     merely FORGETS which agent a client thread spoke to.
 *   * `messages.conversationId` cascades from `conversations`, and
 *     `ai_stream_sessions.conversationId` cascades from `conversations` — but
 *     neither fires, because nothing deletes the `conversations` row.
 *
 * The result, verified against a migrated database: `DELETE FROM pages` leaves
 * the conversation and its messages, and `DELETE FROM drives` leaves them
 * dangling behind cascaded-away pages. Chat history outlived both. Only the
 * manual trash route had an explicit statement, and it was written inline, so
 * the cron purge and all four drive-delete paths silently under-deleted.
 *
 * THE CONVERSATION ROW GOES TOO — this is a deliberate change of contract.
 * The trash route previously deleted `messages` and left the `conversations`
 * shell standing. That leaks: `ai_stream_sessions` holds partial message
 * content in `parts`, cascades from `conversations` and from nothing else, so
 * an orphaned shell keeps that content alive and UNREACHABLE — no sweep can
 * find it, and no user can read it to request its deletion. For an Article 17
 * erasure path that is the wrong trade. Deleting the shell takes the messages
 * and the stream checkpoints with it in one cascade.
 *
 * SCOPE — which conversations belong to a page. Exactly `unifiedPageScope`'s
 * two disjuncts, and no more:
 *   1. the page's own threads (`type='page'` whose `contextId` IS the page);
 *   2. the API threads anchored to it (`type='client'` whose `agentPageId` is
 *      the page). `agentPageId` is write-once, so such a thread belongs to
 *      that one agent for its whole life — taking it whole is right.
 * A `type='drive'` or `type='global'` thread is NEVER page-scoped and is left
 * alone.
 *
 * ORDERING IS LOAD-BEARING. Every function here must be called BEFORE the
 * `pages`/`drives` rows are deleted. Deleting the page first nulls
 * `agentPageId` (the FK is SET NULL) and deleting the drive first cascades its
 * pages away — either way the scope query stops matching and the history is
 * stranded. Call inside the same transaction as the delete it accompanies.
 */

import { db } from '@pagespace/db/db';
import { and, eq, inArray, or } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { conversations, messages } from '@pagespace/db/schema/conversations';

/**
 * A TRANSACTION handle, specifically — not the module `db`.
 *
 * The header above says "Call inside the same transaction as the delete it
 * accompanies", and every caller does. But this used to alias `typeof db`, so
 * passing the module handle compiled cleanly and split the two deletes below
 * into separate transactions — the messages gone, the conversation shells left
 * behind if the second statement failed. A comment is not an enforcement
 * mechanism; this makes the compiler say it too.
 */
export type DbHandle = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ConversationCleanupResult {
  /** `conversations` rows deleted (each takes its messages + stream state). */
  conversations: number;
  /** `messages` rows deleted. */
  messages: number;
}

const EMPTY: ConversationCleanupResult = { conversations: 0, messages: 0 };

/** Delete the collected conversations and their messages. */
async function deleteConversationSet(
  tx: DbHandle,
  conversationIds: string[],
): Promise<ConversationCleanupResult> {
  if (conversationIds.length === 0) return { ...EMPTY };

  // Messages first and explicitly, rather than leaning on the cascade: the
  // count is part of this function's contract (callers audit-log it), and an
  // explicit statement keeps the deletion legible in a query log.
  const deletedMessages = await tx
    .delete(messages)
    .where(inArray(messages.conversationId, conversationIds))
    .returning({ id: messages.id });

  // Takes `ai_stream_sessions` with it via that table's cascading FK — the
  // whole reason the shell must not survive.
  const deletedConversations = await tx
    .delete(conversations)
    .where(inArray(conversations.id, conversationIds))
    .returning({ id: conversations.id });

  return {
    conversations: deletedConversations.length,
    messages: deletedMessages.length,
  };
}

/**
 * Delete the chat history belonging to `pageIds`.
 *
 * MUST be called before the pages themselves are deleted.
 *
 * Pass exactly the pages that are actually being deleted — no more. There is
 * deliberately no subtree expansion here: `pages.parentId` carries NO foreign
 * key, so deleting a page ORPHANS its children rather than cascading to them.
 * A caller that walks the tree (the manual trash route recurses) calls this
 * once per node it deletes; a caller that deletes a flat set (the cron purge)
 * passes that set. Expanding beyond it would erase history belonging to pages
 * that still exist.
 */
export async function deleteConversationsForPages(
  tx: DbHandle,
  pageIds: string[],
): Promise<ConversationCleanupResult> {
  if (pageIds.length === 0) return { ...EMPTY };

  const doomed = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      or(
        and(eq(conversations.type, 'page'), inArray(conversations.contextId, pageIds)),
        and(eq(conversations.type, 'client'), inArray(conversations.agentPageId, pageIds)),
      ),
    );

  return deleteConversationSet(tx, doomed.map((c) => c.id));
}

/**
 * Delete the chat history belonging to a whole drive.
 *
 * MUST be called before the drive is deleted, because `pages.driveId`
 * cascades: once the drive is gone its pages are gone, and the page-scoped
 * threads below can no longer be found.
 *
 * Covers both the drive's OWN threads (`type='drive'`, and the `type='client'`
 * API threads whose `contextId` is the drive — that is the scope a drive-scoped
 * MCP token authorizes against) and every thread belonging to any page in it.
 */
export async function deleteConversationsForDrive(
  tx: DbHandle,
  driveId: string,
): Promise<ConversationCleanupResult> {
  const drivePages = await tx
    .select({ id: pages.id })
    .from(pages)
    .where(eq(pages.driveId, driveId));
  const pageIds = drivePages.map((p) => p.id);

  const scopes = [
    and(eq(conversations.type, 'drive'), eq(conversations.contextId, driveId)),
    and(eq(conversations.type, 'client'), eq(conversations.contextId, driveId)),
  ];
  if (pageIds.length > 0) {
    scopes.push(
      and(eq(conversations.type, 'page'), inArray(conversations.contextId, pageIds)),
      and(eq(conversations.type, 'client'), inArray(conversations.agentPageId, pageIds)),
    );
  }

  const doomed = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(or(...scopes));

  return deleteConversationSet(tx, doomed.map((c) => c.id));
}

