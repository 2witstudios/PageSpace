import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { pages } from './core';
import { users } from './auth';

/**
 * Terminal Sessions
 *
 * The sandboxId↔page link for terminal page execution. A page's warm Fly Sprite
 * is addressed by an opaque HMAC session key (see services/sandbox/terminal-session-manager.ts);
 * this table records which `sandboxId` that key resolves to, so returning users
 * reconnect to the same shell/state rather than provisioning a fresh VM each time.
 *
 * One live row per session key (unique) — the key already namespaces by
 * tenant + drive + page. A row is deleted on teardown (idle, session end, crash,
 * failure), so a present row means "this page has a sandbox we believe is live".
 * `lastActiveAt` drives idle reclamation.
 *
 * Resume authorization is NOT encoded here: the lifecycle layer re-runs
 * `canPrincipalEditPage` for the current actor on every request. `userId` is the
 * creating actor, kept for audit only.
 */
export const terminalSessions = pgTable('terminal_sessions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Opaque, unguessable HMAC key — the addressable boundary. Unique: a
  // page resolves to exactly one live terminal sandbox.
  sessionKey: text('sessionKey').notNull().unique(),

  pageId: text('pageId')
    .notNull()
    .references(() => pages.id, { onDelete: 'cascade' }),

  // Creating actor — audit only; resume re-authz is enforced in code per request.
  userId: text('userId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  // Fly Sprite id — used to reconnect and to tear down.
  sandboxId: text('sandboxId').notNull(),

  lastActiveAt: timestamp('lastActiveAt', { mode: 'date' }).defaultNow().notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  sessionKeyIdx: index('terminal_sessions_session_key_idx').on(table.sessionKey),
  pageIdIdx: index('terminal_sessions_page_id_idx').on(table.pageId),
  lastActiveAtIdx: index('terminal_sessions_last_active_at_idx').on(table.lastActiveAt),
}));

export const terminalSessionsRelations = relations(terminalSessions, ({ one }) => ({
  page: one(pages, {
    fields: [terminalSessions.pageId],
    references: [pages.id],
  }),
  user: one(users, {
    fields: [terminalSessions.userId],
    references: [users.id],
  }),
}));

export type TerminalSession = typeof terminalSessions.$inferSelect;
export type NewTerminalSession = typeof terminalSessions.$inferInsert;
