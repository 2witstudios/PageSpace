import { pgTable, text, integer, real, timestamp, bigint, index, primaryKey, foreignKey } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pages } from './core';
import { machineWorkspaces } from './machine-workspaces';

/**
 * Machine Pane Columns / Machine Panes / Machine Workspace Revs
 *
 * The relational successor to `machine_workspaces.layout` (issue #2202): a
 * workspace's grid used to be one client-authored JSONB blob with two
 * independent writers (the browser and the AI session tools) reconciling a
 * full-replace PUT/PATCH. These tables promote that blob's `columns`/`panes`
 * into rows, mutated by ordered, idempotent VERB APIs instead — see
 * `services/machines/machine-panes-store.ts` and
 * `apps/web/src/stores/machine-workspace/workspace-verbs.ts`.
 *
 * `machine_pane_columns` and `machine_panes` are both keyed by the COMPOUND
 * primary key `(machineId, workspaceId, id)`, mirroring `machine_workspaces`'
 * own compound-PK rationale: both `id`s are still CLIENT-MINTED (the client
 * keeps authoring ids so the deterministic `sessionWorkspaceId` "does this
 * session already have a workspace" shortcut needs no server-side id
 * reconciliation layer), so two different workspaces — even on different
 * machines — can legitimately mint the identical column/pane id. Scoping
 * uniqueness under `(machineId, workspaceId)` makes that collision
 * impossible to misdirect into the wrong workspace's grid.
 *
 * The FK to `machine_workspaces` is COMPOSITE, over `(machineId, workspaceId)`
 * against the parent's own compound PK `(machineId, id)` — not a plain FK to
 * a synthetic id — so `ON DELETE CASCADE` on the parent (or on `machineId`
 * cascading from `pages`) removes a workspace's whole grid for free, with no
 * separate cleanup step in `remove-workspace`.
 *
 * `orderIndex` is a plain, contiguous 0-based integer, renumbered by whichever
 * verb changes sibling order (grids are small — renumbering is O(siblings)
 * inside the same rev-locked transaction, not fractional-key machinery).
 *
 * `widthFraction` (columns) / `heightFraction` (panes) are RESERVED for the
 * deferred layout-rearrange verbs (issue #2208 — resize). Nullable and unread
 * by this epic; adding #2208's resize verb is then a read of an existing
 * column, not a migration.
 *
 * A pane's `sessionName`/`sessionKind` mirror the blob's narrowed
 * `WorkspaceLayoutScopeDTO` — NO project/branch on a pane: a pane's checkout
 * is its WORKSPACE's (`machine_workspaces.projectName`/`branchName`), so
 * carrying it again per pane would be a second copy of one fact, free to
 * disagree with the row that owns it. `sessionName: null` is an unbound
 * (picker) pane; `sessionKind: null` while bound means `'terminal'`
 * (omitted-means-terminal, same convention as the blob DTO).
 *
 * `machine_workspace_revs` is the per-MACHINE monotonic mutation counter —
 * not per-workspace, because ordering a `remove-workspace` against a late
 * `updated` for the SAME machine, and the fact that a removed workspace's
 * deterministic id can be RECREATED later, both need one counter that spans
 * every workspace on the machine, not a counter that resets per workspace.
 * Every verb's transaction mints its rev via
 * `INSERT ... ON CONFLICT (machineId) DO UPDATE SET rev = rev + 1 RETURNING
 * rev`, which doubles as the row-level lock serializing concurrent verbs on
 * one machine.
 */
export const machinePaneColumns = pgTable('machine_pane_columns', {
  id: text('id').notNull(),
  machineId: text('machineId').notNull(),
  workspaceId: text('workspaceId').notNull(),

  orderIndex: integer('orderIndex').notNull(),
  widthFraction: real('widthFraction'),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  pk: primaryKey({ columns: [table.machineId, table.workspaceId, table.id] }),
  workspaceFk: foreignKey({
    columns: [table.machineId, table.workspaceId],
    foreignColumns: [machineWorkspaces.machineId, machineWorkspaces.id],
  }).onDelete('cascade'),
  workspaceIdx: index('machine_pane_columns_workspace_idx').on(table.machineId, table.workspaceId),
}));

export const machinePanes = pgTable('machine_panes', {
  id: text('id').notNull(),
  machineId: text('machineId').notNull(),
  workspaceId: text('workspaceId').notNull(),
  columnId: text('columnId').notNull(),

  orderIndex: integer('orderIndex').notNull(),
  sessionName: text('sessionName'),
  sessionKind: text('sessionKind'),
  heightFraction: real('heightFraction'),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  pk: primaryKey({ columns: [table.machineId, table.workspaceId, table.id] }),
  columnFk: foreignKey({
    columns: [table.machineId, table.workspaceId, table.columnId],
    foreignColumns: [machinePaneColumns.machineId, machinePaneColumns.workspaceId, machinePaneColumns.id],
  }).onDelete('cascade'),
  workspaceIdx: index('machine_panes_workspace_idx').on(table.machineId, table.workspaceId),
}));

export const machineWorkspaceRevs = pgTable('machine_workspace_revs', {
  machineId: text('machineId')
    .primaryKey()
    .references(() => pages.id, { onDelete: 'cascade' }),
  rev: bigint('rev', { mode: 'number' }).notNull().default(0),
});

export const machinePaneColumnsRelations = relations(machinePaneColumns, ({ one, many }) => ({
  workspace: one(machineWorkspaces, {
    fields: [machinePaneColumns.machineId, machinePaneColumns.workspaceId],
    references: [machineWorkspaces.machineId, machineWorkspaces.id],
  }),
  panes: many(machinePanes),
}));

export const machinePanesRelations = relations(machinePanes, ({ one }) => ({
  column: one(machinePaneColumns, {
    fields: [machinePanes.machineId, machinePanes.workspaceId, machinePanes.columnId],
    references: [machinePaneColumns.machineId, machinePaneColumns.workspaceId, machinePaneColumns.id],
  }),
}));

export const machineWorkspaceRevsRelations = relations(machineWorkspaceRevs, ({ one }) => ({
  machine: one(pages, {
    fields: [machineWorkspaceRevs.machineId],
    references: [pages.id],
  }),
}));

export type MachinePaneColumnRow = typeof machinePaneColumns.$inferSelect;
export type NewMachinePaneColumnRow = typeof machinePaneColumns.$inferInsert;
export type MachinePaneRow = typeof machinePanes.$inferSelect;
export type NewMachinePaneRow = typeof machinePanes.$inferInsert;
export type MachineWorkspaceRevRow = typeof machineWorkspaceRevs.$inferSelect;
