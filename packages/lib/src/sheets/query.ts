/**
 * @module @pagespace/lib/sheets/query
 * @description Compiles a sheet row filter into parameterised SQL.
 *
 * This is what makes a sheet queryable by an agent: instead of reading the
 * whole document into context and filtering in the model, a caller asks for
 * "rows where F = active, ordered by D, limit 50" and gets 50 rows.
 *
 * Everything here is untrusted input — the filter arrives over MCP from a model.
 * Two rules hold throughout and are the reason this is a separate, tested
 * module rather than string building at the call site:
 *
 *   1. Every value reaches SQL as a bind parameter. Nothing is interpolated.
 *   2. Every column is validated against `^[A-Z]+$` before it can name a jsonb
 *      key, so a column cannot smuggle in an operator or a path.
 *
 * Depth and breadth are bounded so a deeply nested filter cannot become a
 * denial of service against the planner.
 */

import { sql, type SQL } from '@pagespace/db/operators';
import { sheetRows } from '@pagespace/db/schema';
import { decodeColumnLabel } from './address';

export const MAX_FILTER_DEPTH = 8;
export const MAX_FILTER_CONDITIONS = 64;
export const MAX_IN_VALUES = 500;

export type SheetFilterOp =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'in';

export interface SheetCondition {
  /** Column letter, e.g. "A", "AB". */
  column: string;
  op: SheetFilterOp;
  value?: unknown;
}

export type SheetWhere =
  | SheetCondition
  | { and: SheetWhere[] }
  | { or: SheetWhere[] }
  | { not: SheetWhere };

export class SheetQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SheetQueryError';
  }
}

/**
 * A column's materialised value as jsonb.
 *
 * Reads `value`, not `raw`: a filter should match what the cell *is*, so
 * `=B2*C2` compares as 7.5 rather than as its formula text. That is only
 * possible because the value is materialised on write.
 */
function valueOf(column: string): SQL {
  const label = assertColumn(column);
  return sql`(${sheetRows.cells} -> ${label} -> 'value')`;
}

/** The same, as text, for string comparisons. */
function textOf(column: string): SQL {
  const label = assertColumn(column);
  return sql`(${sheetRows.cells} -> ${label} ->> 'value')`;
}

export function assertColumn(column: string): string {
  const label = String(column ?? '').trim().toUpperCase();
  // Up to 7 letters, which is past any addressable column, rather than 3.
  // `encodeColumnLabel` emits four letters happily and `columnCount` is
  // unbounded, so a three-letter cap silently made every column after ZZZ
  // unfilterable, unsortable and unprojectable — a 400 on valid input.
  if (!/^[A-Z]{1,7}$/.test(label)) {
    throw new SheetQueryError(`Invalid column: ${column}`);
  }
  // Round-trips through the address decoder so a column that passes here is one
  // the rest of the engine can also address.
  decodeColumnLabel(label);
  return label;
}

/**
 * Compile a filter tree into a SQL predicate.
 *
 * Returns `undefined` for an absent filter so the caller can omit the WHERE
 * clause entirely rather than emit a tautology.
 */
export function compileWhere(where: SheetWhere | undefined): SQL | undefined {
  if (!where) return undefined;
  const state = { conditions: 0 };
  return compileNode(where, 0, state);
}

function compileNode(node: SheetWhere, depth: number, state: { conditions: number }): SQL {
  if (depth > MAX_FILTER_DEPTH) {
    throw new SheetQueryError(`Filter nested deeper than ${MAX_FILTER_DEPTH}`);
  }
  if (!node || typeof node !== 'object') {
    throw new SheetQueryError('Filter node must be an object');
  }

  if ('and' in node || 'or' in node) {
    const isAnd = 'and' in node;
    const children = (isAnd ? node.and : (node as { or: SheetWhere[] }).or) ?? [];
    if (!Array.isArray(children) || children.length === 0) {
      throw new SheetQueryError(`"${isAnd ? 'and' : 'or'}" needs at least one condition`);
    }
    const parts = children.map((child) => compileNode(child, depth + 1, state));
    return sql`(${sql.join(parts, isAnd ? sql` AND ` : sql` OR `)})`;
  }

  if ('not' in node) {
    return sql`(NOT ${compileNode(node.not, depth + 1, state)})`;
  }

  state.conditions++;
  if (state.conditions > MAX_FILTER_CONDITIONS) {
    throw new SheetQueryError(`Filter exceeds ${MAX_FILTER_CONDITIONS} conditions`);
  }

  return compileCondition(node as SheetCondition);
}

function compileCondition(condition: SheetCondition): SQL {
  const { op } = condition;

  switch (op) {
    case 'isEmpty':
      return sql`(${textOf(condition.column)} IS NULL OR ${textOf(condition.column)} = '')`;
    case 'isNotEmpty':
      return sql`(${textOf(condition.column)} IS NOT NULL AND ${textOf(condition.column)} <> '')`;

    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      const needle = requireString(condition, op);
      const pattern =
        op === 'contains'
          ? `%${escapeLike(needle)}%`
          : op === 'startsWith'
            ? `${escapeLike(needle)}%`
            : `%${escapeLike(needle)}`;
      // ESCAPE is explicit so a literal % or _ in user input matches literally
      // instead of silently becoming a wildcard.
      return sql`${textOf(condition.column)} ILIKE ${pattern} ESCAPE '\\'`;
    }

    case 'in': {
      const values = condition.value;
      if (!Array.isArray(values) || values.length === 0) {
        throw new SheetQueryError('"in" needs a non-empty array');
      }
      if (values.length > MAX_IN_VALUES) {
        throw new SheetQueryError(`"in" accepts at most ${MAX_IN_VALUES} values`);
      }
      const params = values.map((value) => sql`${scalarToText(value)}`);
      return sql`${textOf(condition.column)} IN (${sql.join(params, sql`, `)})`;
    }

    case 'eq':
    case 'neq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const value = condition.value;

      if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          throw new SheetQueryError('Numeric comparison needs a finite number');
        }

        if (op === 'neq') {
          // Same three-valued problem the text branch below handles: the CASE
          // returns false for a blank or non-numeric cell, so "B is not 5"
          // dropped every row where B was empty. Whether the caller passed `5`
          // or `"5"` must not change which rows come back.
          return sql`(NOT (CASE
            WHEN jsonb_typeof(${valueOf(condition.column)}) = 'number'
            THEN (${valueOf(condition.column)})::numeric = ${value}
            ELSE false
          END))`;
        }
        // CASE, not `jsonb_typeof(...) = 'number' AND (...)::numeric`.
        //
        // Postgres does NOT guarantee that AND short-circuits — the planner is
        // free to evaluate the cast before the type guard, and casting a jsonb
        // string to numeric RAISES (22023, "cannot cast jsonb string to type
        // numeric"). One text cell in an otherwise numeric column would fail
        // the whole query instead of simply not matching. CASE is the one
        // construct whose evaluation order is defined, so the cast is only ever
        // reached for a value already known to be a number.
        //
        // Verified by executing it: the AND form dies on the mixed-type column
        // in `sheet-query-execution`, this form returns the numeric rows.
        return sql`(CASE
          WHEN jsonb_typeof(${valueOf(condition.column)}) = 'number'
          THEN ${compare(op, sql`(${valueOf(condition.column)})::numeric`, sql`${value}`)}
          ELSE false
        END)`;
      }

      if (typeof value === 'boolean') {
        // `to_jsonb`, not `true::jsonb` — Postgres has no boolean-to-jsonb cast
        // and the latter raises "cannot cast type boolean to jsonb", failing
        // the whole query rather than the one comparison.
        if (op === 'neq') {
          // The third branch with the same three-valued problem: `NULL <> ...`
          // is NULL for a row with no such cell, so "not false" dropped every
          // blank row. `{op:'neq', value:false}` must return the same rows as
          // `{op:'neq', value:'false'}`.
          return sql`(${valueOf(condition.column)} IS NULL
            OR (${valueOf(condition.column)}) <> to_jsonb(${value}::boolean))`;
        }
        return compare(op, sql`(${valueOf(condition.column)})`, sql`to_jsonb(${value}::boolean)`);
      }

      if (op === 'neq') {
        // Three-valued logic: `cells -> 'X' ->> 'value'` is NULL for a row with
        // no cell in that column, and `NULL <> 'active'` is NULL, not true. A
        // plain `<>` therefore drops every blank row from "status is not
        // active" — the rows a person asking that question most wants to see.
        return sql`(${textOf(condition.column)} IS NULL OR ${textOf(condition.column)} <> ${scalarToText(value)})`;
      }

      return compare(op, textOf(condition.column), sql`${scalarToText(value)}`);
    }

    default:
      throw new SheetQueryError(`Unsupported operator: ${String(op)}`);
  }
}

/**
 * Comparison built from a fixed `switch`, so `op` can never carry SQL even if
 * the validation above were bypassed.
 *
 * A `switch` rather than a lookup table of `sql.raw` fragments, and evaluated
 * at CALL time rather than module scope. The table version ran `sql.raw` during
 * module initialisation, so importing this file — or anything that pulls in
 * `store.ts` — threw `TypeError: sql.raw is not a function` in any test that
 * mocks `@pagespace/db/operators`. That failed the CI job while all 10,277
 * tests still reported passing, because it is an unhandled error rather than an
 * assertion.
 */
function compare(op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte', left: SQL, right: SQL): SQL {
  switch (op) {
    case 'eq': return sql`${left} = ${right}`;
    case 'neq': return sql`${left} <> ${right}`;
    case 'gt': return sql`${left} > ${right}`;
    case 'gte': return sql`${left} >= ${right}`;
    case 'lt': return sql`${left} < ${right}`;
    case 'lte': return sql`${left} <= ${right}`;
  }
}

export interface SheetOrderBy {
  column: string;
  direction?: 'asc' | 'desc';
  /**
   * Sort ONLY on the numeric value, placing every non-numeric cell last.
   *
   * Rarely what you want — the default already orders numbers numerically. Use
   * this when a column is meant to be numeric and text in it is a data problem
   * you want herded to the end, not interleaved.
   */
  numeric?: boolean;
}

/**
 * Sort keys for a row query.
 *
 * A number sorts as a NUMBER by default. Sorting on the text form alone put
 * `290.5` above `28` above `250` — descending lexicographic order, silently
 * returned as if it were descending numeric order. For a query surface whose
 * whole purpose is "give me the top N rows by this column", that is the worst
 * kind of wrong: plausible, ordered, and incorrect. It was invisible in tests
 * and obvious the first time a real sheet was sorted through the API.
 *
 * Each key therefore compiles to TWO sort expressions: the numeric value, then
 * the text. Non-numeric cells have a NULL numeric key and sort last within the
 * key (`NULLS LAST` in both directions), where the text key orders them among
 * themselves. So a numeric column sorts numerically, a text column
 * lexicographically, and a mixed column groups its numbers away from its text
 * rather than interleaving them by digit.
 */
export function compileOrderBy(orderBy: SheetOrderBy[] | undefined): SQL | undefined {
  if (!orderBy || orderBy.length === 0) return undefined;
  if (orderBy.length > 8) throw new SheetQueryError('At most 8 sort keys');

  const parts = orderBy.flatMap((entry) => {
    // Branching on the direction rather than splicing it in, for the same
    // reason `compare` is a switch: no raw SQL construction anywhere here.
    const numericKey = sql`(CASE WHEN jsonb_typeof(${valueOf(entry.column)}) = 'number'
                       THEN (${valueOf(entry.column)})::numeric END)`;
    const direction = entry.direction === 'desc' ? sql`DESC NULLS LAST` : sql`ASC NULLS LAST`;

    const numericPart = sql`${numericKey} ${direction}`;
    if (entry.numeric) return [numericPart];
    return [numericPart, sql`${textOf(entry.column)} ${direction}`];
  });

  return sql.join(parts, sql`, `);
}

function requireString(condition: SheetCondition, op: string): string {
  if (typeof condition.value !== 'string' || condition.value.length === 0) {
    throw new SheetQueryError(`"${op}" needs a non-empty string`);
  }
  if (condition.value.length > 1000) {
    throw new SheetQueryError(`"${op}" value is too long`);
  }
  return condition.value;
}

function scalarToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    if (value.length > 1000) throw new SheetQueryError('Comparison value is too long');
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new SheetQueryError('Comparison value must be a string, number or boolean');
}

/**
 * Neutralise LIKE metacharacters in user input.
 *
 * Without this, searching for "50%" matches everything beginning "50", which
 * reads as a broken filter rather than an injection but is just as wrong.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
