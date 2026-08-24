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
  columnsInRows,
  compareColumnLabels,
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

describe('compareColumnLabels', () => {
  it('orders columns the way a sheet does, not the way strings do', () => {
    assert({
      given: 'a mix of one- and two-letter columns',
      should: 'put every one-letter column before AA, not sort AA next to A',
      actual: ['B', 'AA', 'A', 'Z', 'AB'].sort(compareColumnLabels),
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
      actual: renderSheetTable(rows),
      expected: 'columns→A | B\n1→memid | name\n2→28605 | Acme',
    });
  });

  it('escapes a newline inside a cell so one cell cannot become two rows', () => {
    const multiline = toSheetViewRow(0, { A: { raw: 'one\ntwo', value: 'one\ntwo' } });
    const table = renderSheetTable([multiline]);

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
    );
    expect(table.split('\n')[0]).toBe('columns→A | C');
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
