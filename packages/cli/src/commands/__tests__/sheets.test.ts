import { describe, expect, it, vi } from 'vitest';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, parseArgv } from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';
import {
  createSheetsAppendHandler,
  createSheetsEditCellsHandler,
  createSheetsUpdateCellsHandler,
  sheetsDeleteRowsHandler,
  sheetsDescribeHandler,
  sheetsQueryHandler,
  sheetsRowsHandler,
} from '../sheets.js';

function commandIntent(argv: string[]): CommandIntent {
  const intent = parseArgv(['__cmd__', ...argv]);
  if (intent.kind !== 'command') throw new Error('expected command');
  return { ...intent, args: intent.args.slice(1) };
}

const EDIT_RESULT = {
  pageId: 'pg_1',
  pageTitle: 'Budget',
  cellsUpdated: 1,
  operation: 'edit-cells' as const,
  stats: { valuesSet: 1, formulasSet: 0, cellsCleared: 0, sheetDimensions: { rows: 10, columns: 10 } },
  updatedCells: [{ address: 'A1', type: 'value' as const }],
};

describe('createSheetsEditCellsHandler', () => {
  it('exits 2 with a usage error when pageId is missing, never reading input', async () => {
    const editCells = vi.fn(async () => EDIT_RESULT);
    const readStdin = vi.fn(async () => '[]');
    const handler = createSheetsEditCellsHandler({ readStdin });
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { editCells } }) });

    const code = await handler(ctx, commandIntent([]));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(readStdin).not.toHaveBeenCalled();
    expect(editCells).not.toHaveBeenCalled();
  });

  it('reads cells from stdin by default and passes them through to pages.editCells', async () => {
    const editCells = vi.fn(async () => EDIT_RESULT);
    const readStdin = vi.fn(async () => '[{"address":"A1","value":"5"}]');
    const handler = createSheetsEditCellsHandler({ readStdin });
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { editCells } }) });

    const code = await handler(ctx, commandIntent(['pg_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(editCells).toHaveBeenCalledWith({ operation: 'edit-cells', pageId: 'pg_1', cells: [{ address: 'A1', value: '5' }] });
  });

  it('reads cells from --json-input when given, never touching stdin', async () => {
    const editCells = vi.fn(async () => EDIT_RESULT);
    const readStdin = vi.fn(async () => 'should not be used');
    const handler = createSheetsEditCellsHandler({ readStdin });
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { editCells } }) });

    const code = await handler(ctx, commandIntent(['pg_1', '--json-input', '[{"address":"B2","value":"7"}]']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(readStdin).not.toHaveBeenCalled();
    expect(editCells).toHaveBeenCalledWith({ operation: 'edit-cells', pageId: 'pg_1', cells: [{ address: 'B2', value: '7' }] });
  });

  it('rejects malformed JSON input as a usage error before any network call', async () => {
    const editCells = vi.fn(async () => EDIT_RESULT);
    const handler = createSheetsEditCellsHandler({ readStdin: async () => 'not json' });
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { editCells } }) });

    const code = await handler(ctx, commandIntent(['pg_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(editCells).not.toHaveBeenCalled();
  });

  it('rejects a non-array JSON input as a usage error before any network call', async () => {
    const editCells = vi.fn(async () => EDIT_RESULT);
    const handler = createSheetsEditCellsHandler({ readStdin: async () => '{"address":"A1","value":"5"}' });
    const ctx = createFakeContext({ sdk: fakeSdk({ pages: { editCells } }) });

    const code = await handler(ctx, commandIntent(['pg_1']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(editCells).not.toHaveBeenCalled();
  });

  it('--json emits exactly the SDK response', async () => {
    const stdout = createRecordingSink();
    const handler = createSheetsEditCellsHandler({ readStdin: async () => '[{"address":"A1","value":"5"}]' });
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ pages: { editCells: async () => EDIT_RESULT } }) });

    await handler(ctx, commandIntent(['pg_1', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual(EDIT_RESULT);
  });

  it('surfaces an SDK failure as a runtime error', async () => {
    const editCells = vi.fn(async () => {
      throw new Error('Invalid A1-style cell address');
    });
    const stderr = createRecordingSink();
    const handler = createSheetsEditCellsHandler({ readStdin: async () => '[{"address":"A1","value":"5"}]' });
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ pages: { editCells } }) });

    const code = await handler(ctx, commandIntent(['pg_1']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('Invalid A1-style cell address');
  });
});

// ---------------------------------------------------------------------------
// Row verbs (`/api/mcp/sheets`) — the tabular view.
// ---------------------------------------------------------------------------

const ROWS = [
  { rowIndex: 0, cells: { A: { raw: 'widget', value: 'widget' }, D: { raw: '=B1*C1', value: 250 } } },
  { rowIndex: 1, cells: { A: { raw: 'gadget', value: 'gadget' } } },
];

describe('sheets query', () => {
  it('sends the parsed filter, projection and sort, and reports the match total', async () => {
    const queryRows = vi.fn(async () => ({ pageId: 'pg_1', pageTitle: 'Ledger', tabIndex: 0, rows: ROWS, total: 42, hasMore: true }));
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ sheets: { queryRows } }) });

    const code = await sheetsQueryHandler(ctx, commandIntent([
      'pg_1', '--where', '{"column":"D","op":"gt","value":20}', '--select', 'A,D', '--order-by', 'D:desc', '--limit', '2', '--tab', '1',
    ]));

    expect(code).toBe(EXIT_SUCCESS);
    expect(queryRows).toHaveBeenCalledWith({
      operation: 'query-rows',
      pageId: 'pg_1',
      tabIndex: 1,
      where: { column: 'D', op: 'gt', value: 20 },
      orderBy: [{ column: 'D', direction: 'desc' }],
      select: ['A', 'D'],
      limit: 2,
    });
    // The computed value, not the formula source — what the filter matched on.
    expect(stdout.lines.join('')).toContain('D=250');
    expect(stdout.lines.join('')).toContain('2 of 42 matching row(s), more available.');
  });

  it('rejects malformed --where as a usage error before any network call', async () => {
    const queryRows = vi.fn();
    const ctx = createFakeContext({ sdk: fakeSdk({ sheets: { queryRows } }) });

    const code = await sheetsQueryHandler(ctx, commandIntent(['pg_1', '--where', '{not json']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(queryRows).not.toHaveBeenCalled();
  });

  it('rejects an unknown sort direction rather than silently sorting ascending', async () => {
    const queryRows = vi.fn();
    const ctx = createFakeContext({ sdk: fakeSdk({ sheets: { queryRows } }) });

    const code = await sheetsQueryHandler(ctx, commandIntent(['pg_1', '--order-by', 'D:descending']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(queryRows).not.toHaveBeenCalled();
  });

  it('rejects a non-integer --limit', async () => {
    const queryRows = vi.fn();
    const ctx = createFakeContext({ sdk: fakeSdk({ sheets: { queryRows } }) });

    expect(await sheetsQueryHandler(ctx, commandIntent(['pg_1', '--limit', 'ten']))).toBe(EXIT_USAGE_ERROR);
    expect(queryRows).not.toHaveBeenCalled();
  });
});

describe('sheets rows', () => {
  it('prints the continuation cursor so paging a sparse tab terminates', async () => {
    const getRows = vi.fn(async () => ({
      pageId: 'pg_1', pageTitle: 'Ledger', tabIndex: 0,
      rows: [{ rowIndex: 500, cells: { A: { raw: 'x' } } }],
      rowCount: 510, columnCount: 8, nextFromRow: 501, hasMore: true,
    }));
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ sheets: { getRows } }) });

    const code = await sheetsRowsHandler(ctx, commandIntent(['pg_1', '--from-row', '500', '--limit', '1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(getRows).toHaveBeenCalledWith({ operation: 'get-rows', pageId: 'pg_1', fromRow: 500, limit: 1 });
    // Advancing by row COUNT would revisit row 500 forever on a sparse tab.
    expect(stdout.lines.join('')).toContain('--from-row 501');
    expect(stdout.lines.join('')).toContain('row 500:');
  });

  it('omits the cursor when there is nothing more to read', async () => {
    const getRows = vi.fn(async () => ({
      pageId: 'pg_1', pageTitle: null, tabIndex: 0,
      rows: [{ rowIndex: 0, cells: { A: { raw: 'x' } } }],
      rowCount: 1, columnCount: 1, nextFromRow: 1, hasMore: false,
    }));
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ sheets: { getRows } }) });

    expect(await sheetsRowsHandler(ctx, commandIntent(['pg_1']))).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).not.toContain('--from-row');
  });
});

describe('sheets describe', () => {
  it('renders tabs with their dimensions', async () => {
    const describe_ = vi.fn(async () => ({
      pageId: 'pg_1', pageTitle: 'Ledger',
      tabs: [{ tabIndex: 0, name: 'Sheet1', rowCount: 5305, columnCount: 10, frozenRows: null }],
    }));
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ sheets: { describe: describe_ } }) });

    expect(await sheetsDescribeHandler(ctx, commandIntent(['pg_1']))).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).toContain('tab 0: Sheet1 — 5305 rows x 10 columns');
  });
});

describe('sheets append', () => {
  it('reads rows from stdin and reports where the batch landed', async () => {
    const appendRows = vi.fn(async () => ({ pageId: 'pg_1', pageTitle: 'Ledger', firstRowIndex: 5, appended: 2, rowCount: 7 }));
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ sheets: { appendRows } }) });
    const handler = createSheetsAppendHandler({ readStdin: async () => '[{"A":"x"},{"A":"y"}]' });

    expect(await handler(ctx, commandIntent(['pg_1']))).toBe(EXIT_SUCCESS);
    expect(appendRows).toHaveBeenCalledWith({ operation: 'append-rows', pageId: 'pg_1', rows: [{ A: 'x' }, { A: 'y' }] });
    expect(stdout.lines.join('')).toContain('starting at row 5');
  });

  it('rejects a non-array payload', async () => {
    const appendRows = vi.fn();
    const ctx = createFakeContext({ sdk: fakeSdk({ sheets: { appendRows } }) });
    const handler = createSheetsAppendHandler({ readStdin: async () => '{"A":"x"}' });

    expect(await handler(ctx, commandIntent(['pg_1']))).toBe(EXIT_USAGE_ERROR);
    expect(appendRows).not.toHaveBeenCalled();
  });
});

describe('sheets update-cells', () => {
  it('reaches a non-zero tab, which edit-cells cannot', async () => {
    const updateCells = vi.fn(async () => ({ pageId: 'pg_1', pageTitle: 'Ledger', cellsUpdated: 1, recomputed: 2, rowCount: 10, columnCount: 5 }));
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ sheets: { updateCells } }) });
    const handler = createSheetsUpdateCellsHandler({ readStdin: async () => '[{"address":"A1","value":"5"}]' });

    expect(await handler(ctx, commandIntent(['pg_1', '--tab', '2']))).toBe(EXIT_SUCCESS);
    expect(updateCells).toHaveBeenCalledWith({
      operation: 'update-cells', pageId: 'pg_1', tabIndex: 2, cells: [{ address: 'A1', value: '5' }],
    });
    expect(stdout.lines.join('')).toContain('recomputed 2');
  });
});

describe('sheets delete-rows', () => {
  it('refuses to guess either bound', async () => {
    // A guessed --count deletes the wrong rows, and there is no undo.
    const deleteRows = vi.fn();
    const ctx = createFakeContext({ sdk: fakeSdk({ sheets: { deleteRows } }) });

    expect(await sheetsDeleteRowsHandler(ctx, commandIntent(['pg_1', '--from-row', '3']))).toBe(EXIT_USAGE_ERROR);
    expect(await sheetsDeleteRowsHandler(ctx, commandIntent(['pg_1', '--count', '3']))).toBe(EXIT_USAGE_ERROR);
    expect(deleteRows).not.toHaveBeenCalled();
  });

  it('deletes a range when both bounds are given', async () => {
    const deleteRows = vi.fn(async () => ({ pageId: 'pg_1', pageTitle: 'Ledger', deleted: 3, rowCount: 7 }));
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ sheets: { deleteRows } }) });

    expect(await sheetsDeleteRowsHandler(ctx, commandIntent(['pg_1', '--from-row', '3', '--count', '3']))).toBe(EXIT_SUCCESS);
    expect(deleteRows).toHaveBeenCalledWith({ operation: 'delete-rows', pageId: 'pg_1', fromRow: 3, count: 3 });
    expect(stdout.lines.join('')).toContain('Deleted 3 row(s)');
  });
});
