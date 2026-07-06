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
 * Branches). `machineKey` is the addressable machine identity (see
 * services/machines/machine-identity.ts: `own:<ownerId>` for a user's own
 * machine, `existing:<terminalId>` for a Terminal page's shared machine) —
 * `machineKind`/`terminalId` are kept alongside it (denormalized) so the
 * machine a project belongs to can be queried/joined without re-parsing the
 * key. `ownerId` is the actor who added the project, kept for audit only —
 * resource-level access is governed by page permissions on `terminalId` for
 * 'existing' machines, and by `ownerId` itself for 'own' machines.
 *
 * `path` is the absolute directory on the Sprite's filesystem the repo was
 * cloned into (always under services/machines/project-paths.ts#PROJECTS_ROOT).
 * One row per (machine, name) — a machine cannot have two projects with the
 * same directory name.
 */
export const machineProjects = pgTable('machine_projects', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  ownerId: text('ownerId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  machineKind: text('machineKind', { enum: ['own', 'existing'] }).notNull(),
  // Only set when machineKind = 'existing'.
  terminalId: text('terminalId').references(() => pages.id, { onDelete: 'cascade' }),

  // Derived, stable identity for the owning machine — see deriveMachineKey.
  machineKey: text('machineKey').notNull(),

  name: text('name').notNull(),
  repoUrl: text('repoUrl').notNull(),
  path: text('path').notNull(),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  machineKeyIdx: index('machine_projects_machine_key_idx').on(table.machineKey),
  machineKeyNameUnique: uniqueIndex('machine_projects_machine_key_name_idx').on(table.machineKey, table.name),
}));

export const machineProjectsRelations = relations(machineProjects, ({ one }) => ({
  owner: one(users, {
    fields: [machineProjects.ownerId],
    references: [users.id],
  }),
  terminal: one(pages, {
    fields: [machineProjects.terminalId],
    references: [pages.id],
  }),
}));

export type MachineProject = typeof machineProjects.$inferSelect;
export type NewMachineProject = typeof machineProjects.$inferInsert;
