import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { pages } from './core';

/**
 * Machine Projects
 *
 * A git repo checked out on a Machine's persistent filesystem — the
 * "Projects" tier of the Terminal workspace navigator (Machine → Projects →
 * Branches). A Machine's identity IS its backing page (`machineId`): the
 * page's persistent Sprite session (`machine_sessions`, services/sandbox/
 * machine-session-manager.ts) is the same one a live Terminal shell or a
 * page-agent's "own machine" tool calls already reconnect to — Projects are
 * cloned onto that SAME filesystem, not a separate one. `ownerId` is the
 * actor who added the project, kept for audit only — resource-level access is
 * governed by page permissions on `machineId`.
 *
 * `path` is the absolute directory on the Sprite's filesystem the repo was
 * cloned into (always under services/machines/project-paths.ts#PROJECTS_ROOT),
 * and is unique PER ROW: `<name>-<id>` (services/machines/
 * project-paths.ts#resolveProjectClonePath), so two operations can never own
 * the same directory. Rows created before per-row paths are plain `<name>` —
 * both resolve the same way, because every consumer reads this persisted
 * column rather than re-deriving a path from the name. One row per
 * (machineId, name) — a machine cannot have two projects with the same name.
 */
export const machineProjects = pgTable('machine_projects', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  ownerId: text('ownerId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  machineId: text('machineId')
    .notNull()
    .references(() => pages.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  repoUrl: text('repoUrl').notNull(),
  path: text('path').notNull(),

  // ---------------------------------------------------------------------------
  // Lazy project-Sprite promotion (issue #2204 phase 7). A project starts life
  // as a plain checkout on the OWNING Machine's own Sprite (`path` above) and
  // stays that way until the first project-scoped spawn PROMOTES it: from then
  // on it is its own isolated Sprite, exactly like a branch-terminal, and every
  // resolution (agent tools + the realtime PTY bridge) flips to that Sprite with
  // cwd `/workspace/repo`.
  //
  // These five columns are deliberately the SAME identity set
  // `machine_branches` carries (see that table's docs for the full reasoning on
  // each) — promotion is `spawnBranch`'s provisioning template generalized, so
  // the teardown CAS, the orphan reconciler and the hard-purge guard can treat a
  // promoted project exactly as they treat a branch. All NULLABLE: NULL
  // `sandboxId` IS the "unpromoted" state, and it is what every promotion CAS
  // compares against, so a promotion can never silently overwrite another's.
  // ---------------------------------------------------------------------------

  /**
   * The opaque HMAC name this project's OWN Sprite is provisioned under
   * (`deriveProjectSessionKey`, namespace `project-session:v1`) — unique per
   * row and distinct from any branch's, so `MachineHost.provision` (which
   * auto-resumes "same name, same filesystem") can never hand a project and a
   * branch the same underlying Sprite. NULL until first promotion.
   */
  sessionKey: text('sessionKey').unique(),

  /** The promoted Sprite's NAME (reused across re-creates) — NULL = unpromoted. See `spriteInstanceId` for the actual VM identity. */
  sandboxId: text('sandboxId'),

  /**
   * The platform's id for the Sprite INSTANCE this row points at. `sandboxId`
   * is a reused name and cannot distinguish a replacement VM from the one we
   * meant to act on, so every teardown CAS keys on this.
   */
  spriteInstanceId: text('spriteInstanceId'),

  /**
   * When a teardown of this project's Sprite was REQUESTED — the INTENT marker
   * the orphan reconciler requires before destroying anything. "The owning page
   * is trashed" is NOT sufficient intent (trash is reversible; a `host.kill` is
   * not) — see the identical column on `machine_branches`.
   */
  teardownRequestedAt: timestamp('teardownRequestedAt', { mode: 'date' }),

  /**
   * When `sandboxId`'s Sprite was CONFIRMED destroyed. NULL = we believe a live
   * Sprite exists under `sandboxId`. A promoted project's row OUTLIVES its
   * Sprite on purpose (the row is re-creatable configuration: `repoUrl` +
   * `sessionKey` are enough to re-provision and re-clone), and deleting it would
   * destroy the user's project and cascade its scoped `machine_agent_terminals`
   * rows away with it.
   */
  spriteTornDownAt: timestamp('spriteTornDownAt', { mode: 'date' }),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  machineIdIdx: index('machine_projects_machine_id_idx').on(table.machineId),
  machineIdNameUnique: uniqueIndex('machine_projects_machine_id_name_idx').on(table.machineId, table.name),
}));

export const machineProjectsRelations = relations(machineProjects, ({ one }) => ({
  owner: one(users, {
    fields: [machineProjects.ownerId],
    references: [users.id],
  }),
  machine: one(pages, {
    fields: [machineProjects.machineId],
    references: [pages.id],
  }),
}));

export type MachineProject = typeof machineProjects.$inferSelect;
export type NewMachineProject = typeof machineProjects.$inferInsert;
