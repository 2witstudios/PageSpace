/**
 * The agent-facing sheet window (issue #2467).
 *
 * These cases pin the properties an agent depends on and cannot check for
 * itself: that the number printed in front of a row is the row's A1 row, that
 * columns past Z stay in sheet order, that a formula survives the read as a
 * formula, and that a sheet whose rows were never migrated still reads as its
 * data rather than as an empty spreadsheet.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

const mockGetTab = vi.fn();
const mockListTabs = vi.fn();
const mockReadRows = vi.fn();

vi.mock('@pagespace/lib/sheets/store', () => ({
  getTab: (...args: unknown[]) => mockGetTab(...args as []),
  listTabs: (...args: unknown[]) => mockListTabs(...args as []),
  readRows: (...args: unknown[]) => mockReadRows(...args as []),
}));

import { serializeSheetContent } from '@pagespace/lib/sheets/io';
import {
  SheetDocumentUnreadableError,
  SheetTabNotFoundError,
  TABLE_CELL_CHAR_LIMIT,
  columnsInRows,
  loadSheetWindow,
  renderSheetTable,
  renderSheetTableWithinBudget,
  toSheetViewRow,
} from '../sheet-view';

const tab = {
  id: 'tab-1',
  tabIndex: 0,
  name: 'Sheet1',
  rowCount: 500,
  columnCount: 16,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockListTabs.mockResolvedValue([tab]);
  mockGetTab.mockResolvedValue(tab);
  mockReadRows.mockResolvedValue([]);
});

describe('column ordering', () => {
  it('orders columns the way a sheet does, not the way strings do', () => {
    // Asserted through the exported surface rather than the comparator, so it
    // pins what a caller can observe: plain string order would put AA next to
    // A and silently reorder every sheet wider than 26 columns.
    assert({
      given: 'a row filling a mix of one- and two-letter columns',
      should: 'put every one-letter column before AA',
      actual: columnsInRows([
        toSheetViewRow(0, {
          B: { raw: '1', value: 1 },
          AA: { raw: '2', value: 2 },
          A: { raw: '3', value: 3 },
          Z: { raw: '4', value: 4 },
          AB: { raw: '5', value: 5 },
        }),
      ]),
      expected: ['A', 'B', 'Z', 'AA', 'AB'],
    });
  });
});

describe('toSheetViewRow', () => {
  it('numbers a row by its A1 row, not its storage index', () => {
    // The whole point of the number in front of a row: an agent that reads row
    // 417 has to be able to write C417 without an off-by-one.
    assert({
      given: 'the stored row at index 416',
      should: 'report rowNumber 417',
      actual: toSheetViewRow(416, { A: { raw: 'x', value: 'x' } }).rowNumber,
      expected: 417,
    });
  });

  it('keeps a formula and its computed value apart', () => {
    const row = toSheetViewRow(1, {
      A: { raw: '5', value: 5 },
      B: { raw: '=A2*2', value: 10 },
    });

    assert({
      given: 'a literal and a formula cell',
      should: 'show both as their computed values',
      actual: row.cells,
      expected: { A: '5', B: '10' },
    });
    assert({
      given: 'a formula cell',
      should: 'carry the authored formula separately, so the read does not lose it',
      actual: row.formulas,
      expected: { B: '=A2*2' },
    });
  });

  it('renders a number the same way whether the sheet is migrated or not', () => {
    // The document path stores the evaluator's formatted display; the row store
    // keeps the raw primitive. Rendering the raw one directly showed a float as
    // 0.30000000000000004 after migration and 0.3 before — and 0.3 is what the
    // editor shows.
    const row = toSheetViewRow(0, {
      A: { raw: '=A1+B1', value: 0.30000000000000004 },
      B: { raw: '=X', value: 12345678901234 },
    });

    assert({
      given: 'materialised numbers straight from the row store',
      should: 'format them through the same function the evaluator uses',
      actual: row.cells,
      expected: { A: '0.3', B: '1.23456789012e+13' },
    });
  });

  it('applies the cell number format, as the evaluator does', () => {
    // The document path stores `evaluated.display`, which has had the cell's
    // number format applied. Formatting only the raw value showed a currency
    // column as $1,200.00 before migration and 1200 after — so an agent
    // filtering on a value it read earlier, or reconciling against what the
    // user sees on screen, matched nothing.
    const row = toSheetViewRow(0, {
      B: { raw: '1200', value: 1200, format: { number: { kind: 'currency', currency: 'USD', decimals: 2 } } },
      C: { raw: '0.85', value: 0.85, format: { number: { kind: 'percent', decimals: 0 } } },
    });

    expect(row.cells.B).toContain('1,200');
    expect(row.cells.C).toContain('85');
    expect(row.cells.C).toContain('%');
  });

  it('reports an errored cell as an error rather than as its own source text', () => {
    const row = toSheetViewRow(0, {
      C: { raw: '=OTHER!A1', error: { type: 'error', message: 'Cross-page references are not supported in this context' } },
    });

    expect(row.cells.C).toBe('#ERROR');
    expect(row.errors).toEqual({
      C: 'Cross-page references are not supported in this context',
    });
  });

  it('renders a formula that evaluates to blank as blank, not as its own source', () => {
    // `=IF(A2>0,"ok","")` with A2 = 0 materialises as ''. Treating that as "no
    // value" showed the formula text where the spreadsheet shows an empty cell
    // — while `where: isEmpty` matched the same row, because the filter reads
    // the stored ''. Two reads of one cell disagreeing.
    const row = toSheetViewRow(0, {
      B: { raw: '=IF(A2>0,"ok","")', value: '' },
    });

    expect(row.cells.B).toBe('');
    // The formula itself is still recoverable.
    expect(row.formulas).toEqual({ B: '=IF(A2>0,"ok","")' });
  });

  it('keeps a formatted blank blank, rather than formatting the empty value', () => {
    // A blank cell in a currency or text column must stay blank. `text` and
    // `currency` formats both happily render an empty value into something
    // ("" -> "" for text, but a number format can produce a zero), so the
    // emptiness is checked before any formatting is applied.
    const row = toSheetViewRow(0, {
      A: { raw: '', value: '', format: { number: { kind: 'text' } } },
      B: { raw: '=IF(1>2,1,"")', value: '', format: { number: { kind: 'currency', currency: 'USD', decimals: 2 } } },
    });

    expect(row.cells.A).toBeUndefined();  // an empty literal is omitted entirely
    expect(row.cells.B).toBe('');         // an empty formula result is blank, not $0.00
  });

  it('omits empty cells instead of emitting a blank for every column', () => {
    // A 500x16 sheet is mostly empty. Emitting every empty cell would put the
    // payload straight back where the raw TOML dump left it.
    assert({
      given: 'a row where only one of three columns holds a value',
      should: 'return only that column',
      actual: toSheetViewRow(0, {
        A: { raw: '', value: '' },
        B: { raw: 'kept', value: 'kept' },
        C: { raw: '' },
      }).cells,
      expected: { B: 'kept' },
    });
  });
});

describe('column-level formats', () => {
  it('applies a tab column format, which is never denormalised onto the cell', async () => {
    // `sheetDataToRows` copies only `sheet.formats[address]` onto a cell;
    // column formats live on `sheet_tabs.columnFormats`. Resolving just the
    // cell format left the common case — a column formatted as currency —
    // reading $1,200.00 from the document path and the UI, and 1200 from the
    // row store.
    mockListTabs.mockResolvedValue([tab]);
    mockGetTab.mockResolvedValue({
      ...tab,
      columnFormats: { B: { number: { kind: 'currency', currency: 'USD', decimals: 2 } } },
    });
    mockReadRows.mockResolvedValue([
      { rowIndex: 0, cells: { B: { raw: '1200', value: 1200 } } },
    ]);

    const window = await loadSheetWindow('page-1', { limit: 10 });
    expect(window.rows[0].cells.B).toContain('1,200');
  });

  it('lets a cell own format win over the column default', async () => {
    mockListTabs.mockResolvedValue([tab]);
    mockGetTab.mockResolvedValue({
      ...tab,
      columnFormats: { B: { number: { kind: 'currency', currency: 'USD', decimals: 2 } } },
    });
    mockReadRows.mockResolvedValue([
      { rowIndex: 0, cells: { B: { raw: '0.85', value: 0.85, format: { number: { kind: 'percent', decimals: 0 } } } } },
    ]);

    const window = await loadSheetWindow('page-1', { limit: 10 });
    expect(window.rows[0].cells.B).toContain('%');
  });
});

describe('the two paths render one cell one way', () => {
  // THE property, asserted directly. Three consecutive review passes found a
  // different way this had been broken — raw numbers, then cell formats, then
  // column formats — because each fix targeted the instance it was handed. A
  // test per instance cannot catch the next one; this drives the SAME cell data
  // through both paths and compares.
  //
  // The fixture must make formatting MATTER, or the comparison is vacuous: an
  // earlier version of this test used unformatted numbers, passed happily, and
  // caught none of the three regressions when I mutated them back in.
  const sheet = {
    version: 1,
    rowCount: 3,
    columnCount: 3,
    sheetName: 'Money',
    cells: {
      A1: 'label',
      B1: '1200',
      C1: '=B1/4',
      // Deliberately in an UNFORMATTED column: a number format would
      // short-circuit `formatDisplayValue` and mask a regression there.
      C2: '0.30000000000000004',
    },
    // Column-level, which is the case that is never denormalised onto a cell.
    columnFormats: { B: { number: { kind: 'currency' as const, currency: 'USD', decimals: 2 } } },
  };

  it('agrees on values and formulas for the same rows, formats included', async () => {
    mockListTabs.mockResolvedValue([]);
    const fromDocument = await loadSheetWindow('page-1', {
      limit: 10,
      documentContent: serializeSheetContent(sheet, { pageId: 'page-1' }),
    });

    // The same cells as the row store holds them: raw + materialised value,
    // with the column format on the TAB rather than on any cell.
    mockListTabs.mockResolvedValue([tab]);
    mockGetTab.mockResolvedValue({
      ...tab,
      rowCount: 3,
      columnCount: 3,
      columnFormats: sheet.columnFormats,
    });
    mockReadRows.mockResolvedValue([
      {
        rowIndex: 0,
        cells: {
          A: { raw: 'label', value: 'label' },
          B: { raw: '1200', value: 1200 },
          C: { raw: '=B1/4', value: 300 },
        },
      },
      { rowIndex: 1, cells: { C: { raw: '0.30000000000000004', value: 0.30000000000000004 } } },
    ]);
    const fromStore = await loadSheetWindow('page-1', { limit: 10 });

    // Guard the guard: if the fixture stops exercising formatting, this test
    // silently stops proving anything.
    expect(fromDocument.rows[0].cells.B).toContain('1,200');          // a format is applied
    expect(fromDocument.rows[1].cells.C).toBe('0.3');                  // and an unformatted number is still normalised

    assert({
      given: 'the same cells before and after migration, with a column format',
      should: 'render identical values',
      actual: fromStore.rows.map(r => r.cells),
      expected: fromDocument.rows.map(r => r.cells),
    });
    assert({
      given: 'a formula cell before and after migration',
      should: 'preserve the formula identically',
      actual: fromStore.rows[0].formulas,
      expected: fromDocument.rows[0].formulas,
    });
  });
});

describe('renderSheetTable', () => {
  const rows = [
    toSheetViewRow(0, { A: { raw: 'memid', value: 'memid' }, B: { raw: 'name', value: 'name' } }),
    toSheetViewRow(1, { A: { raw: '28605', value: 28605 }, B: { raw: 'Acme', value: 'Acme' } }),
  ];

  it('prefixes each line with the sheet row number', () => {
    assert({
      given: 'two rows of a sheet',
      should: 'render a column header plus one numbered line per row',
      actual: renderSheetTable(rows).text,
      expected: 'columns→A | B\n1→memid | name\n2→28605 | Acme',
    });
  });

  it('escapes a newline inside a cell so one cell cannot become two rows', () => {
    const multiline = toSheetViewRow(0, { A: { raw: 'one\ntwo', value: 'one\ntwo' } });
    const table = renderSheetTable([multiline]).text;

    expect(table.split('\n')).toHaveLength(2);
    expect(table).toContain('1→one\\ntwo');
  });

  it('keeps a projected column that is empty in every returned row', () => {
    // With `select`, the projected columns ARE the answer: dropping one because
    // no row happened to fill it would report a column as absent when the
    // caller asked for it by name.
    const table = renderSheetTable(
      [toSheetViewRow(0, { A: { raw: 'x', value: 'x' } })],
      ['A', 'C']
    ).text;
    expect(table.split('\n')[0]).toBe('columns→A | C');
  });

  it('escapes the column delimiter so one cell cannot become several', () => {
    // A cell containing " | " would otherwise produce a row with more apparent
    // columns than the header, shifting every value after it onto the wrong
    // column letter — silently, and only for the rows that contain one.
    const piped = toSheetViewRow(0, {
      A: { raw: 'a | b', value: 'a | b' },
      B: { raw: 'plain', value: 'plain' },
    });
    const line = renderSheetTable([piped]).text.split('\n')[1];

    expect(line).toBe('1→a \\| b | plain');
    // Exactly one real delimiter, so the row still parses as two columns.
    expect(line.split(' | ')).toHaveLength(2);
  });

  it('escapes the escape character, so every sequence decodes to one original', () => {
    // Flagged by CodeQL as incomplete escaping, and it is a real ambiguity:
    // escaping only the newline and the pipe left a cell holding the literal
    // text `a\|b` indistinguishable from one holding `a|b`, so a reader could
    // not tell an escaped delimiter from a backslash followed by a real one.
    const literalEscape = String.raw`a\|b`;   // backslash, pipe, b
    const realPipe = 'a|b';

    const a = renderSheetTable([toSheetViewRow(0, { A: { raw: literalEscape, value: literalEscape } })]).text;
    const b = renderSheetTable([toSheetViewRow(0, { A: { raw: realPipe, value: realPipe } })]).text;

    // The two must not collide — that collision was the bug.
    expect(a).not.toBe(b);
    expect(a.split('\n')[1]).toBe(String.raw`1→a\\\|b`);
    expect(b.split('\n')[1]).toBe(String.raw`1→a\|b`);
  });

  it('escapes a literal backslash-n distinctly from a real newline', () => {
    const literal = String.raw`one\ntwo`;   // backslash, n
    const actual = 'one\ntwo';              // a real newline

    const a = renderSheetTable([toSheetViewRow(0, { A: { raw: literal, value: literal } })]).text;
    const b = renderSheetTable([toSheetViewRow(0, { A: { raw: actual, value: actual } })]).text;

    expect(a).not.toBe(b);
  });

  it('never cuts an escape sequence in half', () => {
    // Cutting the ESCAPED string could land between the two halves of an
    // escaped backslash, leaving an odd number of them before the ellipsis —
    // the reader then cannot decode that cell, which is the exact ambiguity
    // the escaping exists to remove.
    const backslashes = '\\'.repeat(TABLE_CELL_CHAR_LIMIT + 20);
    const rendered = renderSheetTable([toSheetViewRow(0, { A: { raw: backslashes, value: backslashes } })]);
    const line = rendered.text.split('\n')[1];
    const body = line.slice('1→'.length).replace(/…$/, '');

    // Every backslash is escaped as a pair, so the rendered run must be even.
    expect(body.length % 2).toBe(0);
    expect(rendered.truncatedCells).toBe(1);
  });

  it('counts the cut against the ORIGINAL text, as the message claims', () => {
    // Measuring the escaped form cut a pipe-heavy cell at ~60 real characters
    // while telling the model it had been cut at 120.
    const pipes = '|'.repeat(TABLE_CELL_CHAR_LIMIT);
    const rendered = renderSheetTable([toSheetViewRow(0, { A: { raw: pipes, value: pipes } })]);

    // Exactly at the limit in original characters — nothing should be cut.
    expect(rendered.truncatedCells).toBe(0);
    expect(rendered.text).not.toContain('…');
  });

  it('reports how many cells it had to cut, so truncation is stated not inferred', () => {
    // The table is a rendering; `rows` beside it always carries the full value.
    // A reader working from the table alone could otherwise copy a shortened
    // string back into a write and never know.
    const long = 'x'.repeat(TABLE_CELL_CHAR_LIMIT + 50);
    const rendered = renderSheetTable([
      toSheetViewRow(0, { A: { raw: long, value: long }, B: { raw: 'short', value: 'short' } }),
    ]);

    expect(rendered.truncatedCells).toBe(1);
    expect(rendered.text).toContain('…');
    expect(rendered.text).not.toContain(long);
  });

  it('cuts a long cell on a code-point boundary, not a UTF-16 unit', () => {
    // Slicing mid-surrogate emits a lone half that rides into the tool result
    // and renders as U+FFFD.
    // Comfortably past the limit in CODE POINTS: exactly TABLE_CELL_CHAR_LIMIT
    // emoji is 2x that in UTF-16 units and must NOT be reported as cut.
    const astral = '\u{1F600}'.repeat(TABLE_CELL_CHAR_LIMIT + 10);
    const rendered = renderSheetTable([toSheetViewRow(0, { A: { raw: astral, value: astral } })]);

    expect(rendered.truncatedCells).toBe(1);
    expect(rendered.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(rendered.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('measures the cell in code points, so a whole value is never flagged as cut', () => {
    // 120 emoji is 240 UTF-16 units. Measuring in units while cutting in code
    // points flagged it as truncated, appended an ellipsis, and warned the
    // reader not to write back a value that was complete.
    const exactly = '\u{1F600}'.repeat(TABLE_CELL_CHAR_LIMIT);
    const rendered = renderSheetTable([toSheetViewRow(0, { A: { raw: exactly, value: exactly } })]);

    expect(rendered.truncatedCells).toBe(0);
    expect(rendered.text).not.toContain('…');
  });

  it('reports nothing cut when nothing was cut', () => {
    const rendered = renderSheetTable([toSheetViewRow(0, { A: { raw: 'fits', value: 'fits' } })]);
    expect(rendered.truncatedCells).toBe(0);
  });
});

describe('renderSheetTableWithinBudget', () => {
  it('does not claim a row when the cut left none', () => {
    // The drop loop stops at one row, so a single row wider than the budget is
    // cut back to the header and no data row survives. Reporting one made both
    // callers announce "First 1 row(s) below" above nothing.
    const wide = toSheetViewRow(0, {
      A: { raw: 'x'.repeat(400), value: 'x'.repeat(400) },
    });

    const bounded = renderSheetTableWithinBudget([wide], 60);
    expect(bounded.rowsShown).toBe(0);
  });

  it('keeps as many rows as the budget allows, not merely one', () => {
    // The proportional estimate must not overshoot downward: shedding to a
    // single row whenever the budget bites would make every wide-sheet preview
    // useless while still passing a "fits the budget" assertion.
    const rows = Array.from({ length: 100 }, (_, i) =>
      toSheetViewRow(i, { A: { raw: `row-${i}`, value: `row-${i}` } }));

    const bounded = renderSheetTableWithinBudget(rows, 400);

    expect(bounded.text.length).toBeLessThanOrEqual(400);
    expect(bounded.rowsShown).toBeGreaterThan(20);
    // And it reports exactly what it kept.
    expect(bounded.text.split('\n')).toHaveLength(bounded.rowsShown + 1);
  });

  it('reports the rows it actually kept', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      toSheetViewRow(i, { A: { raw: `r${i}`, value: `r${i}` } }));

    const bounded = renderSheetTableWithinBudget(rows, 10_000);
    expect(bounded.rowsShown).toBe(5);
    expect(bounded.text.split('\n')).toHaveLength(6); // header + 5
  });
});

describe('columnsInRows', () => {
  it('collects every column any row has, in sheet order', () => {
    assert({
      given: 'rows that fill different columns',
      should: 'return the union, ordered as a sheet orders columns',
      actual: columnsInRows([
        toSheetViewRow(0, { AB: { raw: '1', value: 1 }, A: { raw: '2', value: 2 } }),
        toSheetViewRow(1, { B: { raw: '3', value: 3 } }),
      ]),
      expected: ['A', 'B', 'AB'],
    });
  });
});

describe('loadSheetWindow — materialised sheet', () => {
  it('reads a positional window and says where to continue', async () => {
    mockReadRows.mockResolvedValue([
      { rowIndex: 4, cells: { A: { raw: 'five', value: 'five' } } },
      { rowIndex: 5, cells: { A: { raw: 'six', value: 'six' } } },
    ]);

    const window = await loadSheetWindow('page-1', { fromRow: 4, limit: 2 });

    expect(mockReadRows).toHaveBeenCalledWith('tab-1', { fromRow: 4, limit: 2 });
    expect(window.materialized).toBe(true);
    expect(window.rows.map((row) => row.rowNumber)).toEqual([5, 6]);
    assert({
      given: 'a window that ends before the last row of the sheet',
      should: 'point at the next row POSITION rather than a count of rows read',
      actual: { nextFromRow: window.nextFromRow, hasMore: window.hasMore },
      expected: { nextFromRow: 6, hasMore: true },
    });
  });

  it('does not report more rows once the window reaches the end', async () => {
    mockGetTab.mockResolvedValue({ ...tab, rowCount: 2 });
    mockListTabs.mockResolvedValue([{ ...tab, rowCount: 2 }]);
    mockReadRows.mockResolvedValue([
      { rowIndex: 0, cells: { A: { raw: 'a', value: 'a' } } },
      { rowIndex: 1, cells: { A: { raw: 'b', value: 'b' } } },
    ]);

    const window = await loadSheetWindow('page-1', { limit: 50 });
    expect(window.hasMore).toBe(false);
  });

  it('reads the requested tab of a materialised sheet, and reports all of them', async () => {
    // The multi-tab success path on the row store, alongside the refusal case
    // below: asking for tab 1 must read tab 1's rows and identify them as
    // such, not quietly serve tab 0's.
    const second = { id: 'tab-2', tabIndex: 1, name: 'Archive', rowCount: 12, columnCount: 3 };
    mockListTabs.mockResolvedValue([tab, second]);
    mockGetTab.mockImplementation(async (ref: { tabIndex?: number }) =>
      (ref.tabIndex ?? 0) === 1 ? second : tab
    );
    mockReadRows.mockResolvedValue([
      { rowIndex: 0, cells: { A: { raw: 'archived', value: 'archived' } } },
    ]);

    const window = await loadSheetWindow('page-1', { tabIndex: 1, limit: 10 });

    expect(mockReadRows).toHaveBeenCalledWith('tab-2', { fromRow: 0, limit: 10 });
    assert({
      given: 'tabIndex 1 on a materialised two-tab sheet',
      should: 'read that tab and report its own name and dimensions',
      actual: { tabIndex: window.tabIndex, tabName: window.tabName, rowCount: window.rowCount },
      expected: { tabIndex: 1, tabName: 'Archive', rowCount: 12 },
    });
    expect(window.tabs).toHaveLength(2);
  });

  it('takes a short page as proof that nothing follows, whatever the tab declares', async () => {
    // A tab's rowCount is the GRID height, not how many rows hold data: 500
    // declared, data only to row 60 is an ordinary shape. Deriving hasMore from
    // the declared count claimed more rows after the window that already held
    // the last one, costing a guaranteed empty round trip every time.
    mockReadRows.mockResolvedValue(
      Array.from({ length: 21 }, (_, index) => ({
        rowIndex: 40 + index,
        cells: { A: { raw: `r${index}`, value: `r${index}` } },
      })),
    );

    const window = await loadSheetWindow('page-1', { fromRow: 40, limit: 25 });

    assert({
      given: 'a short page from a tab that declares 500 rows',
      should: 'report no further rows, because a short page proves there are none',
      actual: { rows: window.rows.length, hasMore: window.hasMore },
      expected: { rows: 21, hasMore: false },
    });
  });

  it('takes a full page as a reason there may be more', async () => {
    mockReadRows.mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => ({
        rowIndex: index,
        cells: { A: { raw: `r${index}`, value: `r${index}` } },
      })),
    );

    const window = await loadSheetWindow('page-1', { limit: 25 });
    expect(window.hasMore).toBe(true);
    expect(window.nextFromRow).toBe(25);
  });

  it('never fetches more than the agent-facing row cap, whatever it is asked for', async () => {
    await loadSheetWindow('page-1', { limit: 100_000 });
    const [, options] = mockReadRows.mock.calls[0] as [string, { limit: number }];
    expect(options.limit).toBe(500);
  });
});

describe('loadSheetWindow — sheet not migrated to row storage', () => {
  const document = [
    '#%PAGESPACE_SHEETDOC v1',
    'page_id = "page-1"',
    '',
    '[[sheets]]',
    'name = "Legacy"',
    'order = 0',
    '',
    '[sheets.meta]',
    'row_count = 3',
    'column_count = 2',
    '',
    '[sheets.cells.A1]',
    'value = "Item"',
    'type = "string"',
    '',
    '[sheets.cells.B2]',
    'value = 1200',
    'type = "number"',
    '',
    '[sheets.cells.B3]',
    'formula = "=B2*2"',
    'value = 2400',
    'type = "number"',
  ].join('\n');

  beforeEach(() => {
    // No tabs in the row store: the sheet predates it, or was never re-saved.
    mockListTabs.mockResolvedValue([]);
  });

  it('reads the stored document rather than reporting an empty spreadsheet', async () => {
    const window = await loadSheetWindow('page-1', { limit: 25, documentContent: document });

    expect(window.materialized).toBe(false);
    expect(window.rows.map((row) => row.rowNumber)).toEqual([1, 2, 3]);
    expect(window.rows[0].cells).toEqual({ A: 'Item' });
    expect(window.columnCount).toBe(2);
  });

  it('shows a formula cell as its computed value, with the formula alongside', async () => {
    const window = await loadSheetWindow('page-1', { limit: 25, documentContent: document });
    const row3 = window.rows.find((row) => row.rowNumber === 3);

    assert({
      given: 'a formula in an unmigrated sheet',
      should: 'read as its result, not as its source text',
      actual: row3?.cells,
      expected: { B: '2400' },
    });
    expect(row3?.formulas).toEqual({ B: '=B2*2' });
  });

  it('never triggers a write to read', async () => {
    // Materialising a sheet inserts tabs, rows and dependency edges. A reader
    // who may only have view access must not cause that, so the document path
    // touches nothing in the store beyond looking for tabs.
    await loadSheetWindow('page-1', { limit: 25, documentContent: document });
    expect(mockGetTab).not.toHaveBeenCalled();
    expect(mockReadRows).not.toHaveBeenCalled();
  });

  it('pages a document-backed sheet from the requested row', async () => {
    const window = await loadSheetWindow('page-1', { fromRow: 1, limit: 1, documentContent: document });

    expect(window.rows.map((row) => row.rowNumber)).toEqual([2]);
    expect(window.hasMore).toBe(true);
    expect(window.nextFromRow).toBe(2);
  });
});

describe('loadSheetWindow — projection', () => {
  it('projects the structured rows, not just the rendered table', () => {
    // Narrowing only the table would return every column in `rows` while
    // reporting the narrow column list: a bigger payload that looks smaller,
    // which is the opposite of what `select` was asked to do.
    const row = toSheetViewRow(
      0,
      {
        A: { raw: 'keep', value: 'keep' },
        B: { raw: 'drop', value: 'drop' },
        C: { raw: '=A1&"x"', value: 'keepx' },
      },
      new Set(['A', 'C']),
    );

    assert({
      given: 'a projection of columns A and C',
      should: 'drop column B from the structured cells',
      actual: row.cells,
      expected: { A: 'keep', C: 'keepx' },
    });
  });

  it('projects formulas and errors alongside the values', () => {
    const row = toSheetViewRow(
      0,
      {
        A: { raw: '=1+1', value: 2 },
        B: { raw: '=BAD()', error: { type: 'error', message: 'nope' } },
      },
      new Set(['A']),
    );

    expect(row.formulas).toEqual({ A: '=1+1' });
    expect(row.errors).toBeUndefined();
  });

  it('applies select on the row-store path', async () => {
    mockReadRows.mockResolvedValue([
      { rowIndex: 0, cells: { A: { raw: 'a', value: 'a' }, B: { raw: 'b', value: 'b' } } },
    ]);

    const window = await loadSheetWindow('page-1', { limit: 10, select: ['a'] });
    assert({
      given: 'select given in lower case',
      should: 'match the upper-case column labels rows are keyed by',
      actual: window.rows[0].cells,
      expected: { A: 'a' },
    });
  });
});

describe('loadSheetWindow — what counts as "not a sheet"', () => {
  beforeEach(() => { mockListTabs.mockResolvedValue([]); });

  it('treats an empty legacy-JSON sheet as a real, writable sheet', () => {
    // It parses to a perfectly valid EMPTY sheet. Calling it text told the
    // agent not to write to a sheet that is genuinely empty and safe to write.
    return loadSheetWindow('page-1', {
      limit: 10,
      documentContent: '{"cells":{},"rowCount":20,"columnCount":10}',
    }).then((window) => {
      expect(window.documentIsNotASheet).toBe(false);
    });
  });

  it('treats arbitrary text on a SHEET page as not a sheet', () => {
    return loadSheetWindow('page-1', {
      limit: 10,
      documentContent: '<p>Never a grid</p>',
    }).then((window) => {
      expect(window.documentIsNotASheet).toBe(true);
    });
  });
});

describe('loadSheetWindow — refusals', () => {
  const multiTabDocument = [
    '#%PAGESPACE_SHEETDOC v1',
    'page_id = "page-1"',
    '',
    '[[sheets]]',
    'name = "First"',
    'order = 0',
    '',
    '[sheets.meta]',
    'row_count = 2',
    'column_count = 1',
    '',
    '[sheets.cells.A1]',
    'value = "from-first"',
    'type = "string"',
    '',
    '[[sheets]]',
    'name = "Second"',
    'order = 1',
    '',
    '[sheets.meta]',
    'row_count = 3',
    'column_count = 2',
    '',
    '[sheets.cells.A1]',
    'value = "from-second"',
    'type = "string"',
  ].join('\n');

  it('reads the requested tab of a document-backed sheet, not always tab 0', async () => {
    // Answering a request for tab 1 with tab 0's rows is a wrong answer an
    // agent cannot detect — the rows look perfectly valid.
    mockListTabs.mockResolvedValue([]);

    const first = await loadSheetWindow('page-1', { limit: 10, documentContent: multiTabDocument });
    const second = await loadSheetWindow('page-1', { tabIndex: 1, limit: 10, documentContent: multiTabDocument });

    expect(first.rows[0].cells).toEqual({ A: 'from-first' });
    assert({
      given: 'tabIndex 1 on an unmigrated multi-tab sheet',
      should: 'return the second tab\'s data and identify it as such',
      actual: { cells: second.rows[0].cells, tabIndex: second.tabIndex, tabName: second.tabName },
      expected: { cells: { A: 'from-second' }, tabIndex: 1, tabName: 'Second' },
    });
  });

  it('lists every tab of a document-backed sheet, not only the one it read', async () => {
    mockListTabs.mockResolvedValue([]);
    const window = await loadSheetWindow('page-1', { limit: 10, documentContent: multiTabDocument });

    expect(window.tabs).toEqual([
      { tabIndex: 0, name: 'First', rowCount: 2, columnCount: 1 },
      { tabIndex: 1, name: 'Second', rowCount: 3, columnCount: 2 },
    ]);
  });

  it('refuses a tab index the document does not have', async () => {
    mockListTabs.mockResolvedValue([]);
    await expect(
      loadSheetWindow('page-1', { tabIndex: 5, limit: 10, documentContent: multiTabDocument })
    ).rejects.toThrow(SheetTabNotFoundError);
  });

  it('refuses a tab index the row store does not have', async () => {
    mockGetTab.mockResolvedValue(null);
    await expect(loadSheetWindow('page-1', { tabIndex: 3, limit: 10 })).rejects.toThrow(SheetTabNotFoundError);
  });

  it('refuses an unparseable document instead of calling it empty', async () => {
    // `parseSheetContentSafe` distinguishes "genuinely empty" from "failed to
    // read" precisely so this case is not conflated. Reporting blank is the one
    // answer that invites an agent to overwrite content that is still intact.
    mockListTabs.mockResolvedValue([]);
    const broken = '#%PAGESPACE_SHEETDOC v1\n[[sheets]]\nname = "Broken"\nthis is not toml = = =';

    await expect(
      loadSheetWindow('page-1', { limit: 10, documentContent: broken })
    ).rejects.toThrow(SheetDocumentUnreadableError);
  });

  it('still reads a genuinely empty sheet as empty', async () => {
    // The refusal above must not swallow the legitimate empty case.
    mockListTabs.mockResolvedValue([]);
    const window = await loadSheetWindow('page-1', { limit: 10, documentContent: '' });

    expect(window.rows).toEqual([]);
    expect(window.materialized).toBe(false);
  });
});
