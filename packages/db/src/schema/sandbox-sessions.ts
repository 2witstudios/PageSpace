import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { conversations } from './conversations';
import { users } from './auth';
import { drives } from './core';

/**
 * Sandbox Sessions
 *
 * The sandboxId↔conversation link for agent code execution. A conversation's
 * warm Vercel Sandbox is addressed by an opaque HMAC session key (see
 * services/sandbox/session-key.ts); this table records which `sandboxId` that
 * key currently resolves to, so later turns reconnect to the same shell/state
 * instead of provisioning a fresh VM each turn.
 *
 * One live row per session key (unique) — the key already namespaces by
 * tenant + drive + conversation. A row is deleted on teardown (idle, session
 * end, crash, failure), so a present row means "this conversation has a sandbox
 * we believe is live". `lastActiveAt` drives idle reclamation.
 *
 * Resume authorization is NOT encoded here: the lifecycle layer re-runs
 * `canRunCode` for the current actor on every resume. `userId` is the creating
 * actor, kept for audit only.
 */
export const sandboxSessions = pgTable('sandbox_sessions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Opaque, unguessable HMAC key — the addressable boundary. Unique: a
  // conversation resolves to exactly one live sandbox.
  sessionKey: text('sessionKey').notNull().unique(),

  conversationId: text('conversationId')
    .notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  // Namespacing context, retained for cleanup queries and audit. Nullable so a
  // future non-drive-scoped conversation can still hold a session.
  driveId: text('driveId').references(() => drives.id, { onDelete: 'cascade' }),
  tenantId: text('tenantId'),

  // Creating actor — audit only; resume re-authz is enforced in code per turn.
  userId: text('userId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  // Vercel sandbox id — used to reconnect and to tear down.
  sandboxId: text('sandboxId').notNull(),

  lastActiveAt: timestamp('lastActiveAt', { mode: 'date' }).defaultNow().notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  conversationIdx: index('sandbox_sessions_conversation_id_idx').on(table.conversationId),
  // Supports idle-reclamation sweeps over stale sessions.
  lastActiveIdx: index('sandbox_sessions_last_active_at_idx').on(table.lastActiveAt),
}));

export const sandboxSessionsRelations = relations(sandboxSessions, ({ one }) => ({
  conversation: one(conversations, {
    fields: [sandboxSessions.conversationId],
    references: [conversations.id],
  }),
  user: one(users, {
    fields: [sandboxSessions.userId],
    references: [users.id],
  }),
}));

export type SandboxSession = typeof sandboxSessions.$inferSelect;
export type NewSandboxSession = typeof sandboxSessions.$inferInsert;
