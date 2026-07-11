import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { pages } from './core';

/**
 * Machine Branches
 *
 * The "Branches" tier of the Terminal workspace navigator (Machine → Projects
 * → Branches). A branch-terminal is an isolated checked-out branch of a
 * Project (`machine_projects`) — but UNLIKE a Project, it is NOT cloned onto
 * the owning Machine's own filesystem. Each branch-terminal gets its OWN,
 * SEPARATE Sprite (see services/machines/branch-session.ts /
 * machine-branches.ts): on Sprites the container IS the Sprite, so real
 * isolation between two branches of the same project means two distinct
 * Sprites, never a shared filesystem.
 *
 * Addressed by (machineId, projectName, branchName) — the same
 * (machineId, name) identity Projects already use, rather than a
 * project-row id FK, so this stays consistent with how `machine_projects` is
 * looked up everywhere else and needs no join to resolve a project's
 * `repoUrl` before cloning. `sessionKey` is the opaque HMAC name this
 * branch's Sprite is provisioned under (`deriveBranchSessionKey`) — unique
 * per row, and distinct per branch, so two branches never resolve to the
 * same underlying Sprite. `sandboxId` is that Sprite's id, used to
 * reconnect/kill it directly through the MachineHost seam.
 */
export const machineBranches = pgTable('machine_branches', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  ownerId: text('ownerId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  machineId: text('machineId')
    .notNull()
    .references(() => pages.id, { onDelete: 'cascade' }),

  projectName: text('projectName').notNull(),
  branchName: text('branchName').notNull(),

  sessionKey: text('sessionKey').notNull().unique(),
  sandboxId: text('sandboxId').notNull(),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  machineIdIdx: index('machine_branches_machine_id_idx').on(table.machineId),
  machineProjectBranchUnique: uniqueIndex('machine_branches_machine_project_branch_idx').on(
    table.machineId,
    table.projectName,
    table.branchName,
  ),
}));

export const machineBranchesRelations = relations(machineBranches, ({ one }) => ({
  owner: one(users, {
    fields: [machineBranches.ownerId],
    references: [users.id],
  }),
  machine: one(pages, {
    fields: [machineBranches.machineId],
    references: [pages.id],
  }),
}));

export type MachineBranch = typeof machineBranches.$inferSelect;
export type NewMachineBranch = typeof machineBranches.$inferInsert;
