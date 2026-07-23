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
   *
   * Stamped with Postgres `clock_timestamp()`, not `now()`. `now()` (aka
   * `transaction_timestamp()`) is fixed at the transaction's `BEGIN` and
   * stays fixed for every statement inside it — including this one. If this
   * transaction blocks waiting on the `FOR UPDATE` lock above (e.g. a
   * concurrent role mutation holds it), the wait can outlast a concurrent
   * writer's own commit, and `now()` would then stamp a timestamp from
   * *before* that writer's newer one — silently regressing `updatedAt`
   * backwards. `clock_timestamp()` reflects the actual wall-clock moment
   * this UPDATE executes (after the lock is acquired), matching the
   * `new Date()`-evaluated-at-write-time semantics every other writer in
   * this codebase already has.
   */
  touchColumns?: AnyPgColumn[];
  /**
   * SQL type the submitted positions are cast to inside the batched
   * `UPDATE ... FROM (VALUES ...)`. Defaults to `'int'` for the integer position
   * columns (`drive_roles`, `favorites`) this primitive was written for.
   *
   * Pass `'real'` for float position columns — notably `pages.position`, where task
   * and page reorders write fractional midpoints between neighbours. An `::int` cast
   * there truncates every midpoint, collapsing distinct slots onto one position.
   */
  positionType?: 'int' | 'real';
}

/**
 * Apply a reorder plan inside the caller's transaction: lock every target
 * row `FOR UPDATE` in ascending-id order, then write every position as one
 * batched `UPDATE ... FROM (VALUES ...)` statement. Returns the ids from the
 * plan that actually existed within `scopeWhere` (and were therefore locked
 * and updated) — ids in the plan that don't exist in scope are silently
 * skipped by the batched `UPDATE`'s `WHERE`, so this is the caller's signal
 * to detect that and decide how to react (e.g. `reorderDriveRoles` currently
 * rejects the whole request when any submitted id doesn't belong to the
 * drive; a caller adopting this primitive can reproduce that by comparing
 * this return value against `plan.orderedIds`).
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
): Promise<string[]> {
  const { table, idColumn, positionColumn, scopeWhere, plan, touchColumns = [], positionType = 'int' } = opts;

  if (plan.orderedIds.length === 0) {
    return [];
  }

  const locked = await tx
    .select({ id: idColumn })
    .from(table)
    .where(and(scopeWhere, inArray(idColumn, plan.orderedIds)))
    .orderBy(asc(idColumn))
    .for('update');
  const lockedIds = locked.map((row) => row.id as string);

  const values = sql.join(
    plan.orderedIds.map(
      (id) => positionType === 'real'
        ? sql`(${id}::text, ${plan.positionById.get(id)}::real)`
        : sql`(${id}::text, ${plan.positionById.get(id)}::int)`
    ),
    sql`, `
  );

  const setAssignments = sql.join(
    [
      sql`${sql.identifier(positionColumn.name)} = v.position`,
      ...touchColumns.map((column) => sql`${sql.identifier(column.name)} = clock_timestamp()`),
    ],
    sql`, `
  );

  await tx.execute(sql`
    UPDATE ${table}
    SET ${setAssignments}
    FROM (VALUES ${values}) AS v(id, position)
    WHERE ${idColumn} = v.id AND ${scopeWhere}
  `);

  return lockedIds;
}
