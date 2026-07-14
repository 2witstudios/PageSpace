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

  /**
   * When this row's `sandboxId` Sprite was CONFIRMED destroyed (Machine page
   * trashed, or the orphan reconciler reclaimed it). NULL = we believe a live
   * Sprite exists under `sandboxId`.
   *
   * This is the pending-teardown signal, and it is a COLUMN rather than the
   * row's mere existence because the row outlives its Sprite ON PURPOSE. A
   * branch row is re-creatable CONFIGURATION, not just a pointer: `spawnBranch`
   * re-provisions a vanished branch under the same `sessionKey` and re-clones
   * from the project's `repoUrl`. Deleting the row on teardown would therefore
   * destroy the user's branch-terminal config on a REVERSIBLE soft-delete — and
   * would cascade-delete its branch-scoped `machine_agent_terminals` rows
   * (FK `onDelete: 'cascade'`) along with it, so a restore would bring the
   * Machine back without its branch terminals.
   *
   * So: teardown kills the Sprite and STAMPS this column, keeping the row. The
   * orphan reconciler
   * (`@pagespace/lib/services/machines/machine-orphan-reconcile`) reclaims rows
   * that are still NULL under a trashed page, and the 30-day hard purge blocks
   * only on those — a torn-down row never blocks the purge, and its eventual
   * FK-cascade at hard-purge time is correct (the page is being erased).
   * Cleared back to NULL by `updateSandboxId` when a re-provision records a new
   * live Sprite.
   */
  spriteTornDownAt: timestamp('spriteTornDownAt', { mode: 'date' }),

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
