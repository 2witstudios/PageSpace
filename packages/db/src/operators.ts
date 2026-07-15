import { eq, isNull, type Column, type SQL } from 'drizzle-orm';

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
