/**
 * The sheet filter compiler turns untrusted input into SQL.
 *
 * The filter arrives over MCP from a model, so these tests are less about
 * "does it find the rows" than about the two invariants that make the feature
 * safe to expose at all: every value becomes a bind parameter, and every column
 * is validated before it can name a jsonb key. Both are asserted by inspecting
 * the SQL that actually gets built, not by trusting the shape of the code.
 */

import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  compileWhere,
  compileOrderBy,
  assertColumn,
  SheetQueryError,
  MAX_FILTER_DEPTH,
  MAX_FILTER_CONDITIONS,
  MAX_IN_VALUES,
  type SheetWhere,
} from '../sheets/query';

const dialect = new PgDialect();

/** The SQL string and its bound parameters, as the driver would receive them. */
function build(where: SheetWhere) {
  const fragment = compileWhere(where);
  if (!fragment) throw new Error('expected a fragment');
  return dialect.sqlToQuery(fragment);
}

describe('column validation', () => {
  it('accepts ordinary column labels', () => {
    expect(assertColumn('a')).toBe('A');
    expect(assertColumn(' ab ')).toBe('AB');
  });

  it('accepts wide column labels, matching what the engine can address', () => {
    // `encodeColumnLabel` emits four letters happily and `columnCount` is
    // unbounded, so a narrower cap here would make later columns unfilterable
    // and unsortable — a 400 on entirely valid input.
    expect(assertColumn('ABCD')).toBe('ABCD');
    expect(assertColumn('value')).toBe('VALUE');
  });

  it.each([
    ['A1', 'an address rather than a column'],
    ["A'", 'a quote'],
    ['A;DROP TABLE sheet_rows', 'a statement'],
    ['*', 'a wildcard'],
    ['', 'empty'],
    ['ABCDEFGHI', 'past any addressable column'],
    ['A B', 'whitespace inside'],
    ['cells->1', 'a json path'],
  ])('rejects %s (%s)', (column) => {
    expect(() => assertColumn(column)).toThrow(SheetQueryError);
  });
});

describe('parameterisation', () => {
  it('binds string values instead of interpolating them', () => {
    const query = build({ column: 'F', op: 'eq', value: "active'; DROP TABLE sheet_rows;--" });

    expect(query.params).toContain("active'; DROP TABLE sheet_rows;--");
    expect(query.sql).not.toContain('DROP TABLE');
    expect(query.sql).toContain('$');
  });

  it('binds the column label rather than splicing it into the path', () => {
    const query = build({ column: 'F', op: 'eq', value: 'x' });
    // The label is a parameter to `->`, so it can never be read as SQL.
    expect(query.params).toContain('F');
  });

  it('binds numeric comparisons', () => {
    const query = build({ column: 'D', op: 'gt', value: 1000 });
    expect(query.params).toContain(1000);
    expect(query.sql).toContain('numeric');
    // Guarded so one text cell in the column cannot fail the whole query.
    expect(query.sql).toContain('jsonb_typeof');
  });

  it('guards the numeric cast with CASE, not AND', () => {
    // Postgres does not guarantee AND short-circuits, so
    // `jsonb_typeof(x) = 'number' AND (x)::numeric > $1` can evaluate the cast
    // first and raise 22023 on a column holding any text. That bug shipped
    // through an earlier version of this file and every assertion above still
    // passed — only executing it against a real database caught it. This pins
    // the construct whose evaluation order is actually defined.
    const query = build({ column: 'D', op: 'gt', value: 1000 });

    expect(query.sql).toContain('CASE');
    expect(query.sql).not.toMatch(/=\s*'number'\s*\n?\s*AND/i);
  });

  it('binds every member of an IN list', () => {
    const query = build({ column: 'F', op: 'in', value: ['a', 'b', "c'--"] });
    expect(query.params).toEqual(expect.arrayContaining(['a', 'b', "c'--"]));
    expect(query.sql).not.toContain("c'--");
  });
});

describe('LIKE handling', () => {
  it('escapes wildcards so a literal % is not a wildcard', () => {
    const query = build({ column: 'B', op: 'contains', value: '50%' });
    expect(query.params).toContain('%50\\%%');
    expect(query.sql).toContain("ESCAPE");
  });

  it('escapes underscores too', () => {
    expect(build({ column: 'B', op: 'startsWith', value: 'a_b' }).params).toContain('a\\_b%');
  });

  it('escapes a backslash so the escape character itself is literal', () => {
    expect(build({ column: 'B', op: 'contains', value: 'a\\b' }).params).toContain('%a\\\\b%');
  });
});

describe('boolean structure', () => {
  it('joins and/or with the right operator', () => {
    expect(build({ and: [{ column: 'A', op: 'isEmpty' }, { column: 'B', op: 'isNotEmpty' }] }).sql)
      .toContain(' AND ');
    expect(build({ or: [{ column: 'A', op: 'isEmpty' }, { column: 'B', op: 'isNotEmpty' }] }).sql)
      .toContain(' OR ');
  });

  it('negates', () => {
    expect(build({ not: { column: 'A', op: 'isEmpty' } }).sql).toContain('NOT');
  });

  it('rejects an empty group rather than emitting a tautology', () => {
    expect(() => build({ and: [] })).toThrow(SheetQueryError);
    expect(() => build({ or: [] })).toThrow(SheetQueryError);
  });

  it('returns undefined for no filter, so the caller omits WHERE', () => {
    expect(compileWhere(undefined)).toBeUndefined();
  });
});

describe('resource bounds', () => {
  it('refuses a filter nested past the depth limit', () => {
    let node: SheetWhere = { column: 'A', op: 'isEmpty' };
    for (let i = 0; i <= MAX_FILTER_DEPTH + 1; i++) node = { and: [node] };
    expect(() => build(node)).toThrow(/nested deeper/);
  });

  it('refuses a filter with too many conditions', () => {
    const many = Array.from({ length: MAX_FILTER_CONDITIONS + 1 }, () => ({
      column: 'A' as const, op: 'isEmpty' as const,
    }));
    expect(() => build({ and: many })).toThrow(/conditions/);
  });

  it('refuses an oversized IN list', () => {
    const values = Array.from({ length: MAX_IN_VALUES + 1 }, (_, i) => String(i));
    expect(() => build({ column: 'A', op: 'in', value: values })).toThrow(/at most/);
  });

  it('refuses an over-long comparison value', () => {
    expect(() => build({ column: 'A', op: 'eq', value: 'x'.repeat(1001) })).toThrow(/too long/);
  });
});

describe('operator validation', () => {
  it('rejects an unknown operator', () => {
    expect(() => build({ column: 'A', op: 'DROP' as never })).toThrow(/Unsupported operator/);
  });

  it('rejects a non-finite number', () => {
    expect(() => build({ column: 'A', op: 'gt', value: Number.NaN })).toThrow(/finite/);
  });

  it('rejects a value that is neither scalar nor array', () => {
    expect(() => build({ column: 'A', op: 'eq', value: { nested: 1 } })).toThrow(SheetQueryError);
  });

  it('rejects an empty needle for a text operator', () => {
    expect(() => build({ column: 'A', op: 'contains', value: '' })).toThrow(/non-empty string/);
  });
});

describe('compileOrderBy', () => {
  it('validates its columns like everything else', () => {
    expect(() => compileOrderBy([{ column: 'A; DROP TABLE x' }])).toThrow(SheetQueryError);
  });

  it('sorts numerically without failing on text cells', () => {
    const fragment = compileOrderBy([{ column: 'D', numeric: true, direction: 'desc' }]);
    const query = dialect.sqlToQuery(fragment!);
    expect(query.sql).toContain('DESC');
    expect(query.sql).toContain('NULLS LAST');
    expect(query.sql).toContain('jsonb_typeof');
  });

  it('caps the number of sort keys', () => {
    const keys = Array.from({ length: 9 }, () => ({ column: 'A' }));
    expect(() => compileOrderBy(keys)).toThrow(/8 sort keys/);
  });

  it('returns undefined when unsorted', () => {
    expect(compileOrderBy(undefined)).toBeUndefined();
    expect(compileOrderBy([])).toBeUndefined();
  });
});
