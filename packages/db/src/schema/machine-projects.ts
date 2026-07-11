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
 * cloned into (always under services/machines/project-paths.ts#PROJECTS_ROOT).
 * One row per (machineId, name) — a machine cannot have two projects with
 * the same directory name.
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
