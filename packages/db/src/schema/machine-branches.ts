import { pgTable, text, timestamp, index, uniqueIndex, bigint } from 'drizzle-orm/pg-core';
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
  /** The Sprite's NAME (reused across re-creates) — see `spriteInstanceId` for the actual identity. */
  sandboxId: text('sandboxId').notNull(),

  /**
   * The platform's id for the Sprite INSTANCE this row points at — the VM's
   * actual identity. NULL for legacy rows. Comparing `sandboxId` cannot
   * distinguish a replacement Sprite from the one we meant to act on (same name),
   * so every teardown CAS keys on this.
   */
  spriteInstanceId: text('spriteInstanceId'),

  /**
   * When a teardown of this branch's Sprite was REQUESTED — i.e. `deleteMachine`
   * ran and meant to destroy it. NULL = nobody has asked for this Sprite to die.
   *
   * This is an INTENT marker, and it is what the orphan reconciler requires
   * before it destroys anything. "The owning page is trashed" is NOT sufficient
   * intent: `pageService.trashPage` (the generic page DELETE, bulk-delete, and
   * folder cascade-trash) trashes a MACHINE page WITHOUT any teardown, and that
   * trash is reversible — a restore is expected to hand the user back a Machine
   * with its filesystem intact. A `host.kill` is an irreversible DESTROY, so a
   * reconciler keyed on `isTrashed` alone would silently wipe the disk of every
   * Machine anyone ever moved to the trash. See `machine-orphan-reconcile.ts`.
   */
  teardownRequestedAt: timestamp('teardownRequestedAt', { mode: 'date' }),

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

  // ---------------------------------------------------------------------------
  // Storage attribution (issue #2204 phase 3). A branch-terminal's Sprite has
  // its OWN persistent filesystem (see the table doc), so it accrues storage
  // cost independently of the owning Machine's — but it is NOT its own payer or
  // its own line item: the reconcile bills these bytes to `machineId`, the
  // owning Machine page, which is the guardrail/payer key every other
  // branch-scoped cost already uses (services/sandbox/branch-session.ts) and the
  // one field the per-machine usage breakdown groups on. Hence measurement and
  // watermark live HERE (per-Sprite facts — writing them onto the machine's
  // `machine_sessions` row would clobber the machine's own footprint), while
  // attribution resolves to the machine page (machine-storage-attribution.ts).
  // ---------------------------------------------------------------------------

  // Watermark for the storage reconcile, per branch Sprite — same semantics as
  // `machine_sessions.storageLastBilledAt` (bill only the elapsed window, then
  // advance, so overlapping runs never double-bill). Defaults to now() so
  // pre-existing branch rows start accruing from migration time, never
  // retroactively.
  storageLastBilledAt: timestamp('storageLastBilledAt', { mode: 'date' }).defaultNow().notNull(),

  // Measured used BYTES on THIS branch Sprite's filesystem, captured
  // opportunistically while it is already awake for real work (spawn/clone,
  // reattach) — never by waking a hibernating Sprite. NULL = never measured →
  // the reconcile bills a conservative 0 floor for that window (never the
  // provisioned cap).
  storageMeasuredBytes: bigint('storageMeasuredBytes', { mode: 'number' }),
  // When `storageMeasuredBytes` was captured — drives the measurement throttle
  // and the reconcile's staleness signal. NULL alongside NULL bytes = never
  // measured.
  storageMeasuredAt: timestamp('storageMeasuredAt', { mode: 'date' }),

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
