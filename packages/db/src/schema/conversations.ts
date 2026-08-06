import { pgTable, text, timestamp, jsonb, boolean, bigint, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { pages } from './core';
import { agentSessions } from './agent-sessions';
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
   * (`conversationRepository.claimConversation`, `WHERE sessionId IS NULL AND
   * userId = :caller`; see `apps/web/src/lib/agent-sessions/claim-conversation-in-session.ts`).
   * It never re-points an already-bound row: a thread's history and its
   * filesystem always agree, so moving a thread to another session is a
   * fork, never a rebind. ON DELETE SET NULL: deleting a session keeps its
   * threads as plain history (also reachable via the same claim path again).
   */
  sessionId: text('sessionId').references(() => agentSessions.id, { onDelete: 'set null' }),
  /**
   * Stamped when this thread is closed OUT OF its session's listing — a fact
   * separate from `isActive` (history soft-delete) on purpose: closing from
   * the session must never touch history. NULL = open in the session's
   * working set; set = closed from the listing (and, symmetrically, no
   * longer counted against the session's conversation cap). Reopening is
   * just clearing the stamp.
   */
  closedInSessionAt: timestamp('closedInSessionAt', { mode: 'date' }),
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
  sessionIdx: index('conversations_session_id_idx').on(table.sessionId),
}));

/**
 * Unified messages table for all conversation types.
 *
 * THE MERGE TARGET for `chat_messages` (packages/db/src/schema/core.ts) —
 * epic "Agent-Session Single Source of Truth", Phase 4 (D6). The two tables
 * are column-identical except three deltas, all of which land here in the
 * EXPAND step (migration 0248) so that the later dual-write/backfill/reader
 * cutover PRs have somewhere to write:
 *
 *   1. `userId` relaxed to NULLABLE — agent/system-authored rows (consult
 *      replies, `/help` responses, worker dispatches) have no human author,
 *      and `chat_messages.userId` has always been nullable.
 *   2. `sourceAgentId` adopted — the agent page that authored the row.
 *   3. `pageId` carried TRANSITIONALLY (see the column).
 *
 * ATTRIBUTION RULE (the contract every writer and reader must honour):
 *   - `userId` NOT NULL  ⇒ a human wrote it, and that is who.
 *   - `userId` NULL      ⇒ agent- or system-authored. `sourceAgentId` names
 *                          the authoring agent page WHEN KNOWN; both NULL is
 *                          legal and means "authored by the platform, source
 *                          not recorded".
 *
 * There is DELIBERATELY NO CHECK constraint binding those two columns. The
 * legacy `chat_messages` corpus contains NULL/NULL rows (agent replies
 * written before `sourceAgentId` existed) and the backfill copies them
 * verbatim; a CHECK would either reject the backfill or force us to invent
 * attribution we do not have. The rule is documented and tested, not
 * enforced by the database.
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
  // Lifecycle state of an assistant row from the moment generation starts. See chat_messages.status
  // (packages/db/src/schema/core.ts) for the full contract.
  status: text('status', { enum: ['streaming', 'complete', 'interrupted'] }).default('complete').notNull(),
  /**
   * TRANSITIONAL — carried only so the cutover can copy `chat_messages` rows
   * without losing a column, and DROPPED at the contract PR (Phase 4 PR 15).
   * It is not the source of truth even while it exists: a page conversation's
   * page is `conversations.contextId` (`type='page'`), which is exactly what
   * every reader derives after the cutover. Nothing new may be built on this
   * column.
   *
   * No FK to `pages`, deliberately: an FK on a column scheduled for deletion
   * buys nothing (the authoritative link, `conversations.contextId`, has none
   * either), and its `ON DELETE CASCADE` would add a second, redundant delete
   * path for page teardown during the very window in which both tables hold
   * the same rows.
   */
  pageId: text('pageId'),
  /**
   * The agent page that authored this row, when known. Adopted verbatim from
   * `chat_messages.sourceAgentId`, including its `ON DELETE SET NULL`:
   * deleting an agent must never delete the transcript it produced — the
   * message survives, attributed to nobody (see the attribution rule above).
   */
  sourceAgentId: text('sourceAgentId').references(() => pages.id, { onDelete: 'set null' }),
}, (table) => ({
  conversationIdx: index('messages_conversation_id_idx').on(table.conversationId),
  conversationCreatedAtIdx: index('messages_conversation_id_created_at_idx').on(table.conversationId, table.createdAt),
  userIdx: index('messages_user_id_idx').on(table.userId),
  // Parity with `chat_messages`'s page-scoped access paths, so the reader
  // cutover does not regress page-chat history loads onto sequential scans.
  // CREATED CONDITIONALLY by 0248: below the size gate the migration builds
  // them inline; above it they are built by
  // scripts/deferred-migrations/0248-messages-unification-indexes.sql with
  // CREATE INDEX CONCURRENTLY. Both paths produce these exact names, so this
  // declaration stays the single description of the intended end state.
  pageIdx: index('messages_page_id_idx').on(table.pageId),
  pageIsActiveCreatedAtIdx: index('messages_page_id_is_active_created_at_idx').on(table.pageId, table.isActive, table.createdAt),
}));

// Relations
export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(users, {
    fields: [conversations.userId],
    references: [users.id],
  }),
  session: one(agentSessions, {
    fields: [conversations.sessionId],
    references: [agentSessions.id],
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
  // Mirrors `chatMessagesRelations.sourceAgent` so the reader cutover can
  // move relation-shaped queries across without changing their shape.
  sourceAgent: one(pages, {
    fields: [messages.sourceAgentId],
    references: [pages.id],
    relationName: 'messageSourceAgent',
  }),
}));