/* eslint-disable @typescript-eslint/no-explicit-any */
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
};

export function evalCond(cond: Cond, row: Record<string, unknown>): boolean {
  if (!cond) return true;
  switch (cond.type) {
    case 'eq': return row[cond.col] === cond.val;
    case 'ne': return row[cond.col] !== cond.val;
    case 'gte': return (row[cond.col] as any) >= (cond.val as any);
    case 'lt': return (row[cond.col] as any) < (cond.val as any);
    case 'in': return cond.vals.includes(row[cond.col]);
    case 'and': return cond.conds.every(c => evalCond(c, row));
    case 'or': return cond.conds.some(c => evalCond(c, row));
    case 'isNull': return row[cond.col] == null;
    case 'isNotNull': return row[cond.col] != null;
    default: return true;
  }
}

/**
 * Builds a `db` mock whose `.select(fields).from(table)...` chain evaluates the
 * real (fixture-op-built) where-condition against `tableRows.get(table)`, keyed by
 * table object identity (so it must be the SAME mocked schema object the route
 * imports). Supports the chain shapes pulse's queries use: `.from().innerJoin()
 * .where()[.orderBy()][.groupBy()][.limit()]`, and resolves to `[{count}]` when
 * `fields` is the single `{ count: count() }` shape, otherwise to the row list
 * mapped through `fields` (or the raw rows when no fields/select shape applies).
 */
export function createFixtureSelect(tableRows: Map<unknown, Record<string, unknown>[]>) {
  return (fields?: Record<string, unknown>) => {
    let rows: Record<string, unknown>[] = [];
    let cond: Cond;
    let limitN: number | undefined;

    const builder: any = {
      from: (table: unknown) => { rows = tableRows.get(table) ?? []; return builder; },
      innerJoin: (table: unknown) => {
        // Merge the joined table's fixture rows are already flattened into the
        // primary fixture rows by the caller — innerJoin is a structural no-op here.
        void table;
        return builder;
      },
      leftJoin: (table: unknown) => { void table; return builder; },
      where: (c: Cond) => { cond = c; return builder; },
      orderBy: () => builder,
      groupBy: () => builder,
      limit: (n: number) => { limitN = n; return builder; },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
        try {
          const filtered = rows.filter(r => evalCond(cond, r));
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

/** A Promise that also exposes `.returning()`, for mocking `db.insert(...).values(...)`. */
export function makeInsertValuesResult(returningRows: Record<string, unknown>[]) {
  const result: any = Promise.resolve(undefined);
  result.returning = () => Promise.resolve(returningRows);
  return result;
}
