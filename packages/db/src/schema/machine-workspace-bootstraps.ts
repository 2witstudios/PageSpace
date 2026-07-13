import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { pages } from './core';

/**
 * Machine Workspace Bootstraps
 *
 * The permanent claim record for "has this machine's local-only
 * (`localStorage`) workspace history already been seeded into
 * `machine_workspaces`". One row per machine, inserted exactly once via
 * `ON CONFLICT (machineId) DO NOTHING` — the browser whose insert actually
 * lands is the sole writer of the initial server-side workspace list;
 * every other browser racing the same first-load window just adopts
 * whatever the winner published.
 *
 * Deliberately decoupled from `machine_workspaces`' current row COUNT: a
 * machine legitimately reduced to zero live workspaces (its only one was
 * deleted) must never be mistaken for "never bootstrapped" and reseeded
 * with a stale local copy. This table is the single source of truth for
 * that distinction, checked independently of how many workspace rows exist
 * right now.
 */
export const machineWorkspaceBootstraps = pgTable('machine_workspace_bootstraps', {
  machineId: text('machineId')
    .primaryKey()
    .references(() => pages.id, { onDelete: 'cascade' }),

  bootstrappedByUserId: text('bootstrappedByUserId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  bootstrappedAt: timestamp('bootstrappedAt', { mode: 'date' }).defaultNow().notNull(),
});

export const machineWorkspaceBootstrapsRelations = relations(machineWorkspaceBootstraps, ({ one }) => ({
  machine: one(pages, {
    fields: [machineWorkspaceBootstraps.machineId],
    references: [pages.id],
  }),
  bootstrappedBy: one(users, {
    fields: [machineWorkspaceBootstraps.bootstrappedByUserId],
    references: [users.id],
  }),
}));

export type MachineWorkspaceBootstrap = typeof machineWorkspaceBootstraps.$inferSelect;
export type NewMachineWorkspaceBootstrap = typeof machineWorkspaceBootstraps.$inferInsert;
