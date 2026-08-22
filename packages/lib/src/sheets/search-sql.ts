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

function existsWhere(predicate: SQL): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM ${sheetRows}, jsonb_each(${sheetRows.cells}) AS cell(label, payload)
    WHERE ${sheetRows.pageId} = ${pages.id}
      AND ${predicate}
  )`;
}

/** True when any cell of the page matches `pattern` as a POSIX regex. */
export function sheetCellsMatchRegex(pattern: string): SQL {
  return existsWhere(sql`${CELL_TEXT} ~ ${pattern}`);
}

/** True when any cell of the page matches `pattern` as a case-insensitive LIKE. */
export function sheetCellsMatchIlike(pattern: string): SQL {
  return existsWhere(sql`${CELL_TEXT} ILIKE ${pattern}`);
}
