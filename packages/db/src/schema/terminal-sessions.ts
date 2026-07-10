import { pgTable, text, timestamp, bigint, index } from 'drizzle-orm/pg-core';
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

  // Watermark for the idle-storage reconcile cron (Terminal Epic 3): the
  // persistent filesystem accrues cost whether the Machine is active or
  // hibernating, so this is billed separately from active-runtime — see
  // packages/lib/src/services/sandbox/terminal-storage-reconcile.ts. Each run
  // bills only the elapsed window since this watermark, then advances it, so
  // repeated/overlapping runs never double-bill (idempotent by construction).
  // Defaults to now() so pre-existing rows start accruing from migration time
  // rather than requiring a backfill.
  storageLastBilledAt: timestamp('storageLastBilledAt', { mode: 'date' }).defaultNow().notNull(),

  // Measured persistent-storage usage, in BYTES, captured opportunistically
  // while the machine is already awake for real work (terminal connect, agent
  // run, file browse) — never by waking a paused sprite. The storage reconcile
  // (terminal-storage-reconcile.ts) bills these MEASURED bytes, not the
  // provisioned allocation: the platform charges for bytes actually written
  // (TRIM-friendly), not the full volume size (docs.sprites.dev/concepts/lifecycle).
  // NULL = never measured yet → the reconcile bills a conservative 0 floor for
  // that window (it does NOT fall back to the provisioned cap, the old bug).
  storageMeasuredBytes: bigint('storageMeasuredBytes', { mode: 'number' }),
  // When `storageMeasuredBytes` was last captured — drives the measurement
  // throttle (at most one measure per machine per window) and the reconcile's
  // staleness signal. NULL alongside a NULL byte count means never measured.
  storageMeasuredAt: timestamp('storageMeasuredAt', { mode: 'date' }),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
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
