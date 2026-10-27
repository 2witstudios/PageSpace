/**
 * @module @pagespace/lib/sheets/search-sql
 * @description Predicates that let a sheet be found by its contents.
 *
 * A sheet's text lives in `sheet_rows`, not `pages.content` — that column is
 * empty once a sheet has been materialised. Every search that filters on
 * `pages.content` alone therefore stops finding spreadsheets entirely, which is
 * the worst possible failure for a search box: the pages most likely to hold
 * the string somebody typed are the ones that silently disappear.
 *
 * Matching is per CELL VALUE rather than over `cells::text`. Running a pattern
 * across the raw JSON matches structural keys (`raw`, `value`, `format`),
 * misses anything containing a quote or backslash because the payload is
 * JSON-escaped, and makes anchors meaningless — `^Total` could never match,
 * since the whole row is one string.
 *
 * These are sequential scans. A searchable projection per sheet is the eventual
 * fix; correctness first.
 */

import { sql, type SQL } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { sheetRows } from '@pagespace/db/schema/sheets';

/** The text a cell contributes to search: its computed value, else its raw text. */
const CELL_TEXT = sql`coalesce(payload ->> 'value', payload ->> 'raw', '')`;

/**
 * True when any cell of THIS row matches — for a query already scoped to
 * `sheet_rows`, which is how a caller finds the rows to quote in a result
 * excerpt rather than merely learning that the page matched somewhere.
 */
function rowMatches(predicate: SQL): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM jsonb_each(${sheetRows.cells}) AS cell(label, payload)
    WHERE ${predicate}
  )`;
}

function pageHasMatchingRow(predicate: SQL): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM ${sheetRows}
    WHERE ${sheetRows.pageId} = ${pages.id}
      AND ${rowMatches(predicate)}
  )`;
}

const regexPredicate = (pattern: string): SQL => sql`${CELL_TEXT} ~ ${pattern}`;
const ilikePredicate = (pattern: string): SQL => sql`${CELL_TEXT} ILIKE ${pattern}`;

/** True when any cell of the page matches `pattern` as a POSIX regex. */
export function sheetCellsMatchRegex(pattern: string): SQL {
  return pageHasMatchingRow(regexPredicate(pattern));
}

/** True when any cell of the page matches `pattern` as a case-insensitive LIKE. */
export function sheetCellsMatchIlike(pattern: string): SQL {
  return pageHasMatchingRow(ilikePredicate(pattern));
}

/** Row-scoped form of {@link sheetCellsMatchRegex}. */
export function sheetRowMatchesRegex(pattern: string): SQL {
  return rowMatches(regexPredicate(pattern));
}

/**
 * Row-scoped form of {@link sheetCellsMatchIlike}.
 *
 * Several patterns are OR-ed, matching the "any word" rule the search
 * endpoint's page-level condition uses — one query per page instead of one per
 * word, and the same semantics, so a row can never match the page filter yet
 * be missing from the excerpt.
 */
export function sheetRowMatchesIlike(pattern: string | readonly string[]): SQL {
  const patterns = typeof pattern === 'string' ? [pattern] : pattern;
  if (patterns.length === 0) return sql`false`;
  // Parenthesised: `rowMatches` drops this into a WHERE clause, and an
  // unparenthesised OR chain is exactly how an earlier revision of the
  // page-level predicate escaped its surrounding filters.
  return rowMatches(
    sql`(${sql.join(
      patterns.map((one) => ilikePredicate(one)),
      sql` OR `
    )})`
  );
}
