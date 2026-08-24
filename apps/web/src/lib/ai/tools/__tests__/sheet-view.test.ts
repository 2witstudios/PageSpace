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

import {
  SheetDocumentUnreadableError,
  SheetTabNotFoundError,
  TABLE_CELL_CHAR_LIMIT,
  columnsInRows,
  loadSheetWindow,
  renderSheetTable,
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

  it('reports an errored cell as an error rather than as its own source text', () => {
    const row = toSheetViewRow(0, {
      C: { raw: '=OTHER!A1', error: { type: 'error', message: 'Cross-page references are not supported in this context' } },
    });

    expect(row.cells.C).toBe('#ERROR');
    expect(row.errors).toEqual({
      C: 'Cross-page references are not supported in this context',
    });
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

  it('reports nothing cut when nothing was cut', () => {
    const rendered = renderSheetTable([toSheetViewRow(0, { A: { raw: 'fits', value: 'fits' } })]);
    expect(rendered.truncatedCells).toBe(0);
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
