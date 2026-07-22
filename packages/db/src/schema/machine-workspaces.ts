import { pgTable, text, timestamp, jsonb, index, primaryKey } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { pages } from './core';

/**
 * What a pane records about its session — mirrors the client's
 * `PaneSessionScope` (apps/web/src/stores/machine-workspace/workspace-reducer.ts),
 * independently expressed here since `packages/db` cannot depend on `apps/web`.
 *
 * NO project/branch. A pane's checkout is its WORKSPACE's — the `projectName`/
 * `branchName` columns on this very row — so carrying it per pane would be a
 * second copy of one fact, free to disagree with the row that owns it. Rows
 * written before this narrowing may still hold the wider shape; the client
 * projects them on read (`projectStoredPaneScope`), and no backfill is needed
 * because no writer ever produced a pane that disagreed with its workspace.
 */
export interface WorkspaceLayoutScopeDTO {
  name: string;
  /** What the pane renders once bound: a PTY, or the Agent chat UI (#2166).
   * Omitted means `'terminal'`. */
  kind?: 'terminal' | 'chat';
}

export interface WorkspaceLayoutPaneDTO {
  id: string;
  scope: WorkspaceLayoutScopeDTO | null;
}

export interface WorkspaceLayoutColumnDTO {
  id: string;
  panes: WorkspaceLayoutPaneDTO[];
}

/** The shared, structural half of a workspace's grid — see the table doc below
 * for what is deliberately excluded (activePaneId, pendingPickerPaneId, pendingPrompt). */
export interface WorkspaceLayoutDTO {
  columns: WorkspaceLayoutColumnDTO[];
}

/**
 * Machine Workspaces
 *
 * A named, persistent pane grid — the sidebar item under a Machine/Project/
 * Branch node that owns a terminal layout (see `useMachineWorkspaceStore`,
 * `workspace-reducer.ts`). Server-authoritative and broadcast over
 * `apps/realtime` so every browser/user viewing a Machine sees the same
 * workspace list and grid, closing the gap left by PR #2031 (workspace
 * metadata was local-`localStorage`-only).
 *
 * `id` is CLIENT-SUPPLIED, never DB-generated: it is either a
 * `crypto.randomUUID()` (a user-created empty workspace) or the deterministic
 * `sessionWorkspaceId(scope)` (a workspace materialized for a specific
 * session, so reopening that session always resolves to the same workspace).
 * Keeping the client the source of the id means `openTerminal`'s existing
 * "does this session already have a workspace" shortcut needs no separate
 * id-reconciliation layer between client and server.
 *
 * The primary key is the COMPOUND `(machineId, id)`, not `id` alone:
 * `sessionWorkspaceId` derives purely from a session's project/branch/name —
 * it has no machineId in it — so two DIFFERENT Machines can legitimately
 * compute the identical id for their own, unrelated sessions (the same
 * project/branch/session-name text reused across Machines is ordinary, not
 * exceptional). A lone-`id` primary key would treat the second Machine's
 * insert as a duplicate of the first's row, silently misdirecting a create or
 * a lookup to the wrong Machine's workspace.
 *
 * `scope` is an explicit discriminant (`'machine' | 'project' | 'branch'`),
 * mirroring `machine_agent_terminals`, set once at creation and never
 * changed — a workspace's node scope is fixed for its lifetime.
 *
 * `layout` holds ONLY the shared, structural half of a workspace's grid —
 * `{ columns: [{ id, panes: [{ id, scope }] }] }`. `activePaneId` (which pane
 * has focus) and `pendingPickerPaneId`/`pendingPrompt` (transient, one-shot
 * local UI intent) are deliberately NOT part of this row: they are
 * presence-like ("what am I looking at"), stay per-browser, and are never
 * synced — the same treatment `activeWorkspaceId` already gets.
 *
 * No name-uniqueness constraint: nothing client-side stops two workspaces
 * sharing a name after a rename (only auto-naming avoids collisions), so the
 * DB doesn't invent an invariant the client doesn't enforce either.
 */
export const machineWorkspaces = pgTable('machine_workspaces', {
  id: text('id').notNull(),

  ownerId: text('ownerId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  machineId: text('machineId')
    .notNull()
    .references(() => pages.id, { onDelete: 'cascade' }),

  scope: text('scope').notNull(),
  projectName: text('projectName'),
  branchName: text('branchName'),

  name: text('name').notNull(),
  layout: jsonb('layout').$type<WorkspaceLayoutDTO>().notNull(),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  pk: primaryKey({ columns: [table.machineId, table.id] }),
  machineIdIdx: index('machine_workspaces_machine_id_idx').on(table.machineId),
}));

export const machineWorkspacesRelations = relations(machineWorkspaces, ({ one }) => ({
  owner: one(users, {
    fields: [machineWorkspaces.ownerId],
    references: [users.id],
  }),
  machine: one(pages, {
    fields: [machineWorkspaces.machineId],
    references: [pages.id],
  }),
}));

export type MachineWorkspaceRow = typeof machineWorkspaces.$inferSelect;
export type NewMachineWorkspaceRow = typeof machineWorkspaces.$inferInsert;
