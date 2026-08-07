/**
 * Agent Workspace Layout store (IO, dependency-injected).
 *
 * DB-backed CRUD for `agent_workspace_pane_columns`/`agent_workspace_panes`
 * (a session's relational pane grid — THE source of truth since the
 * `agent_sessions.workspaceState` blob was dropped at Phase 3's contract
 * step; the #2202 machine-panes pattern), `agent_workspace_layout_revs` (the
 * per-workspace monotonic verb counter), and `agent_workspace_layout_ops`
 * (the verb route's idempotency memory). Kept separate from the pure engine
 * (`../../agent-sessions/workspace-layout-verbs.ts`) so the engine is
 * testable against an in-memory fake without a database — same split as
 * `agent-sessions-store.ts`.
 *
 * `replaceWorkspaceGrid` is the ONE write primitive: it deletes and
 * re-inserts a workspace's whole grid inside the SAME transaction that mints
 * the workspace's next rev, so "replace the grid" and "advance the rev" can
 * never observably disagree. A write whose grid is deep-equal to the current
 * one (a retried already-applied verb, or a verb that only moved client-local
 * view state) does NOT bump rev and reports `applied: false` — the caller
 * uses this to skip broadcasting.
 *
 * The rev mint (`INSERT ... ON CONFLICT ("workspaceId") DO UPDATE SET
 * rev = rev + 1 RETURNING rev`) doubles as a serializing row lock per the
 * machine pattern — and the rev lives in its OWN table precisely so that
 * lock never lands on the `agent_sessions` row that sandbox teardown/ensure
 * CAS writes contend on (see the schema doc).
 *
 * `replaceWorkspaceGrid`'s own transaction is only safe against a CONCURRENT
 * caller if that caller's read (the one that decided what grid to compute)
 * is inside the same lock scope — otherwise two callers each compute a full
 * replacement from the same stale base and the later commit silently drops
 * the earlier one's change. `withWorkspaceLayoutLock` is the seam that
 * closes this: it opens the transaction and holds the per-workspace advisory
 * lock BEFORE the caller reads anything; every store method accepts an
 * optional `executor` so a caller holding that lock routes its whole
 * read-reduce-write sequence through the SAME transaction.
 */

import type { db as DbType } from '@pagespace/db/db';
import type { PaneKind } from '../../agent-sessions/contract';
import { quantizeFraction, type LayoutGridColumn } from '../../agent-sessions/workspace-layout-verbs';

type DbTransactionCallback = Parameters<typeof DbType.transaction>[0];
/** The real pooled `db`, OR a transaction obtained from it. Type-only, so
 * injecting a fake store in tests never loads the DB module graph. */
export type DbExecutor = typeof DbType | Parameters<DbTransactionCallback>[0];

/** How long a processed `(workspaceId, opId)` memory row is retained. Retries
 * arrive within seconds (client timeout, duplicate delivery); 24h is a
 * generous ceiling that keeps the table effectively empty. */
const OP_MEMORY_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface WorkspaceLayoutOpRecord {
  rev: number;
  applied: boolean;
}

export interface WorkspaceLayoutStore {
  /** `[]` for a workspace with no rows (truly gridless). Column/pane order = `orderIndex` asc. */
  getWorkspaceGrid(workspaceId: string): Promise<LayoutGridColumn[]>;
  /**
   * MANY workspaces' grids in two queries — the sessions-list GET's shape
   * (one poll per open sidebar; a per-session read would be 2N queries).
   * A workspace with no rows simply has no entry.
   */
  getWorkspaceGridsBulk(workspaceIds: string[]): Promise<Map<string, LayoutGridColumn[]>>;
  /** Replace one workspace's whole grid and, iff the grid actually changed, advance the workspace's rev. */
  replaceWorkspaceGrid(input: {
    workspaceId: string;
    grid: LayoutGridColumn[];
  }): Promise<{ rev: number; applied: boolean }>;
  /** The workspace's current rev, `0` if no verb has ever applied. */
  currentRev(workspaceId: string): Promise<number>;
  /** The memory row for a recently processed op, or `null` — the idempotent-retry short-circuit. */
  findOp(workspaceId: string, opId: string): Promise<WorkspaceLayoutOpRecord | null>;
  /** Record a processed op (applied or not) and opportunistically prune expired memory rows. */
  recordOp(input: { workspaceId: string; opId: string; rev: number; applied: boolean }): Promise<void>;
}

function gridsEqual(a: LayoutGridColumn[], b: LayoutGridColumn[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A `real` (float4) fraction column, read back as the same value the reducer
 * wrote. The column's storage type is narrower than a JS double, so the round
 * trip is lossy — and {@link gridsEqual} is a byte comparison, so an unsnapped
 * read would make every single write look like a change. See
 * `quantizeFraction`'s own doc for why the snap is exact.
 */
function readStoredFraction(value: number | null): number | null {
  return value === null ? null : quantizeFraction(value);
}

/**
 * Serializes every call for the same `workspaceId` against every OTHER call
 * (from any caller, on any connection) for that same workspace: opens a
 * transaction, acquires a Postgres advisory lock scoped to it (auto-released
 * on commit/rollback), and only then invokes `fn` — so `fn`'s first read is
 * guaranteed not to race a concurrent mutator's write, and vice versa. This
 * closes the lost-update class `replaceWorkspaceGrid`'s own transaction
 * cannot prevent alone (see the module doc): the caller's OWN read has to be
 * inside the same lock scope as the write.
 *
 * `fn` receives the transaction so it can build a lock-scoped store via
 * `createDbWorkspaceLayoutStore(tx)` and route its whole critical section
 * through it.
 *
 * `hashtext()` collapses the workspace id (a cuid2 string) to the bigint key
 * `pg_advisory_xact_lock` needs — a 32-bit hash, so a collision with an
 * unrelated workspace merely over-serializes the two, never a correctness
 * issue. Same pattern the machine panes store shipped.
 */
export async function withWorkspaceLayoutLock<T>(
  workspaceId: string,
  fn: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  const [{ db }, { sql }] = await Promise.all([import('@pagespace/db/db'), import('@pagespace/db/operators')]);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`);
    return fn(tx);
  });
}

/**
 * Production DB-backed implementation. Lazily resolves the db client, schema
 * tables, and operators so callers that inject a fake (in tests) never load
 * the DB module graph — same laziness as `createDbAgentSessionsStore`.
 *
 * `executor` defaults to the real pooled `db`; pass a transaction (as
 * obtained from `withWorkspaceLayoutLock`) to route every query through it —
 * required for any caller doing a read-reduce-write cycle under the lock.
 */
export async function createDbWorkspaceLayoutStore(executor?: DbExecutor): Promise<WorkspaceLayoutStore> {
  const [{ db }, { eq, and, asc, inArray, lt, sql }, layout] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/agent-workspace-layout'),
  ]);
  const { agentWorkspacePaneColumns, agentWorkspacePanes, agentWorkspaceLayoutRevs, agentWorkspaceLayoutOps } = layout;
  const client = executor ?? db;

  async function readGrid(exec: DbExecutor, workspaceId: string): Promise<LayoutGridColumn[]> {
    const [columnRows, paneRows] = await Promise.all([
      exec
        .select()
        .from(agentWorkspacePaneColumns)
        .where(eq(agentWorkspacePaneColumns.workspaceId, workspaceId))
        .orderBy(asc(agentWorkspacePaneColumns.orderIndex)),
      exec
        .select()
        .from(agentWorkspacePanes)
        .where(eq(agentWorkspacePanes.workspaceId, workspaceId))
        .orderBy(asc(agentWorkspacePanes.orderIndex)),
    ]);

    const panesByColumn = new Map<string, LayoutGridColumn['panes']>();
    for (const pane of paneRows) {
      const list = panesByColumn.get(pane.columnId) ?? [];
      list.push({
        id: pane.id,
        kind: (pane.kind as PaneKind | null) ?? null,
        targetId: pane.targetId,
        heightFraction: readStoredFraction(pane.heightFraction),
      });
      panesByColumn.set(pane.columnId, list);
    }

    return columnRows.map((col) => ({
      id: col.id,
      widthFraction: readStoredFraction(col.widthFraction),
      panes: panesByColumn.get(col.id) ?? [],
    }));
  }

  async function mintRev(exec: DbExecutor, workspaceId: string): Promise<number> {
    const [{ rev }] = await exec
      .insert(agentWorkspaceLayoutRevs)
      .values({ workspaceId, rev: 1 })
      .onConflictDoUpdate({
        target: agentWorkspaceLayoutRevs.workspaceId,
        set: { rev: sql`${agentWorkspaceLayoutRevs.rev} + 1` },
      })
      .returning({ rev: agentWorkspaceLayoutRevs.rev });
    return rev;
  }

  async function readRev(exec: DbExecutor, workspaceId: string): Promise<number> {
    const [row] = await exec
      .select({ rev: agentWorkspaceLayoutRevs.rev })
      .from(agentWorkspaceLayoutRevs)
      .where(eq(agentWorkspaceLayoutRevs.workspaceId, workspaceId))
      .limit(1);
    return row?.rev ?? 0;
  }

  return {
    async getWorkspaceGrid(workspaceId) {
      return readGrid(client, workspaceId);
    },

    async getWorkspaceGridsBulk(workspaceIds) {
      const grids = new Map<string, LayoutGridColumn[]>();
      if (workspaceIds.length === 0) return grids;
      const [columnRows, paneRows] = await Promise.all([
        client
          .select()
          .from(agentWorkspacePaneColumns)
          .where(inArray(agentWorkspacePaneColumns.workspaceId, workspaceIds))
          .orderBy(asc(agentWorkspacePaneColumns.orderIndex)),
        client
          .select()
          .from(agentWorkspacePanes)
          .where(inArray(agentWorkspacePanes.workspaceId, workspaceIds))
          .orderBy(asc(agentWorkspacePanes.orderIndex)),
      ]);

      // Panes key on (workspaceId, columnId) — column ids are client-minted,
      // so they are only unique WITHIN a workspace and a bare columnId key
      // would cross-contaminate two sessions' grids.
      const panesByColumn = new Map<string, LayoutGridColumn['panes']>();
      for (const pane of paneRows) {
        const key = `${pane.workspaceId} ${pane.columnId}`;
        const list = panesByColumn.get(key) ?? [];
        list.push({
          id: pane.id,
          kind: (pane.kind as PaneKind | null) ?? null,
          targetId: pane.targetId,
          heightFraction: readStoredFraction(pane.heightFraction),
        });
        panesByColumn.set(key, list);
      }

      for (const col of columnRows) {
        const list = grids.get(col.workspaceId) ?? [];
        list.push({
          id: col.id,
          widthFraction: readStoredFraction(col.widthFraction),
          panes: panesByColumn.get(`${col.workspaceId} ${col.id}`) ?? [],
        });
        grids.set(col.workspaceId, list);
      }
      return grids;
    },

    async replaceWorkspaceGrid({ workspaceId, grid }) {
      // Nested (SAVEPOINT-based) when `client` is already a transaction —
      // e.g. inside `withWorkspaceLayoutLock` — so this still commits/rolls
      // back atomically with the caller's outer critical section.
      return client.transaction(async (tx) => {
        const current = await readGrid(tx, workspaceId);
        if (gridsEqual(current, grid)) {
          return { rev: await readRev(tx, workspaceId), applied: false };
        }

        await tx.delete(agentWorkspacePanes).where(eq(agentWorkspacePanes.workspaceId, workspaceId));
        await tx.delete(agentWorkspacePaneColumns).where(eq(agentWorkspacePaneColumns.workspaceId, workspaceId));

        const now = new Date();
        for (const [columnIndex, column] of grid.entries()) {
          await tx.insert(agentWorkspacePaneColumns).values({
            id: column.id,
            workspaceId,
            orderIndex: columnIndex,
            // No longer reserved (issue #2208): the resize verbs write this,
            // and `null` is the honest "this grid has never been sized".
            widthFraction: column.widthFraction,
            createdAt: now,
            updatedAt: now,
          });
          for (const [paneIndex, pane] of column.panes.entries()) {
            await tx.insert(agentWorkspacePanes).values({
              id: pane.id,
              workspaceId,
              columnId: column.id,
              orderIndex: paneIndex,
              kind: pane.kind,
              targetId: pane.targetId,
              heightFraction: pane.heightFraction,
              createdAt: now,
              updatedAt: now,
            });
          }
        }

        return { rev: await mintRev(tx, workspaceId), applied: true };
      });
    },

    async currentRev(workspaceId) {
      return readRev(client, workspaceId);
    },

    async findOp(workspaceId, opId) {
      const [row] = await client
        .select({ rev: agentWorkspaceLayoutOps.rev, applied: agentWorkspaceLayoutOps.applied })
        .from(agentWorkspaceLayoutOps)
        .where(and(eq(agentWorkspaceLayoutOps.workspaceId, workspaceId), eq(agentWorkspaceLayoutOps.opId, opId)))
        .limit(1);
      return row ?? null;
    },

    async recordOp({ workspaceId, opId, rev, applied }) {
      // Prune expired memory first, scoped to this workspace — opportunistic
      // and tiny (a workspace accrues a handful of ops a day; the window is
      // OP_MEMORY_RETENTION_MS), so no dedicated sweeper is needed.
      const cutoff = new Date(Date.now() - OP_MEMORY_RETENTION_MS);
      await client
        .delete(agentWorkspaceLayoutOps)
        .where(and(eq(agentWorkspaceLayoutOps.workspaceId, workspaceId), lt(agentWorkspaceLayoutOps.createdAt, cutoff)));
      await client
        .insert(agentWorkspaceLayoutOps)
        .values({ workspaceId, opId, rev, applied })
        .onConflictDoNothing();
    },
  };
}
