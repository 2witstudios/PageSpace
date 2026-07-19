import { and, asc, inArray, sql, type SQL } from '@pagespace/db/operators';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
// Type-only: erased at compile time, so this file never carries a runtime
// dependency on the connected `db` singleton — callers pass their own `tx`.
import type { db } from '@pagespace/db/db';
import type { ReorderPlan } from './compute-reorder-plan';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface LockedBatchReorderOptions<T extends PgTable> {
  table: T;
  idColumn: AnyPgColumn;
  positionColumn: AnyPgColumn;
  scopeWhere: SQL;
  plan: ReorderPlan;
  /**
   * Columns to stamp with the current time on every updated row (e.g. an
   * `updatedAt` column driven by Drizzle's `$onUpdate`). `$onUpdate` only
   * fires through Drizzle's query builder, never through a raw `execute`, so
   * without this a caller switching from `tx.update(...).set(...)` to this
   * primitive would silently stop refreshing those columns. Optional: tables
   * with no such column (e.g. `favorites`, which has no `updatedAt`) omit it.
   */
  touchColumns?: AnyPgColumn[];
}

/**
 * Apply a reorder plan inside the caller's transaction: lock every target
 * row `FOR UPDATE` in ascending-id order, then write every position as one
 * batched `UPDATE ... FROM (VALUES ...)` statement.
 *
 * Locking in ascending-id order (the order `computeReorderPlan` already
 * produces) is what prevents two concurrent, overlapping reorders from
 * deadlocking — see `lockDriveRolesInOrder` in drive-role-service.ts for the
 * same contract applied to a single call site. Batching the write into one
 * statement instead of N sequential per-row updates is what closes the
 * window between those N updates that let concurrent reorders interleave in
 * the first place.
 */
export async function lockedBatchReorder<T extends PgTable>(
  tx: Tx,
  opts: LockedBatchReorderOptions<T>
): Promise<void> {
  const { table, idColumn, positionColumn, scopeWhere, plan, touchColumns = [] } = opts;

  if (plan.orderedIds.length === 0) {
    return;
  }

  await tx
    .select({ id: idColumn })
    .from(table)
    .where(and(scopeWhere, inArray(idColumn, plan.orderedIds)))
    .orderBy(asc(idColumn))
    .for('update');

  const values = sql.join(
    plan.orderedIds.map(
      (id) => sql`(${id}::text, ${plan.positionById.get(id)}::int)`
    ),
    sql`, `
  );

  const setAssignments = sql.join(
    [
      sql`${sql.identifier(positionColumn.name)} = v.position`,
      ...touchColumns.map((column) => sql`${sql.identifier(column.name)} = now()`),
    ],
    sql`, `
  );

  await tx.execute(sql`
    UPDATE ${table}
    SET ${setAssignments}
    FROM (VALUES ${values}) AS v(id, position)
    WHERE ${idColumn} = v.id AND ${scopeWhere}
  `);
}
