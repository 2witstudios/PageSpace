import { pgTable, text, timestamp, jsonb, boolean, bigint, index, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { users } from './auth';
import { pages } from './core';
import { agentWorkspaces } from './agent-workspaces';
import { createId } from '@paralleldrive/cuid2';

/**
 * Unified conversations table for all chat types
 * Supports global, page-specific, and drive-specific conversations
 */
export const conversations = pgTable('conversations', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title'), // Auto-generated from first message or user-defined
  type: text('type').notNull(), // 'global' | 'page' | 'drive'
  contextId: text('contextId'), // null for global, pageId for page chats, driveId for drive chats
  /**
   * The agent session (working context / sandbox) this thread lives in, or
   * NULL for a plain chat with no session. The binding is write-once: set
   * either at creation, or — for a conversation that has never had one — by
   * exactly one guarded claim of the caller's own row
   * (`conversationRepository.claimConversation`, `WHERE workspaceId IS NULL AND
   * userId = :caller`; see `apps/web/src/lib/agent-workspaces/claim-conversation-in-session.ts`).
   * It never re-points an already-bound row: a thread's history and its
   * filesystem always agree, so moving a thread to another session is a
   * fork, never a rebind. ON DELETE SET NULL: deleting a session keeps its
   * threads as plain history (also reachable via the same claim path again).
   */
  workspaceId: text('workspaceId').references(() => agentWorkspaces.id, { onDelete: 'set null' }),
  /**
   * THE PAGE LINK FOR A `type='client'` THREAD — the API-managed conversations
   * `POST /api/v1/conversations` mints for pagespace-cli and other
   * OpenAI-compatible clients (epic "Agent-Session Single Source of Truth",
   * Phase 4 PR 15).
   *
   * Every other conversation kind already names its page in `contextId`:
   * `type='page'` puts the agent page there, and that is the authority every
   * page-scoped reader derives from. A `type='client'` row cannot, because its
   * `contextId` is its DRIVE — and that is not decoration, it is the scope a
   * drive-scoped MCP token is authorized against
   * (`GET`/`DELETE /api/v1/conversations/[id]` refuse a conversation whose
   * `contextId` is not in the token's allowed drives). So the page needs its
   * own column, and this is it.
   *
   * Until PR 15 the fact lived on `messages.pageId`, copied onto every row of
   * the thread — the transitional column the merge carried and this PR drops.
   * Moving it here is the same fact with ONE owner instead of N, which is the
   * epic's rule; it also fixes a latent bug, because a thread whose requests
   * named two different agent pages had its history load silently truncated to
   * the subset matching the request's page.
   *
   * WRITE-ONCE, and stamped lazily: the page is not known when
   * `POST /api/v1/conversations` mints the row (the model, and therefore the
   * agent page, arrives with the first completion). The first
   * `POST /api/v1/chat/completions` against the thread claims it
   * (`conversationRepository.stampClientConversationPage`, `WHERE type='client'
   * AND "agentPageId" IS NULL`); later requests naming a different agent never
   * re-point it, for the same reason `workspaceId` is write-once.
   *
   * `ON DELETE SET NULL`, matching `workspaceId` and NOT the
   * `chat_messages.pageId` cascade it replaces: this column must not become an
   * implicit deleter of `conversations` rows, because SET NULL is also what
   * makes a *soft*-deleted or moved page harmless.
   *
   * Permanent deletion is handled EXPLICITLY instead, in one place —
   * `packages/lib/src/repositories/conversation-cleanup.ts` — which every page
   * and drive delete path calls BEFORE deleting the rows (this FK nulls
   * itself the moment the page goes, so the scope must be collected first).
   * That helper deletes the `conversations` row as well as its messages: the
   * shell used to survive, and with it `ai_stream_sessions.parts` — message
   * content that cascades from `conversations` and from nothing else, leaving
   * it alive and unreachable by any sweep after the page was erased.
   *
   * NULL for every other conversation type, and for a client thread that has
   * not yet run a completion. Read it through `derivedPageId()` /
   * `unifiedPageScope()` (`apps/web/src/lib/repositories/unified-message-scope.ts`),
   * never directly — those are where "which column names this row's page"
   * is defined exactly once.
   */
  agentPageId: text('agentPageId').references(() => pages.id, { onDelete: 'set null' }),
  /**
   * Stamped when this thread is closed OUT OF its session's listing — a fact
   * separate from `isActive` (history soft-delete) on purpose: closing from
   * the session must never touch history. NULL = open in the session's
   * working set; set = closed from the listing (and, symmetrically, no
   * longer counted against the session's conversation cap). Reopening is
   * just clearing the stamp.
   */
  closedInWorkspaceAt: timestamp('closedInWorkspaceAt', { mode: 'date' }),
  /**
   * Monotonic per-conversation revision counter (Agent-Session Single Source
   * of Truth epic, Phase 2). Every committed message/conversation mutation
   * bumps it IN-TRANSACTION (`SET rev = rev + 1 ... RETURNING rev`) and the
   * resulting `conversation:*` event carries the post-write rev, so any
   * subscriber holding a rev watermark can prove it is current: an event with
   * `rev == watermark + 1` applies, a gap triggers a snapshot refetch.
   * Transport stays best-effort; correctness comes from rev + refetch.
   * `mode: 'number'` is safe: a conversation would need 2^53 writes to
   * overflow, and the counter is per-row.
   */
  rev: bigint('rev', { mode: 'number' }).default(0).notNull(),
  lastMessageAt: timestamp('lastMessageAt', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
  isActive: boolean('isActive').default(true).notNull(),
  isShared: boolean('isShared').default(false).notNull(),
}, (table) => ({
  userIdx: index('conversations_user_id_idx').on(table.userId),
  userTypeIdx: index('conversations_user_id_type_idx').on(table.userId, table.type),
  userLastMessageIdx: index('conversations_user_id_last_message_at_idx').on(table.userId, table.lastMessageAt),
  contextIdx: index('conversations_context_id_idx').on(table.contextId),
  workspaceIdx: index('conversations_workspace_id_idx').on(table.workspaceId),
  /**
   * The `type='client'` half of `unifiedPageScope()`. Page-scoped reads join
   * `conversations` and filter on `contextId` OR this column, so the second
   * disjunct needs its own index for the same reason the first one has
   * `conversations_context_id_idx`.
   */
  agentPageIdx: index('conversations_agent_page_id_idx').on(table.agentPageId),
  /**
   * `type` ⇄ `contextId` consistency — the invariant every reader has always
   * assumed and nothing has ever enforced (epic "Agent-Session Single Source
   * of Truth", Phase 4 — integrity constraints). It becomes load-bearing at
   * the message merge: a page conversation's page IS `contextId`, so a page
   * row with a NULL context is a message set with no page, and a global row
   * with a context is a page reference the global reader will never look at.
   *
   * All THREE are added `NOT VALID` (hand-appended in migration 0249 —
   * drizzle has no expression for it): new and updated rows are checked from
   * the moment they land, the legacy corpus is not scanned, and the
   * `VALIDATE CONSTRAINT` decision belongs to a later PR that has looked at
   * real data. Written as `type <> X OR ...` rather than `CASE`, so a row of
   * any other type is unconstrained rather than accidentally forbidden.
   */
  globalHasNoContext: check(
    'conversations_global_context_null_chk',
    sql`${table.type} <> 'global' OR ${table.contextId} IS NULL`,
  ),
  pageHasContext: check(
    'conversations_page_context_present_chk',
    sql`${table.type} <> 'page' OR ${table.contextId} IS NOT NULL`,
  ),
  /**
   * Included after auditing the writers rather than the rows: NO code path in
   * this repo mints a `type='drive'` conversation (`createConversation` writes
   * 'page', the global repository writes 'global'; the value survives only in
   * this column's comment and in type unions). So the constraint cannot break
   * a live writer, and `NOT VALID` means it cannot break a legacy row either —
   * it exists to make the first drive-scoped writer supply the driveId
   * instead of rediscovering this the way page chats did.
   */
  driveHasContext: check(
    'conversations_drive_context_present_chk',
    sql`${table.type} <> 'drive' OR ${table.contextId} IS NOT NULL`,
  ),
}));

/**
 * THE message table — one table for every conversation type (global
 * assistant, page chat, drive chat, API-managed client threads).
 *
 * `chat_messages` was merged INTO this table across Phase 4 of the epic
 * "Agent-Session Single Source of Truth" (D6) and DROPPED at PR 15, migration
 * 0252. Two of the three columns that merge added are permanent — a nullable
 * `userId` and `sourceAgentId` — and the third, a transitional `pageId`, went
 * with the legacy table: a row's page is derived from its conversation
 * (`conversations.contextId` for `type='page'`, `conversations.agentPageId`
 * for `type='client'`), never stored per row. `unifiedPageScope()` /
 * `derivedPageId()` in
 * `apps/web/src/lib/repositories/unified-message-scope.ts` are the single
 * definition of that derivation.
 *
 * ATTRIBUTION RULE (the contract every writer and reader must honour):
 *   - `userId` NOT NULL  ⇒ a human wrote it, and that is who.
 *   - `userId` NULL      ⇒ agent- or system-authored. `sourceAgentId` names
 *                          the authoring agent page WHEN KNOWN; both NULL is
 *                          legal and means "authored by the platform, source
 *                          not recorded".
 *
 * There is DELIBERATELY NO CHECK constraint binding those two columns. Rows
 * carried over from the legacy corpus include NULL/NULL ones (agent replies
 * written before `sourceAgentId` existed); a CHECK would either have rejected
 * the backfill or forced us to invent attribution we do not have. The rule is
 * documented and tested, not enforced by the database.
 */
export const messages = pgTable('messages', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  conversationId: text('conversationId').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  /**
   * The HUMAN author, or NULL for an agent/system-authored row. See the
   * attribution rule in this table's doc comment. Relaxed from NOT NULL in
   * 0248: purely widening, so every pre-existing row and every old-code
   * INSERT during the rolling-deploy window stays valid.
   */
  userId: text('userId').references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'user' | 'assistant'
  messageType: text('messageType', { enum: ['standard', 'todo_list'] }).default('standard').notNull(),
  content: text('content').notNull(),
  toolCalls: jsonb('toolCalls'),
  toolResults: jsonb('toolResults'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  isActive: boolean('isActive').default(true).notNull(),
  editedAt: timestamp('editedAt', { mode: 'date' }),
  // Lifecycle state of an assistant row from the moment generation starts.
  // 'streaming' rows are placeholders (empty content, mid-flight);
  // 'interrupted' rows are terminal with real partial content; pre-existing
  // rows read as 'complete' via the default. See Server Stream Durability
  // epic PR 2.
  status: text('status', { enum: ['streaming', 'complete', 'interrupted'] }).default('complete').notNull(),
  /**
   * The agent page that authored this row, when known. `ON DELETE SET NULL`:
   * deleting an agent must never delete the transcript it produced — the
   * message survives, attributed to nobody (see the attribution rule above).
   *
   * NOT the row's page: this names the AUTHOR. Where the row LIVES is its
   * conversation's business (`derivedPageId()`).
   */
  sourceAgentId: text('sourceAgentId').references(() => pages.id, { onDelete: 'set null' }),
}, (table) => ({
  conversationIdx: index('messages_conversation_id_idx').on(table.conversationId),
  conversationCreatedAtIdx: index('messages_conversation_id_created_at_idx').on(table.conversationId, table.createdAt),
  userIdx: index('messages_user_id_idx').on(table.userId),
  // The page-scoped indexes 0248 created on the transitional `pageId` went
  // with the column in 0252. A page-scoped read is now a JOIN through
  // `conversations`, served by `conversations_context_id_idx` /
  // `conversations_agent_page_id_idx` on the outer side and
  // `messages_conversation_id_created_at_idx` on this one.
}));

// Relations
export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(users, {
    fields: [conversations.userId],
    references: [users.id],
  }),
  workspace: one(agentWorkspaces, {
    fields: [conversations.workspaceId],
    references: [agentWorkspaces.id],
  }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  user: one(users, {
    fields: [messages.userId],
    references: [users.id],
  }),
  sourceAgent: one(pages, {
    fields: [messages.sourceAgentId],
    references: [pages.id],
    relationName: 'messageSourceAgent',
  }),
}));