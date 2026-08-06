import { pgTable, text, timestamp, jsonb, boolean, bigint, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
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
 * Unified messages table for all conversation types
 */
export const messages = pgTable('messages', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  conversationId: text('conversationId').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
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
}, (table) => ({
  conversationIdx: index('messages_conversation_id_idx').on(table.conversationId),
  conversationCreatedAtIdx: index('messages_conversation_id_created_at_idx').on(table.conversationId, table.createdAt),
  userIdx: index('messages_user_id_idx').on(table.userId),
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
}));