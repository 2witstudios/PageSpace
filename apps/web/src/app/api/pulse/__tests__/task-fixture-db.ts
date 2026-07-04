// Shared fixture-based fake DB helpers for testing Pulse's task queries.
//
// The real `@pagespace/db/operators` build drizzle SQL condition objects that are
// impractical to evaluate in a unit test. So the operator mocks that pair with this
// helper build a tiny plain-object condition AST instead, and `evalCond` interprets
// that AST against flat fixture rows (task fields + joined page fields merged into
// one row). This lets tests assert genuine filtering behavior — e.g. a trashed
// page's task is actually excluded from the result — rather than only inspecting
// which query-builder methods were called.

export type Cond =
  | { type: 'eq'; col: string; val: unknown }
  | { type: 'ne'; col: string; val: unknown }
  | { type: 'gte'; col: string; val: unknown }
  | { type: 'lt'; col: string; val: unknown }
  | { type: 'in'; col: string; vals: unknown[] }
  | { type: 'and'; conds: Cond[] }
  | { type: 'or'; conds: Cond[] }
  | { type: 'isNull'; col: string }
  | { type: 'isNotNull'; col: string }
  // Recognizes `sql`${col} IN (SELECT page_id FROM accessible_page_ids_for_user(${userId}))``
  // (see route.ts) and evaluates it against the accessiblePageIds fixture passed
  // to createFixtureSelect, mirroring what the real DB function would return.
  | { type: 'inAccessiblePages'; col: string }
  | undefined;

export const COUNT_SENTINEL = '__count__';

// Drop-in replacements for `@pagespace/db/operators` that build the AST above
// instead of real drizzle SQL.
export const fixtureOperators = {
  eq: (col: string, val: unknown): Cond => ({ type: 'eq', col, val }),
  ne: (col: string, val: unknown): Cond => ({ type: 'ne', col, val }),
  gte: (col: string, val: unknown): Cond => ({ type: 'gte', col, val }),
  lt: (col: string, val: unknown): Cond => ({ type: 'lt', col, val }),
  inArray: (col: string, vals: unknown[]): Cond => ({ type: 'in', col, vals }),
  and: (...conds: Cond[]): Cond => ({ type: 'and', conds }),
  or: (...conds: Cond[]): Cond => ({ type: 'or', conds }),
  isNull: (col: string): Cond => ({ type: 'isNull', col }),
  isNotNull: (col: string): Cond => ({ type: 'isNotNull', col }),
  desc: (col: string) => col,
  count: () => COUNT_SENTINEL,
  sql: (strings: TemplateStringsArray, ...values: unknown[]): Cond => {
    if (strings.join('').includes('accessible_page_ids_for_user')) {
      return { type: 'inAccessiblePages', col: values[0] as string };
    }
    throw new Error(`Unhandled sql fragment in test fixture: ${strings.join('')}`);
  },
};

export function evalCond(
  cond: Cond,
  row: Record<string, unknown>,
  accessiblePageIds: ReadonlySet<string>
): boolean {
  if (!cond) return true;
  switch (cond.type) {
    case 'eq': return row[cond.col] === cond.val;
    case 'ne': return row[cond.col] !== cond.val;
    case 'gte': return (row[cond.col] as string | number | Date) >= (cond.val as string | number | Date);
    case 'lt': return (row[cond.col] as string | number | Date) < (cond.val as string | number | Date);
    case 'in': return cond.vals.includes(row[cond.col]);
    case 'and': return cond.conds.every(c => evalCond(c, row, accessiblePageIds));
    case 'or': return cond.conds.some(c => evalCond(c, row, accessiblePageIds));
    case 'isNull': return row[cond.col] == null;
    case 'isNotNull': return row[cond.col] != null;
    case 'inAccessiblePages': return accessiblePageIds.has(row[cond.col] as string);
    default: return true;
  }
}

// Deliberately not `extends PromiseLike<...>`: PromiseLike's `then` signature is
// fully generic (optional/nullable callbacks, arbitrary TResult), which doesn't
// match the simpler two-callback shape this fixture actually implements. `await`
// only needs a callable `.then(resolve, reject)` structurally, so this narrower
// shape is sufficient without forcing an overly generic implementation.
export interface RowQueryBuilder {
  from(table: unknown): RowQueryBuilder;
  innerJoin(table: unknown): RowQueryBuilder;
  leftJoin(table: unknown): RowQueryBuilder;
  where(cond: Cond): RowQueryBuilder;
  orderBy(...args: unknown[]): RowQueryBuilder;
  groupBy(...args: unknown[]): RowQueryBuilder;
  limit(n: number): RowQueryBuilder;
  then(resolve: (v: Record<string, unknown>[]) => void, reject?: (e: unknown) => void): void;
}

/**
 * Builds a `db` mock whose `.select(fields).from(table)...` chain evaluates the
 * real (fixture-op-built) where-condition against `tableRows.get(table)`, keyed by
 * table object identity (so it must be the SAME mocked schema object the route
 * imports). Supports the chain shapes pulse's queries use: `.from().innerJoin()
 * .where()[.orderBy()][.groupBy()][.limit()]`, and resolves to `[{count}]` when
 * `fields` is the single `{ count: count() }` shape, otherwise to the row list
 * mapped through `fields` (or the raw rows when no fields/select shape applies).
 * `getAccessiblePageIds` is re-invoked on every resolution (not just once at
 * builder-creation time) so a test's `beforeEach` can freely reassign the
 * fixture between cases.
 */
export function createFixtureSelect(
  tableRows: Map<unknown, Record<string, unknown>[]>,
  getAccessiblePageIds: () => string[] = () => []
) {
  return (fields?: Record<string, unknown>): RowQueryBuilder => {
    let rows: Record<string, unknown>[] = [];
    let cond: Cond;
    let limitN: number | undefined;

    const builder: RowQueryBuilder = {
      from: (table: unknown) => { rows = tableRows.get(table) ?? []; return builder; },
      innerJoin: (table: unknown) => {
        // The joined table's fixture rows are already flattened into the
        // primary fixture rows by the caller — innerJoin is a structural no-op here.
        void table;
        return builder;
      },
      leftJoin: (table: unknown) => { void table; return builder; },
      where: (c: Cond) => { cond = c; return builder; },
      orderBy: () => builder,
      groupBy: () => builder,
      limit: (n: number) => { limitN = n; return builder; },
      then: (resolve: (v: Record<string, unknown>[]) => void, reject?: (e: unknown) => void) => {
        try {
          const accessiblePageIds = new Set(getAccessiblePageIds());
          const filtered = rows.filter(r => evalCond(cond, r, accessiblePageIds));
          const fieldEntries = fields ? Object.entries(fields) : undefined;
          const isCount = !!fieldEntries && fieldEntries.length === 1 && fieldEntries[0][1] === COUNT_SENTINEL;
          if (isCount) {
            resolve([{ count: filtered.length }]);
            return;
          }
          const sliced = limitN != null ? filtered.slice(0, limitN) : filtered;
          if (!fieldEntries) {
            resolve(sliced);
            return;
          }
          resolve(sliced.map(r => Object.fromEntries(
            fieldEntries.map(([outKey, colName]) => [outKey, r[colName as string]])
          )));
        } catch (e) {
          if (reject) reject(e); else throw e;
        }
      },
    };
    return builder;
  };
}
