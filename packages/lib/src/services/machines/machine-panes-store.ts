/**
 * Machine Panes store (IO, dependency-injected).
 *
 * DB-backed CRUD for `machine_pane_columns`/`machine_panes` (a workspace's
 * relational grid, promoted from `machine_workspaces.layout` — #2202) and
 * `machine_workspace_revs` (the per-MACHINE monotonic verb counter). Kept
 * separate from the verb engine so it's testable against an in-memory fake
 * without a real database, same split as `machine-workspaces-store.ts`.
 *
 * `replaceWorkspaceGrid` is the ONE write primitive: it deletes and
 * re-inserts a workspace's whole grid inside the SAME transaction that mints
 * the machine's next rev, so "replace the grid" and "advance the rev" can
 * never observably disagree. A verb whose grid is deep-equal to the current
 * one (a retried already-applied verb, or a genuine no-op like binding a pane
 * to the session it already holds) does NOT bump rev and reports
 * `applied: false` — the caller uses this to skip broadcasting.
 */

export interface WorkspaceGridPaneScope {
  name: string;
  kind?: 'terminal' | 'chat';
}

export interface WorkspaceGridPaneInput {
  id: string;
  scope: WorkspaceGridPaneScope | null;
}

export interface WorkspaceGridColumnInput {
  id: string;
  panes: WorkspaceGridPaneInput[];
}

export type WorkspaceGridPaneRecord = WorkspaceGridPaneInput;
export type WorkspaceGridColumnRecord = WorkspaceGridColumnInput;

export interface MachinePanesStore {
  /** `[]` for a workspace with no rows (never created, or already cleared). Column/pane order = `orderIndex` asc. */
  getWorkspaceGrid(machineId: string, workspaceId: string): Promise<WorkspaceGridColumnRecord[]>;
  /** Every workspace grid on a machine that has at least one pane row, keyed by workspaceId. */
  getMachineGrids(machineId: string): Promise<Map<string, WorkspaceGridColumnRecord[]>>;
  /**
   * Replace one workspace's whole grid and, iff the grid actually changed,
   * advance the machine's rev. `grid: []` legally clears a workspace down to
   * zero panes (the caller — not this store — decides whether that also
   * means removing the workspace row itself).
   */
  replaceWorkspaceGrid(input: {
    machineId: string;
    workspaceId: string;
    grid: WorkspaceGridColumnInput[];
  }): Promise<{ rev: number; applied: boolean }>;
  /** Advances and returns the machine's rev with no grid change — used by verbs (create/rename/remove-workspace) that don't touch panes directly. */
  bumpRev(machineId: string): Promise<number>;
  /** The machine's current rev, `0` if it has never had a verb applied. */
  currentRev(machineId: string): Promise<number>;
}

function gridsEqual(a: WorkspaceGridColumnInput[], b: WorkspaceGridColumnInput[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Production DB-backed implementation. Lazily resolves the db client, schema
 * tables, and operators so callers that inject a fake (in tests) never load
 * the DB module graph — same laziness as `createDbMachineWorkspaceStore`.
 */
export async function createDbMachinePanesStore(): Promise<MachinePanesStore> {
  const [{ db }, { eq, and, asc, sql }, { machinePaneColumns, machinePanes, machineWorkspaceRevs }] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/machine-panes'),
  ]);

  async function readGrid(
    tx: { select: typeof db.select },
    machineId: string,
    workspaceId: string,
  ): Promise<WorkspaceGridColumnRecord[]> {
    const [columnRows, paneRows] = await Promise.all([
      tx
        .select()
        .from(machinePaneColumns)
        .where(and(eq(machinePaneColumns.machineId, machineId), eq(machinePaneColumns.workspaceId, workspaceId)))
        .orderBy(asc(machinePaneColumns.orderIndex)),
      tx
        .select()
        .from(machinePanes)
        .where(and(eq(machinePanes.machineId, machineId), eq(machinePanes.workspaceId, workspaceId)))
        .orderBy(asc(machinePanes.orderIndex)),
    ]);

    const panesByColumn = new Map<string, WorkspaceGridPaneRecord[]>();
    for (const pane of paneRows) {
      const list = panesByColumn.get(pane.columnId) ?? [];
      list.push({
        id: pane.id,
        scope: pane.sessionName ? { name: pane.sessionName, ...(pane.sessionKind ? { kind: pane.sessionKind as 'terminal' | 'chat' } : {}) } : null,
      });
      panesByColumn.set(pane.columnId, list);
    }

    return columnRows.map((col) => ({ id: col.id, panes: panesByColumn.get(col.id) ?? [] }));
  }

  return {
    async getWorkspaceGrid(machineId, workspaceId) {
      return readGrid(db, machineId, workspaceId);
    },

    async getMachineGrids(machineId) {
      const [columnRows, paneRows] = await Promise.all([
        db
          .select()
          .from(machinePaneColumns)
          .where(eq(machinePaneColumns.machineId, machineId))
          .orderBy(asc(machinePaneColumns.orderIndex)),
        db
          .select()
          .from(machinePanes)
          .where(eq(machinePanes.machineId, machineId))
          .orderBy(asc(machinePanes.orderIndex)),
      ]);

      const panesByColumn = new Map<string, WorkspaceGridPaneRecord[]>();
      for (const pane of paneRows) {
        const list = panesByColumn.get(pane.columnId) ?? [];
        list.push({
          id: pane.id,
          scope: pane.sessionName ? { name: pane.sessionName, ...(pane.sessionKind ? { kind: pane.sessionKind as 'terminal' | 'chat' } : {}) } : null,
        });
        panesByColumn.set(pane.columnId, list);
      }

      const grids = new Map<string, WorkspaceGridColumnRecord[]>();
      for (const col of columnRows) {
        const list = grids.get(col.workspaceId) ?? [];
        list.push({ id: col.id, panes: panesByColumn.get(col.id) ?? [] });
        grids.set(col.workspaceId, list);
      }
      return grids;
    },

    async replaceWorkspaceGrid({ machineId, workspaceId, grid }) {
      return db.transaction(async (tx) => {
        const current = await readGrid(tx, machineId, workspaceId);
        if (gridsEqual(current, grid)) {
          const [row] = await tx
            .select({ rev: machineWorkspaceRevs.rev })
            .from(machineWorkspaceRevs)
            .where(eq(machineWorkspaceRevs.machineId, machineId))
            .limit(1);
          return { rev: row?.rev ?? 0, applied: false };
        }

        await tx
          .delete(machinePanes)
          .where(and(eq(machinePanes.machineId, machineId), eq(machinePanes.workspaceId, workspaceId)));
        await tx
          .delete(machinePaneColumns)
          .where(and(eq(machinePaneColumns.machineId, machineId), eq(machinePaneColumns.workspaceId, workspaceId)));

        const now = new Date();
        for (const [columnIndex, column] of grid.entries()) {
          await tx.insert(machinePaneColumns).values({
            id: column.id,
            machineId,
            workspaceId,
            orderIndex: columnIndex,
            createdAt: now,
            updatedAt: now,
          });
          for (const [paneIndex, pane] of column.panes.entries()) {
            await tx.insert(machinePanes).values({
              id: pane.id,
              machineId,
              workspaceId,
              columnId: column.id,
              orderIndex: paneIndex,
              sessionName: pane.scope?.name ?? null,
              sessionKind: pane.scope?.kind ?? null,
              createdAt: now,
              updatedAt: now,
            });
          }
        }

        const [{ rev }] = await tx
          .insert(machineWorkspaceRevs)
          .values({ machineId, rev: 1 })
          .onConflictDoUpdate({
            target: machineWorkspaceRevs.machineId,
            set: { rev: sql`${machineWorkspaceRevs.rev} + 1` },
          })
          .returning({ rev: machineWorkspaceRevs.rev });

        return { rev, applied: true };
      });
    },

    async bumpRev(machineId) {
      const [{ rev }] = await db
        .insert(machineWorkspaceRevs)
        .values({ machineId, rev: 1 })
        .onConflictDoUpdate({
          target: machineWorkspaceRevs.machineId,
          set: { rev: sql`${machineWorkspaceRevs.rev} + 1` },
        })
        .returning({ rev: machineWorkspaceRevs.rev });
      return rev;
    },

    async currentRev(machineId) {
      const [row] = await db
        .select({ rev: machineWorkspaceRevs.rev })
        .from(machineWorkspaceRevs)
        .where(eq(machineWorkspaceRevs.machineId, machineId))
        .limit(1);
      return row?.rev ?? 0;
    },
  };
}
