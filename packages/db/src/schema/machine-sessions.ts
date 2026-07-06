import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';

/**
 * Machine Sessions
 *
 * The sandboxId↔machine link for a "Machine" (a Sprite with a persistent
 * filesystem — see services/machines/machine-identity.ts). A machine's warm
 * Sprite is addressed by an opaque HMAC session key (see
 * services/machines/machine-session-manager.ts); this table records which
 * `sandboxId` that key currently resolves to, so Project operations (clone,
 * remove) reconnect to the same persistent filesystem instead of provisioning
 * a fresh VM each time.
 *
 * One live row per session key (unique) — the key already namespaces the
 * machine identity (a user's own machine, or a Terminal page's shared
 * machine). A row is deleted on teardown; `lastActiveAt` drives idle
 * reclamation (machines hibernate rather than tear down — see `persistent`
 * in planTerminalLifecycle, reused here).
 *
 * Resume authorization is NOT encoded here: callers re-check access for the
 * current actor on every request. `ownerId` is the creating actor, kept for
 * audit only.
 */
export const machineSessions = pgTable('machine_sessions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Opaque, unguessable HMAC key — the addressable boundary. Unique: a
  // machine identity resolves to exactly one live sandbox.
  sessionKey: text('sessionKey').notNull().unique(),

  // Creating actor — audit only; resume re-authz is enforced in code per request.
  ownerId: text('ownerId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  // Fly Sprite id — used to reconnect and to tear down.
  sandboxId: text('sandboxId').notNull(),

  lastActiveAt: timestamp('lastActiveAt', { mode: 'date' }).defaultNow().notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  lastActiveAtIdx: index('machine_sessions_last_active_at_idx').on(table.lastActiveAt),
}));

export const machineSessionsRelations = relations(machineSessions, ({ one }) => ({
  owner: one(users, {
    fields: [machineSessions.ownerId],
    references: [users.id],
  }),
}));

export type MachineSession = typeof machineSessions.$inferSelect;
export type NewMachineSession = typeof machineSessions.$inferInsert;
