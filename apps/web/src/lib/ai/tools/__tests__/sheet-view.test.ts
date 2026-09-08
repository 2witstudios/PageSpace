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
import type * as SheetStore from '@pagespace/lib/sheets/store';

const mockGetTab = vi.fn();
const mockListTabs = vi.fn();
const mockReadRows = vi.fn();

/**
 * Argument tuples come from the real exports rather than `unknown[]`, so a
 * function REMOVED or RENAMED in the store fails compilation here instead of
 * leaving a stub that still satisfies every assertion against a name nothing
 * calls any more. Be clear about the limit: `vi.fn()` accepts anything, so a
 * change to a parameter's TYPE still flows through silently — this guards the
 * export surface, not the signatures.
 *
 * The import is type-only and erased, so nothing loads the real store — which
 * would open a database connection — at runtime.
 */
vi.mock('@pagespace/lib/sheets/store', () => ({
  getTab: (...args: Parameters<typeof SheetStore.getTab>) => mockGetTab(...args),
  listTabs: (...args: Parameters<typeof SheetStore.listTabs>) => mockListTabs(...args),
  readRows: (...args: Parameters<typeof SheetStore.readRows>) => mockReadRows(...args),
}));

import { serializeSheetContent } from '@pagespace/lib/sheets/io';
import { evaluateSheetSparse, type ConditionalRule, type SheetData } from '@pagespace/lib/sheets/sheet';
import { describeRule } from '@/components/layout/middle-content/page-views/sheet/core/rule-presets';
import {
  SheetDocumentUnreadableError,
  SheetTabNotFoundError,
  TABLE_CELL_CHAR_LIMIT,
  columnsInRows,
  loadSheetWindow,
  renderSheetTable,
  renderSheetTableWithinBudget,
  toSheetViewRow,
  describeConditionalRule,
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
    // The machine value has to survive the fallback path too. The document path
    // builds its own synthetic cells, so it once put the DISPLAY string in
    // `value` — which made the two paths agree on `cells` while only one of them
    // could hand back the 1200 behind `$1,200.00`.
    assert({
      given: 'a formatted cell before and after migration',
      should: 'recover the same machine value on both paths',
      actual: fromStore.rows.map((row) => row.unformatted),
      expected: fromDocument.rows.map((row) => row.unformatted),
    });
    // Guard the guard again: an all-undefined comparison would pass vacuously.
    expect(fromDocument.rows[0].unformatted).toEqual({ B: 1200 });
  });

  it('agrees on a REGION-formatted column, which is where they used to diverge', async () => {
    // The sharpest form of the property. A region's presentation is derived at
    // evaluation time, so the document path always had it (via
    // `evaluated.format`) while the row store — which stores only the explicit
    // cell format — did not. One cell, two renderings, decided by whether
    // anyone had migrated the sheet.
    const regional = {
      version: 1,
      rowCount: 4,
      columnCount: 3,
      sheetName: 'Budget',
      cells: { A1: 'Item', C1: 'Cost', A2: 'Rent', C2: '1200', A3: 'Total', C3: '=C2' },
      // No cell formats and no column formats anywhere: the ONLY source of
      // presentation is the region, so if either path ignores it the comparison
      // fails rather than passing on some other layer.
      regions: [{
        id: 'r1', range: 'A1:C', headerRows: 1, totalRows: [3],
        columns: [{ column: 'C', role: 'currency' as const, currency: 'USD' }],
      }],
    };

    mockListTabs.mockResolvedValue([]);
    const fromDocument = await loadSheetWindow('page-1', {
      limit: 10,
      documentContent: serializeSheetContent(regional, { pageId: 'page-1' }),
    });

    mockListTabs.mockResolvedValue([tab]);
    mockGetTab.mockResolvedValue({
      ...tab,
      rowCount: regional.rowCount,
      columnCount: regional.columnCount,
      regions: regional.regions,
    });
    mockReadRows.mockResolvedValue([
      { rowIndex: 0, cells: { A: { raw: 'Item', value: 'Item' }, C: { raw: 'Cost', value: 'Cost' } } },
      { rowIndex: 1, cells: { A: { raw: 'Rent', value: 'Rent' }, C: { raw: '1200', value: 1200 } } },
      { rowIndex: 2, cells: { A: { raw: 'Total', value: 'Total' }, C: { raw: '=C2', value: 1200 } } },
    ]);
    const fromStore = await loadSheetWindow('page-1', { limit: 10 });

    // Guard the guard: the region must actually be formatting something.
    expect(fromDocument.rows[1].cells.C).toBe('$1,200.00');
    // A header cell holds a label, not data — the role format must not reach it.
    expect(fromDocument.rows[0].cells.C).toBe('Cost');

    assert({
      given: 'a region-formatted sheet before and after migration',
      should: 'render identical values on both paths',
      actual: fromStore.rows.map((row) => row.cells),
      expected: fromDocument.rows.map((row) => row.cells),
    });
    assert({
      given: 'a region-formatted sheet before and after migration',
      should: 'recover identical machine values on both paths',
      actual: fromStore.rows.map((row) => row.unformatted),
      expected: fromDocument.rows.map((row) => row.unformatted),
    });
  });
});

describe('a region-derived format is part of what a cell reads as', () => {
  // The row store keeps only the EXPLICIT cell format; a column declared
  // `currency` by a region is presentation the evaluator derives. Resolving
  // just cell-over-column therefore rendered `1200` here while the grid, the
  // export and the published page all showed `$1,200.00` — so an agent that had
  // just declared the region read the sheet back and saw no sign its formatting
  // had applied. Region-derived presentation is the mechanism this epic makes
  // primary; a read that ignores it is reading a different sheet.
  const regionTab = {
    ...tab,
    rowCount: 10,
    columnCount: 4,
    regions: [{
      id: 'r1', range: 'A1:D', headerRows: 1,
      columns: [{ column: 'C', role: 'currency', currency: 'USD' }],
    }],
  };

  beforeEach(() => {
    mockListTabs.mockResolvedValue([regionTab]);
    mockGetTab.mockResolvedValue(regionTab);
    mockReadRows.mockResolvedValue([
      { rowIndex: 0, cells: { A: { raw: 'Item', value: 'Item' }, C: { raw: 'Cost', value: 'Cost' } } },
      { rowIndex: 1, cells: { A: { raw: 'Rent', value: 'Rent' }, C: { raw: '1200', value: 1200 } } },
    ]);
  });

  it('renders a region-formatted column the way the grid does', async () => {
    const window = await loadSheetWindow('page-1', { limit: 10 });

    assert({
      given: 'a column a region declares as currency, with no cell or column format',
      should: 'display it as currency and keep the header label untouched',
      actual: { header: window.rows[0].cells.C, data: window.rows[1].cells.C },
      expected: { header: 'Cost', data: '$1,200.00' },
    });
  });

  it('does not fail the whole read on a column key that is not a column label', async () => {
    // `cells` is jsonb. A hand-edited or externally-imported row can carry a key
    // like `C0`, which `decodeColumnLabel` refuses — and locating the region
    // needs that decode. Letting it throw would make one junk key fail the
    // entire read, which is the failure this module exists to remove and which
    // the document path's address walk already guards against.
    mockReadRows.mockResolvedValue([
      { rowIndex: 1, cells: { C: { raw: '1200', value: 1200 }, C0: { raw: 'junk', value: 'junk' } } },
    ]);

    const window = await loadSheetWindow('page-1', { limit: 10 });

    assert({
      given: 'a junk column key beside a region-formatted one',
      should: 'read both — the junk one simply gets no region format',
      actual: window.rows[0].cells,
      expected: { C: '$1,200.00', C0: 'junk' },
    });
  });

  it('still hands back the number underneath it', async () => {
    // The whole point of resolving the layer: having made the display richer,
    // the machine value has to stay recoverable or the read is lossy again.
    const window = await loadSheetWindow('page-1', { limit: 10 });

    expect(window.rows[1].unformatted).toEqual({ C: 1200 });
    // The header cell is a label, not data — no number format, nothing to recover.
    expect(window.rows[0].unformatted).toBeUndefined();
  });
});

describe('the document path re-derives exactly what the evaluator displayed', () => {
  /**
   * The document path no longer stores `evaluated.display` — it stores the
   * machine value and the format the evaluator applied, and `cellText` derives
   * the text again. That is only safe if the derivation is EQUIVALENT, so this
   * asserts it against the evaluator itself rather than against a string
   * somebody typed: any branch where `display` is produced differently from
   * `applyNumberFormat(value, format.number) ?? formatDisplayValue(value)`
   * shows up here as a mismatch.
   *
   * Conditional rules are the branch worth pinning. `applyConditionalFormats`
   * rewrites BOTH `format` and `display` after the fact, so a rule carrying its
   * own number format is the case where the two could most easily part company.
   */
  const cases: Array<[string, SheetData]> = [
    ['a plain string, a number and a formula', {
      version: 1, rowCount: 3, columnCount: 3,
      cells: { A1: 'label', B1: '1200', C1: '=B1/4', C2: '0.30000000000000004' },
    }],
    ['a column format over a formula result', {
      version: 1, rowCount: 2, columnCount: 3,
      cells: { A1: 'x', B1: '1200', C1: '=B1*2' },
      columnFormats: { B: { number: { kind: 'currency', currency: 'USD', decimals: 2 } }, C: { number: { kind: 'percent', decimals: 1 } } },
    }],
    ['a per-cell format beating the column default', {
      version: 1, rowCount: 2, columnCount: 2,
      cells: { A1: '1200', A2: '3.7' },
      columnFormats: { A: { number: { kind: 'currency', currency: 'USD' } } },
      formats: { A2: { number: { kind: 'plain' } } },
    }],
    ['a conditional rule carrying its own number format', {
      version: 1, rowCount: 2, columnCount: 2,
      cells: { A1: '0.85', A2: '0.1' },
      columnFormats: { A: { number: { kind: 'currency', currency: 'USD', decimals: 2 } } },
      conditionalFormats: [{
        id: 'r', kind: 'cell', ranges: ['A1:A2'],
        condition: { operator: 'greaterThan', value: '0.5' },
        format: { background: '#dcfce7', number: { kind: 'percent', decimals: 0 } },
      }],
    }],
    ['an errored cell and an empty one', {
      version: 1, rowCount: 3, columnCount: 2,
      cells: { A1: '=1/0', A2: '', A3: '=NOPE(1)' },
      columnFormats: { A: { number: { kind: 'currency', currency: 'USD' } } },
    }],
  ];

  it('is not comparing two nothings — the conditional rule really does beat the column format', async () => {
    // Every case above compares the window against the evaluator, which agrees
    // trivially if the fixture exercises nothing. This pins the one that is
    // hardest to get right: a rule's own number format overriding the column's
    // currency, on the cell it matched and not on the cell it did not.
    mockListTabs.mockResolvedValue([]);
    const sheet = cases[3][1];
    const window = await loadSheetWindow('page-1', {
      limit: 10,
      documentContent: serializeSheetContent(sheet, { pageId: 'page-1' }),
    });

    assert({
      given: 'a percent rule matching A1 but not A2, over a currency column',
      should: 'render A1 as the rule says and A2 as the column says',
      actual: { A1: window.rows[0].cells.A, A2: window.rows[1].cells.A },
      expected: { A1: '85%', A2: '$0.10' },
    });
    // And the machine value is recoverable from both, which is the point.
    assert({
      given: 'both cells displayed through a number format',
      should: 'carry the underlying numbers',
      actual: [window.rows[0].unformatted, window.rows[1].unformatted],
      expected: [{ A: 0.85 }, { A: 0.1 }],
    });
  });

  it.each(cases)('agrees with evaluateSheetSparse on %s', async (_label, sheet) => {
    mockListTabs.mockResolvedValue([]);
    const window = await loadSheetWindow('page-1', {
      limit: 50,
      documentContent: serializeSheetContent(sheet, { pageId: 'page-1' }),
    });

    const evaluation = evaluateSheetSparse(sheet, { pageId: 'page-1' });

    const fromWindow: Record<string, string> = {};
    for (const row of window.rows) {
      for (const [column, text] of Object.entries(row.cells)) fromWindow[`${column}${row.rowNumber}`] = text;
    }

    // The evaluator's own answer for every address the window reported, through
    // the same `#ERROR` substitution every surface applies.
    const fromEvaluator: Record<string, string> = {};
    for (const address of Object.keys(fromWindow)) {
      const cell = evaluation.byAddress[address];
      fromEvaluator[address] = cell ? (cell.error ? '#ERROR' : cell.display) : '';
    }

    assert({
      given: 'a stored document read through the window',
      should: 'display every cell exactly as the evaluator displayed it',
      actual: fromWindow,
      expected: fromEvaluator,
    });
    // Guard the guard: a window that reported nothing would pass vacuously.
    expect(Object.keys(fromWindow).length).toBeGreaterThan(0);
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

describe('describeConditionalRule agrees with the panel it was copied from', () => {
  /**
   * `apps/web/src/lib/ai/**` imports nothing from `components/**`, so the AI
   * surface has its own copy of the panel's rule wording. The copy is the whole
   * risk: two descriptions of one rule, free to drift, with nothing to notice.
   * One rule of each kind, both functions, same string.
   */
  const rules: ConditionalRule[] = [
    {
      id: 'a',
      kind: 'cell',
      ranges: ['A1:A9'],
      condition: { operator: 'between', value: '10', value2: '20' },
      format: { background: '#fee2e2' },
    },
    { id: 'b', kind: 'formula', ranges: ['B1:B9'], formula: '=B1>0', format: { bold: true } },
    {
      id: 'c',
      kind: 'colorScale',
      ranges: ['C1:C9'],
      min: { type: 'min', color: '#ffffff' },
      mid: { type: 'percentile', value: 50, color: '#fde68a' },
      max: { type: 'max', color: '#22c55e' },
    },
    { id: 'd', kind: 'dataBar', ranges: ['D1:D9'], color: '#3b82f6' },
  ];

  it.each(rules)('describes a $kind rule the same way the panel does', (rule) => {
    assert({
      given: `a ${rule.kind} rule`,
      should: 'produce the same one-line summary as the sheet panel',
      actual: describeConditionalRule(rule),
      expected: describeRule(rule),
    });
  });

  it('covers every rule kind the union has, so a new kind cannot slip past', () => {
    // Without this the case above passes forever on the four kinds someone
    // thought to list, which is how the copy drifts in the first place.
    const kinds: ReadonlyArray<ConditionalRule['kind']> = ['cell', 'formula', 'colorScale', 'dataBar'];
    expect(rules.map((rule) => rule.kind).sort()).toEqual([...kinds].sort());
  });
});

describe('loadSheetWindow describes formatting only when asked', () => {
  const styledTab = {
    ...tab,
    frozenRows: 1,
    regions: [{ id: 'r1', range: 'A1:C', headerRows: 1 }],
  };

  it('leaves the key off entirely by default, so no caller can read it as "unstyled"', async () => {
    // `read_page` and `list_pages` share this window and never ask for
    // formatting. Building it for them anyway would parse regions and walk every
    // returned cell's format on a preview that shows none of it — and would put
    // an empty block in front of a caller that never asked.
    mockGetTab.mockResolvedValue(styledTab);
    mockReadRows.mockResolvedValue([
      { rowIndex: 0, cells: { A: { raw: 'x', value: 'x', format: { bold: true } } } },
    ]);

    const window = await loadSheetWindow('page-1', { limit: 10 });

    expect('formatting' in window).toBe(false);
  });

  it('builds it from the stored document when the sheet was never migrated', async () => {
    // The document is where a pre-row-store sheet keeps its design. Refusing
    // here hid it from the one caller that asked for it.
    mockListTabs.mockResolvedValue([]);
    const window = await loadSheetWindow('page-1', {
      limit: 10,
      includeFormatting: true,
      documentContent: serializeSheetContent(
        {
          version: 1,
          rowCount: 2,
          columnCount: 2,
          cells: { A1: 'Item', A2: 'Rent' },
          formats: { A2: { italic: true } },
          frozenRows: 1,
          regions: [{ id: 'r2', range: 'A1:B', headerRows: 1 }],
        },
        { pageId: 'page-1' },
      ),
    });

    assert({
      given: 'an unmigrated sheet and includeFormatting',
      should: 'describe the design the stored document carries',
      actual: window.formatting,
      expected: {
        regions: [{ id: 'r2', range: 'A1:B', headerRows: 1 }],
        layout: { frozenRows: 1 },
        cellFormats: { A2: { italic: true } },
      },
    });
  });

  it('leaves the key off on the document path too', async () => {
    // `read_page` and `list_pages` reach unmigrated sheets through this branch.
    // Building the block for them would parse the document's rules and regions
    // on every preview that shows none of it.
    mockListTabs.mockResolvedValue([]);
    const window = await loadSheetWindow('page-1', {
      limit: 10,
      documentContent: serializeSheetContent(
        { version: 1, rowCount: 2, columnCount: 2, cells: { A1: 'x' }, frozenRows: 1 },
        { pageId: 'page-1' },
      ),
    });

    expect('formatting' in window).toBe(false);
  });

  it('describes only the rows it returned, not the whole document', async () => {
    // `cellFormats` describes the rows in the response. A document's `formats`
    // map covers the entire sheet, so without the window restriction a two-row
    // read of a large legacy sheet would hand back every override it has —
    // spending the whole budget on rows the agent cannot see.
    mockListTabs.mockResolvedValue([]);
    const window = await loadSheetWindow('page-1', {
      limit: 2,
      includeFormatting: true,
      documentContent: serializeSheetContent(
        {
          version: 1,
          rowCount: 5,
          columnCount: 2,
          cells: { A1: 'one', A2: 'two', A5: 'five' },
          formats: { A1: { bold: true }, A5: { italic: true } },
        },
        { pageId: 'page-1' },
      ),
    });

    assert({
      given: 'a document with formats above and below the window',
      should: 'report only the ones inside it',
      actual: window.formatting?.cellFormats,
      expected: { A1: { bold: true } },
    });
    // Guard the guard: the window really did stop short of row 5.
    expect(window.rows.map((row) => row.rowNumber)).toEqual([1, 2]);
  });

  it('keeps a format-only row that the document styled but never filled', async () => {
    // The likeliest shape on a legacy sheet: a blank input row someone
    // pre-styled. `windowed` comes from `sheet.cells`, so that row is not in it
    // — while `rowsFromSheetData` materialises the UNION of cells and formats,
    // which means the same read reports the styling after migration and dropped
    // it before. Losing formatting across a migration is the drift this module
    // exists to remove.
    mockListTabs.mockResolvedValue([]);
    const window = await loadSheetWindow('page-1', {
      limit: 10,
      includeFormatting: true,
      documentContent: serializeSheetContent(
        {
          version: 1,
          rowCount: 4,
          columnCount: 2,
          cells: { A1: 'Item', A3: 'Rent' },
          // A2 carries a format and no value at all.
          formats: { A1: { bold: true }, A2: { background: '#eef2ff' } },
        },
        { pageId: 'page-1' },
      ),
    });

    assert({
      given: 'a styled blank row between two rows that have values',
      should: 'report its formatting alongside theirs',
      actual: window.formatting?.cellFormats,
      expected: { A1: { bold: true }, A2: { background: '#eef2ff' } },
    });
    // The row itself still does not appear — it holds nothing to show. Pinning
    // that so the next reader knows the formatting entry is deliberate and not
    // a row that went missing.
    expect(window.rows.map((row) => row.rowNumber)).toEqual([1, 3]);
  });

  it('does not admit a styled row from outside the window it returned', async () => {
    // The span rule, in the direction that bounds the cost: a legacy sheet
    // styled a thousand rows down must not spend this window's budget.
    mockListTabs.mockResolvedValue([]);
    const window = await loadSheetWindow('page-1', {
      limit: 2,
      includeFormatting: true,
      documentContent: serializeSheetContent(
        {
          version: 1,
          rowCount: 60,
          columnCount: 2,
          cells: { A1: 'one', A2: 'two', A50: 'far' },
          formats: { A1: { bold: true }, A9: { italic: true }, A40: { strike: true } },
        },
        { pageId: 'page-1' },
      ),
    });

    assert({
      given: 'styled rows past the last row returned',
      should: 'report only the ones the window spans',
      actual: window.formatting?.cellFormats,
      expected: { A1: { bold: true } },
    });
    expect(window.rows.map((row) => row.rowNumber)).toEqual([1, 2]);
  });

  it('describes the tab that was ASKED for, not the first one', async () => {
    // The document path selects its tab before evaluating, and the formatting
    // has to come from that same selection. Answering tab 0's design for a read
    // of tab 1 is the same class of wrong answer as answering tab 0's ROWS —
    // which this module already refuses to do — except silent, because nothing
    // in the response would look out of place.
    mockListTabs.mockResolvedValue([]);
    const window = await loadSheetWindow('page-1', {
      limit: 10,
      tabIndex: 1,
      includeFormatting: true,
      documentContent: serializeSheetContent(
        {
          version: 1,
          rowCount: 2,
          columnCount: 2,
          sheetName: 'First',
          cells: { A1: 'first' },
          frozenRows: 1,
          regions: [{ id: 'first-region', range: 'A1:B', headerRows: 1 }],
          extraSheets: [{
            name: 'Second',
            order: 1,
            meta: { rowCount: 3, columnCount: 3, frozenRows: 2 },
            columns: {},
            cells: { A1: { value: 'second' } },
            // Regions ride inside `ranges.__regions` as a numerically keyed map.
            ranges: { __regions: { '0': { id: 'second-region', range: 'A1:C', headerRows: 2 } } },
            dependencies: {},
          }],
        },
        { pageId: 'page-1' },
      ),
    });

    expect(window.tabName).toBe('Second');
    assert({
      given: 'a formatting read of the second tab',
      should: "describe that tab's design, not the first tab's",
      actual: window.formatting,
      expected: {
        regions: [{ id: 'second-region', range: 'A1:C', headerRows: 2 }],
        layout: { frozenRows: 2 },
      },
    });
  });

  it('builds it when asked, from the tab already in hand', async () => {
    mockGetTab.mockResolvedValue(styledTab);
    mockReadRows.mockResolvedValue([
      { rowIndex: 0, cells: { A: { raw: 'x', value: 'x', format: { bold: true } } } },
    ]);

    const window = await loadSheetWindow('page-1', { limit: 10, includeFormatting: true });

    assert({
      given: 'a styled tab and includeFormatting',
      should: 'describe the freeze, the region and the per-cell override',
      actual: window.formatting,
      expected: {
        regions: [{ id: 'r1', range: 'A1:C', headerRows: 1 }],
        layout: { frozenRows: 1 },
        cellFormats: { A1: { bold: true } },
      },
    });
  });
});
