import { eq, isNull, sql, type Column, type SQL } from 'drizzle-orm';

export {
  eq, ne, gt, gte, lt, lte, and, or, not, like, ilike, between,
  exists, isNull, isNotNull, inArray, notInArray, count, sum, avg, max, min, asc,
  desc, sql,
} from 'drizzle-orm';
export type { SQL, InferSelectModel, InferInsertModel } from 'drizzle-orm';

/**
 * Null-safe equality for a nullable column: `col = value`, or `col IS NULL` when
 * `value` is null (SQL `=` never matches NULL, so a plain `eq(col, null)` would
 * silently match nothing).
 *
 * Extracted because the Sprite-teardown paths compare-and-swap on
 * `spriteInstanceId` — a nullable identity — in five places, and the rule "two
 * live VMs can share one reused name, so match the INSTANCE" is the single crux
 * the whole teardown workstream enforces. Expressing it once means a future
 * refinement (a generation counter; deciding NULL should not match NULL) changes
 * one line, not five — and a missed site can't silently degrade the ABA guard.
 */
export function eqOrIsNull<T>(column: Column, value: T | null): SQL {
  return value === null ? isNull(column) : eq(column, value);
}

/**
 * Null-safe INEQUALITY: SQL's `IS DISTINCT FROM`, which treats NULL as a value
 * rather than as unknown.
 *
 * The inverse of `eqOrIsNull`, and not expressible as `not(eqOrIsNull(...))`:
 * `NOT (col = value)` evaluates to NULL — i.e. no match — whenever `col` is
 * NULL, so the guard would silently skip exactly the NULL→value transition it
 * was written to catch.
 *
 * The use is the "only a real change writes" guard on nullable lifecycle
 * columns (see `setConversationPlan`): folding it into the WHERE makes a
 * redundant write match zero rows, so it cannot bump `rev` or fire a directory
 * event for a change that did not happen.
 */
export function isDistinctFrom<T>(column: Column, value: T | null): SQL {
  return sql`${column} IS DISTINCT FROM ${value}`;
}
