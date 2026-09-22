import { pgTable, text, timestamp, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { conversations } from './conversations';

/**
 * Tool approvals — the human-in-the-loop gate for agent writes.
 *
 * The PAUSE is the AI SDK's own `needsApproval` (a `tool-approval-request` on
 * the assistant message, persisted on the message's tool-call row). These two
 * tables hold what the message cannot: the user's standing GRANTS, and the
 * atomic record of each DECISION so a write can never execute twice.
 */

/**
 * "Allow `tool_name`" standing grants. `conversation_id` NULL = "always allow"
 * for this user; set = "allow for this conversation" only. Read per turn into
 * the approval policy (`apps/web/src/lib/ai/approvals/approval-policy.ts`) and
 * revocable from settings. The unique index is the idempotency key for
 * `addGrant` — a second "always allow" click is a no-op, not a duplicate row.
 */
export const aiToolApprovalGrants = pgTable('ai_tool_approval_grants', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  toolName: text('tool_name').notNull(),
  // A conversation-scoped grant dies with its conversation; a user-wide one has no conversation.
  conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  // Postgres treats NULLs as distinct in a plain unique index, so a user-wide
  // grant is deduplicated by the partial index below and the composite here
  // covers the conversation-scoped ones.
  userToolConversationIdx: uniqueIndex('ai_tool_approval_grants_user_tool_conv_idx')
    .on(table.userId, table.toolName, table.conversationId),
  userToolAlwaysIdx: uniqueIndex('ai_tool_approval_grants_user_tool_always_idx')
    .on(table.userId, table.toolName)
    .where(sql`conversation_id IS NULL`),
  userIdx: index('ai_tool_approval_grants_user_idx').on(table.userId),
}));

/**
 * One row per approval id: the ATOMIC CLAIM and the audit log.
 *
 * WHY A TABLE AND NOT THE MESSAGE ROW. The ask_user resume is an unlocked
 * fetch→merge→persist (documented in `core/ask-user-resume.ts`); its worst case is
 * a dropped answer. For approvals the worst case is EXECUTING A WRITE TWICE — two
 * tabs approving the same call, or an approve racing a typed message that denies
 * it. `INSERT … ON CONFLICT (approval_id) DO NOTHING RETURNING` decides exactly
 * one winner without threading a transaction through the shared message
 * repository. The typed-message dismiss path inserts `approved = false` the same
 * way, so "resume while a typed message arrives" resolves to one decision.
 *
 * `approval_id` is minted by the SDK when the step pauses and persisted on the
 * message's tool-call row; the client echoes it and the resume refuses a
 * mismatch, so a stale card cannot approve a different call.
 */
export const aiToolApprovalDecisions = pgTable('ai_tool_approval_decisions', {
  approvalId: text('approval_id').primaryKey(),
  toolCallId: text('tool_call_id').notNull(),
  toolName: text('tool_name').notNull(),
  messageId: text('message_id').notNull(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  approved: boolean('approved').notNull(),
  /** The user's optional reason on Deny, or the system's reason for a synthesized denial (typed message, stale card). */
  reason: text('reason'),
  /** 'once' | 'conversation' | 'always' for an approval; NULL for a denial. */
  scope: text('scope', { enum: ['once', 'conversation', 'always'] }),
  decidedAt: timestamp('decided_at', { mode: 'date' }).defaultNow().notNull(),
  /** Set when the approved call finished running (or was refused at execution time). */
  executedAt: timestamp('executed_at', { mode: 'date' }),
  /**
   * What actually happened to the call — and the ARBITER between a dismiss and
   * an execution: NULL → 'running' (turn started it) | 'stale' (dismiss closed
   * it first); 'running' | 'stale' → 'ok' | 'error' (truth wins over stale).
   * 'denied' is written with the denial claim itself.
   */
  outcome: text('outcome', { enum: ['ok', 'error', 'denied', 'stale', 'running'] }),
}, (table) => ({
  conversationIdx: index('ai_tool_approval_decisions_conversation_idx').on(table.conversationId),
  messageIdx: index('ai_tool_approval_decisions_message_idx').on(table.messageId),
}));
