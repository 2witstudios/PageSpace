import { pgTable, text, integer, real, timestamp, bigint, boolean, index, primaryKey, foreignKey } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { agentWorkspaces } from './agent-workspaces';

/**
 * Agent Workspace Pane Columns / Panes / Layout Revs / Layout Ops
 *
 * The relational successor to `agent_workspaces.workspaceState` (epic Phase 3,
 * mirroring the #2202 machine-panes promotion): a workspace's pane grid used
 * to be one client-authored JSONB blob with exactly one writer (the browser's
 * debounced full-replace PUT). These tables promote the blob's
 * `columns`/`panes` into rows, mutated by ordered, idempotent VERB writes —
 * see `@pagespace/lib/agent-workspaces/workspace-layout-verbs.ts` (the pure
 * engine) and `@pagespace/lib/services/agent-workspaces/workspace-layout-store.ts`
 * (the one write primitive). `workspaceState` was kept one release as the
 * rolling-deploy shim and DROPPED at the contract step (migration 0250, with
 * a final sweep and a refuses-to-drop guard); these rows are now the only
 * representation of a pane grid that exists.
 *
 * Column and pane `id`s are CLIENT-MINTED (the browser keeps authoring ids so
 * optimistic local application needs no server round-trip for identity), so
 * two different workspaces can legitimately mint the identical id. Scoping
 * the primary key as the COMPOUND `(workspaceId, id)` makes that collision
 * impossible to misdirect into another workspace's grid. Unlike the machine
 * tables there is no third key component: a session (the workspace unit) has
 * no parent tier the way a machine workspace had a machine.
 *
 * `orderIndex` is a plain, contiguous 0-based integer, renumbered by whichever
 * verb changes sibling order (grids are small — renumbering is O(siblings)
 * inside the same rev-locked transaction, not fractional-key machinery).
 *
 * `widthFraction` (columns) / `heightFraction` (panes) are RESERVED for
 * deferred resize verbs. Nullable and unread today; adding resize later is a
 * read of an existing column, not a migration.
 *
 * A pane's `kind`/`targetId` mirror the blob's `PaneScope` STRUCTURALLY only —
 * deliberately NO `name` and NO `agentPageId` on pane rows: both are derived
 * at read time (the layout GET joins conversation/shell/page titles, and
 * `agentPageId` is a fact of the conversation row itself), which kills the
 * stale-pane-label drift class the blob carried. `targetId` is polymorphic
 * (conversationId | shellId | pageId by `kind`) and deliberately has NO FK:
 * a pane pointing at a deleted target repairs at read/bind time exactly as
 * the blob did — deleting a conversation must never take a layout row with
 * it. `kind IS NULL` (with `targetId IS NULL`) is an unbound picker pane.
 * `activePaneId`/`pendingPickerPaneId` are NOT persisted here — client-local
 * view state, per the machines decision (focus does not restore cross-device).
 *
 * `agent_workspace_layout_revs` is the per-WORKSPACE monotonic mutation
 * counter. The rev lives in its OWN table — NOT as a column on
 * `agent_workspaces` — so the verb write's
 * `INSERT ... ON CONFLICT ("workspaceId") DO UPDATE SET rev = rev + 1
 * RETURNING rev` (which doubles as the serializing row lock, per the machine
 * pattern) never takes a lock on the `agent_workspaces` row that sandbox
 * teardown/ensure CAS writes contend on: a layout split must never queue
 * behind a Sprite provisioning transaction, or vice versa.
 *
 * `agent_workspace_layout_ops` is the verb route's idempotency memory: one
 * row per recently-processed `(workspaceId, opId)`, recording the rev the op
 * observed/produced and whether it changed anything. A retried POST (client
 * timeout, duplicate delivery) finds its row and short-circuits instead of
 * re-applying — which matters because a replayed `split_right` would try to
 * re-insert its already-inserted client-minted pane id and violate the PK.
 * Rows are pruned opportunistically on write (retries arrive within seconds;
 * the store keeps a generous 24h window) — see the store's `recordOp`.
 */
export const agentWorkspacePaneColumns = pgTable('agent_workspace_pane_columns', {
  /** Client-minted column id — unique per workspace only (compound PK). */
  id: text('id').notNull(),
  /** The owning workspace (`agent_workspaces.id`). */
  workspaceId: text('workspaceId')
    .notNull()
    .references(() => agentWorkspaces.id, { onDelete: 'cascade' }),

  /** Contiguous 0-based position among the workspace's columns; renumbered by verbs. */
  orderIndex: integer('orderIndex').notNull(),
  /** RESERVED for resize verbs. Nullable and unread today. */
  widthFraction: real('widthFraction'),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.id] }),
  workspaceIdx: index('agent_workspace_pane_columns_workspace_idx').on(table.workspaceId),
}));

export const agentWorkspacePanes = pgTable('agent_workspace_panes', {
  /** Client-minted pane id — unique per workspace only (compound PK). */
  id: text('id').notNull(),
  /** The owning workspace (`agent_workspaces.id`). */
  workspaceId: text('workspaceId').notNull(),
  /** The owning column (`agent_workspace_pane_columns.id`, same workspace). */
  columnId: text('columnId').notNull(),

  /** Contiguous 0-based position within the column; renumbered by verbs. */
  orderIndex: integer('orderIndex').notNull(),
  /** `'chat' | 'terminal' | 'page'`; NULL = unbound picker pane. */
  kind: text('kind'),
  /** conversationId | shellId | pageId by `kind` — polymorphic, deliberately NO FK (see module doc). */
  targetId: text('targetId'),
  /** RESERVED for resize verbs. Nullable and unread today. */
  heightFraction: real('heightFraction'),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.id] }),
  // Composite FK to the column's own compound PK — cascading, so deleting a
  // column (or the whole workspace, cascading from `agent_workspaces`) removes
  // its panes with no separate cleanup step.
  columnFk: foreignKey({
    columns: [table.workspaceId, table.columnId],
    foreignColumns: [agentWorkspacePaneColumns.workspaceId, agentWorkspacePaneColumns.id],
  }).onDelete('cascade'),
  workspaceIdx: index('agent_workspace_panes_workspace_idx').on(table.workspaceId),
}));

export const agentWorkspaceLayoutRevs = pgTable('agent_workspace_layout_revs', {
  workspaceId: text('workspaceId')
    .primaryKey()
    .references(() => agentWorkspaces.id, { onDelete: 'cascade' }),
  /** Monotonic per-workspace mutation counter; 0 = no verb has ever applied. */
  rev: bigint('rev', { mode: 'number' }).notNull().default(0),
});

export const agentWorkspaceLayoutOps = pgTable('agent_workspace_layout_ops', {
  workspaceId: text('workspaceId')
    .notNull()
    .references(() => agentWorkspaces.id, { onDelete: 'cascade' }),
  /** Client-minted operation id — the verb POST's idempotency key. */
  opId: text('opId').notNull(),
  /** The rev this op produced (or observed, for a no-op). */
  rev: bigint('rev', { mode: 'number' }).notNull(),
  /** Whether the op actually changed the grid (mirrors the write's content diff). */
  applied: boolean('applied').notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.opId] }),
}));

export const agentWorkspacePaneColumnsRelations = relations(agentWorkspacePaneColumns, ({ one, many }) => ({
  workspace: one(agentWorkspaces, {
    fields: [agentWorkspacePaneColumns.workspaceId],
    references: [agentWorkspaces.id],
  }),
  panes: many(agentWorkspacePanes),
}));

export const agentWorkspacePanesRelations = relations(agentWorkspacePanes, ({ one }) => ({
  column: one(agentWorkspacePaneColumns, {
    fields: [agentWorkspacePanes.workspaceId, agentWorkspacePanes.columnId],
    references: [agentWorkspacePaneColumns.workspaceId, agentWorkspacePaneColumns.id],
  }),
}));

export const agentWorkspaceLayoutRevsRelations = relations(agentWorkspaceLayoutRevs, ({ one }) => ({
  workspace: one(agentWorkspaces, {
    fields: [agentWorkspaceLayoutRevs.workspaceId],
    references: [agentWorkspaces.id],
  }),
}));

export const agentWorkspaceLayoutOpsRelations = relations(agentWorkspaceLayoutOps, ({ one }) => ({
  workspace: one(agentWorkspaces, {
    fields: [agentWorkspaceLayoutOps.workspaceId],
    references: [agentWorkspaces.id],
  }),
}));

export type AgentWorkspacePaneColumnRow = typeof agentWorkspacePaneColumns.$inferSelect;
export type NewAgentWorkspacePaneColumnRow = typeof agentWorkspacePaneColumns.$inferInsert;
export type AgentWorkspacePaneRow = typeof agentWorkspacePanes.$inferSelect;
export type NewAgentWorkspacePaneRow = typeof agentWorkspacePanes.$inferInsert;
export type AgentWorkspaceLayoutRevRow = typeof agentWorkspaceLayoutRevs.$inferSelect;
export type AgentWorkspaceLayoutOpRow = typeof agentWorkspaceLayoutOps.$inferSelect;
