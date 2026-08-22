/**
 * The sheet search predicates must not escape the filters they sit beside.
 *
 * Drizzle's `and()` parenthesises the GROUP but joins its conditions with a
 * bare ` and ` — it does not parenthesise each one. So an `A OR B` fragment
 * passed into `and(x, y, fragment)` renders as `(x and y and A OR B)`, and
 * because AND binds tighter than OR, `B` escapes every filter beside it.
 *
 * For a search predicate that means matching rows in other drives, in trashed
 * pages, and in pages explicitly excluded from search. This is the same
 * precedence trap that once let range dependencies leak across tabs, so it is
 * pinned here rather than left to a reviewer to notice a third time.
 */

import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { and, eq, sql } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { sheetCellsMatchIlike, sheetCellsMatchRegex } from '../sheets/search-sql';

const dialect = new PgDialect();
const render = (fragment: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(fragment).sql;

describe('sheet search predicates', () => {
  it('matches cell values, not the raw JSON payload', () => {
    const rendered = render(sheetCellsMatchIlike('%x%'));

    // Per-cell via jsonb_each, so anchors mean what they say and structural
    // keys like "raw"/"format" are not matchable.
    expect(rendered).toContain('jsonb_each');
    expect(rendered).toContain("payload ->> 'value'");
    expect(rendered).not.toContain('::text ~');
  });

  it('is a self-contained EXISTS, correlated on the page', () => {
    const rendered = render(sheetCellsMatchRegex('^Total$'));
    expect(rendered.trim().startsWith('EXISTS')).toBe(true);
    expect(rendered).toContain('"pageId"');
  });

  it('cannot escape sibling filters when combined with OR inside and()', () => {
    // The shape every call site uses.
    const guarded = and(
      eq(pages.driveId, 'drive-1'),
      eq(pages.isTrashed, false),
      sql`(${pages.content} ~ ${'p'} OR ${sheetCellsMatchRegex('p')})`
    );
    const rendered = render(guarded!);

    // The OR must be wrapped. Without the parens this renders as
    // `... and content ~ $1 OR EXISTS (...)`, and the EXISTS matches pages in
    // any drive, including trashed ones.
    expect(rendered).toMatch(/and \(.*OR EXISTS/s);

    const unguarded = and(
      eq(pages.driveId, 'drive-1'),
      sql`${pages.content} ~ ${'p'} OR ${sheetCellsMatchRegex('p')}`
    );
    // Demonstrates the hazard this test exists for: the same expression without
    // parens leaves the OR at the top level of the AND chain.
    expect(render(unguarded!)).not.toMatch(/and \(.*OR EXISTS/s);
  });
});
