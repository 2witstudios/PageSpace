import { describe, expect, it, vi } from 'vitest';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, parseArgv } from '@pagespace/cli';
import type { CommandIntent } from '@pagespace/cli';
import { createFakeContext, createRecordingSink, fakeSdk } from '../../__tests__/fake-context.js';
import {
  compareColumns,
  createSheetsAppendHandler,
  createSheetsFormatHandler,
  renderApplyFormat,
  renderFormatting,
  renderRows,
  createSheetsEditCellsHandler,
  createSheetsUpdateCellsHandler,
  sheetsDeleteRowsHandler,
  sheetsDescribeHandler,
  sheetsFormattingHandler,
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

describe('renderRows', () => {
  it('orders columns as a spreadsheet does, not lexicographically', () => {
    // A plain .sort() puts AA before B on any sheet wider than 26 columns.
    expect(['B', 'AA', 'Z', 'A', 'AB'].sort(compareColumns)).toEqual(['A', 'B', 'Z', 'AA', 'AB']);
    expect(renderRows([{ rowIndex: 0, cells: { AA: { raw: '1' }, B: { raw: '2' } } }])).toContain('B=2  AA=1');
  });

  it('prints a formula that evaluates to empty as empty, not as its source', () => {
    // `=IF(A1>5,"","big")` returning blank has a real materialised value of ''.
    // Printing the formula instead made human output disagree with the value
    // the filter had matched on.
    const rendered = renderRows([{ rowIndex: 0, cells: { A: { raw: '=IF(B1>5,"","big")', value: '' } } }]);
    expect(rendered).toContain('A=');
    expect(rendered).not.toContain('IF(');
  });

  it('falls back to raw only when the value is genuinely absent', () => {
    expect(renderRows([{ rowIndex: 0, cells: { A: { raw: '=PENDING()' } } }])).toContain('A==PENDING()');
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

  it('refuses in a non-TTY session without --yes, never touching the sheet', async () => {
    // Deleting rows is irreversible — `pages trash` is reversible and still
    // gates. Failing closed here is what stops a scripted typo destroying data.
    const deleteRows = vi.fn();
    const ctx = createFakeContext({ isTTY: false, sdk: fakeSdk({ sheets: { deleteRows } }) });

    expect(await sheetsDeleteRowsHandler(ctx, commandIntent(['pg_1', '--from-row', '3', '--count', '3']))).toBe(EXIT_RUNTIME_ERROR);
    expect(deleteRows).not.toHaveBeenCalled();
  });

  it('aborts when an interactive caller declines', async () => {
    const deleteRows = vi.fn();
    const prompt = vi.fn(async (_message: string) => 'n');
    const ctx = createFakeContext({ isTTY: true, prompt, sdk: fakeSdk({ sheets: { deleteRows } }) });

    expect(await sheetsDeleteRowsHandler(ctx, commandIntent(['pg_1', '--from-row', '3', '--count', '3']))).toBe(EXIT_RUNTIME_ERROR);
    expect(prompt).toHaveBeenCalled();
    expect(deleteRows).not.toHaveBeenCalled();
  });

  it('names what it is about to destroy in the prompt', async () => {
    const deleteRows = vi.fn(async () => ({ pageId: 'pg_1', pageTitle: 'Ledger', deleted: 3, rowCount: 7 }));
    const prompt = vi.fn(async (_message: string) => 'y');
    const ctx = createFakeContext({ isTTY: true, prompt, sdk: fakeSdk({ sheets: { deleteRows } }) });

    expect(await sheetsDeleteRowsHandler(ctx, commandIntent(['pg_1', '--from-row', '3', '--count', '3', '--tab', '2']))).toBe(EXIT_SUCCESS);
    const asked = prompt.mock.calls[0]![0] as string;
    expect(asked).toContain('3 row(s)');
    expect(asked).toContain('starting at row 3');
    expect(asked).toContain('tab 2');
    expect(asked).toContain('cannot be undone');
  });

  it('deletes a range when both bounds are given and --yes skips the prompt', async () => {
    const deleteRows = vi.fn(async () => ({ pageId: 'pg_1', pageTitle: 'Ledger', deleted: 3, rowCount: 7 }));
    const prompt = vi.fn(async (_message: string): Promise<string> => { throw new Error('must not prompt when --yes is given'); });
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, isTTY: false, prompt, sdk: fakeSdk({ sheets: { deleteRows } }) });

    expect(await sheetsDeleteRowsHandler(ctx, commandIntent(['pg_1', '--from-row', '3', '--count', '3', '--yes']))).toBe(EXIT_SUCCESS);
    expect(prompt).not.toHaveBeenCalled();
    expect(deleteRows).toHaveBeenCalledWith({ operation: 'delete-rows', pageId: 'pg_1', fromRow: 3, count: 3 });
    expect(stdout.lines.join('')).toContain('Deleted 3 row(s)');
  });
});


// ---------------------------------------------------------------------------
// Formatting verbs — presentation rather than data.
// ---------------------------------------------------------------------------

const FORMATTING = {
  pageId: 'pg_1',
  pageTitle: 'Budget',
  tabIndex: 0,
  rowCount: 40,
  columnCount: 6,
  frozenRows: 1,
  frozenColumns: null,
  columnFormats: { C: { number: { kind: 'currency', currency: 'USD' }, bold: false } },
  columnWidths: { C: 140 },
  rowHeights: { '1': 32 },
  conditionalFormats: [
    { kind: 'cell' as const, id: 'r1', ranges: ['C2:C40'], condition: { operator: 'lessThan' as const, value: '0' }, format: { color: '#b91c1c' } },
    { kind: 'colorScale' as const, id: 'r2', ranges: ['D2:D40'], min: { type: 'min' as const, color: '#ffffff' }, max: { type: 'max' as const, color: '#1d4ed8' } },
    { kind: 'dataBar' as const, id: 'r3', ranges: ['E2:E40'], color: '#1d4ed8' },
    { kind: 'formula' as const, id: 'r4', ranges: ['A2:A40'], formula: '=A2>0', format: { bold: true } },
  ],
  regions: [
    { id: 'g1', name: 'Spend', range: 'A1:F', headerRows: 1, totalRows: [40], columns: [{ column: 'C', role: 'currency' as const, currency: 'USD' }], theme: 'blue' },
  ],
  cellFormats: { A1: { bold: true } },
};

const APPLY_RESULT = {
  pageId: 'pg_1',
  pageTitle: 'Budget',
  tabIndex: 0,
  changed: true,
  cellsFormatted: 6,
  rowsTouched: 1,
  tabFieldsChanged: ['frozenRows', 'regions'],
  conditionalRules: 1,
  ruleIdsAdded: ['r1'],
  ruleIdsRemoved: [],
  regions: 1,
  regionIdsAdded: ['g1'],
  regionIdsRemoved: [],
  rowCount: 40,
  columnCount: 6,
  recomputed: [],
};

describe('renderFormatting', () => {
  it('names every rule by id, so a reader can pick one to remove', () => {
    // Removing a rule takes its id and nothing else, and this read is the only
    // place a CLI caller can get one.
    const rendered = renderFormatting(FORMATTING);
    for (const id of ['r1', 'r2', 'r3', 'r4']) expect(rendered).toContain(id);
    expect(rendered).toContain('cell C2:C40 lessThan 0');
    expect(rendered).toContain('colorScale D2:D40 min #ffffff .. max #1d4ed8');
    expect(rendered).toContain('dataBar E2:E40 #1d4ed8');
    expect(rendered).toContain('formula A2:A40 =A2>0');
  });

  it('renders a region with its structure and column roles', () => {
    const rendered = renderFormatting(FORMATTING);
    expect(rendered).toContain('g1 "Spend" A1:F — 1 header row(s), totals 40, theme blue');
    expect(rendered).toContain('C=currency (USD)');
  });

  it('says per-cell formats were not READ when no ranges were asked for', () => {
    // "none" and "none read" are very different answers: a caller that took
    // the first for the second would format straight over what is there.
    const rendered = renderFormatting({ ...FORMATTING, cellFormats: {} });
    expect(rendered).toContain('none read');
    expect(renderFormatting(FORMATTING)).toContain('A1: bold');
  });

  it('omits a section that is empty rather than printing an empty heading', () => {
    const bare = {
      ...FORMATTING,
      frozenRows: null, frozenColumns: null,
      columnFormats: {}, columnWidths: {}, rowHeights: {},
      conditionalFormats: [], regions: [], cellFormats: {},
    };
    const rendered = renderFormatting(bare);
    expect(rendered).toContain('tab 0: 40 rows x 6 columns');
    for (const heading of ['frozen:', 'regions', 'conditional rules', 'column widths', 'row heights']) {
      expect(rendered, `"${heading}" should be absent`).not.toContain(heading);
    }
  });

  it('renders a false-valued format field as a value, not as a set flag', () => {
    // `{bold: false}` means "explicitly not bold" — printing it as `bold`
    // would report the opposite of what is stored.
    expect(renderFormatting(FORMATTING)).toContain('bold=false');
  });
});

describe('renderApplyFormat', () => {
  it('reports a no-op retry as no change, not as a write', () => {
    // The server bumps no revision and logs nothing for this; presenting it as
    // a change would make a harmless retry look like an edit.
    expect(renderApplyFormat({ ...APPLY_RESULT, changed: false })).toContain('No change');
  });

  it('reports what actually changed, under the lock', () => {
    const rendered = renderApplyFormat(APPLY_RESULT);
    expect(rendered).toContain('6 cell(s) restyled');
    expect(rendered).toContain('changed frozenRows, regions');
    expect(rendered).toContain('+1 region(s)');
    expect(rendered).toContain('+1 rule(s)');
  });
});

describe('sheets formatting', () => {
  it('reads the declarative layer with no ranges, and does not send an empty ranges field', async () => {
    const readFormatting = vi.fn(async () => FORMATTING);
    const ctx = createFakeContext({ sdk: fakeSdk({ sheets: { readFormatting } }) });

    const code = await sheetsFormattingHandler(ctx, commandIntent(['pg_1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(readFormatting).toHaveBeenCalledWith({ operation: 'read-formatting', pageId: 'pg_1' });
  });

  it('sends --ranges as a list and --tab as a number', async () => {
    const readFormatting = vi.fn(async () => FORMATTING);
    const ctx = createFakeContext({ sdk: fakeSdk({ sheets: { readFormatting } }) });

    const code = await sheetsFormattingHandler(ctx, commandIntent(['pg_1', '--ranges', 'A1:F40, H2:H9', '--tab', '2']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(readFormatting).toHaveBeenCalledWith({
      operation: 'read-formatting', pageId: 'pg_1', tabIndex: 2, ranges: ['A1:F40', 'H2:H9'],
    });
  });

  it('exits 2 without a pageId, and on an unknown argument, never calling the SDK', async () => {
    const readFormatting = vi.fn(async () => FORMATTING);
    const ctx = createFakeContext({ sdk: fakeSdk({ sheets: { readFormatting } }) });

    expect(await sheetsFormattingHandler(ctx, commandIntent([]))).toBe(EXIT_USAGE_ERROR);
    expect(await sheetsFormattingHandler(ctx, commandIntent(['pg_1', '--nope']))).toBe(EXIT_USAGE_ERROR);
    expect(await sheetsFormattingHandler(ctx, commandIntent(['pg_1', '--tab', 'x']))).toBe(EXIT_USAGE_ERROR);
    expect(readFormatting).not.toHaveBeenCalled();
  });

  it('--json emits exactly the SDK response', async () => {
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ sheets: { readFormatting: async () => FORMATTING } }) });

    await sheetsFormattingHandler(ctx, commandIntent(['pg_1', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual(FORMATTING);
  });
});

describe('sheets format', () => {
  const OPS = '[{"type":"upsertRegion","region":{"id":"g1","range":"A1:F","headerRows":1}}]';

  it('passes the op array through in order, with the tab', async () => {
    const applyFormat = vi.fn(async () => APPLY_RESULT);
    const handler = createSheetsFormatHandler({ readStdin: async () => OPS });
    const ctx = createFakeContext({ sdk: fakeSdk({ sheets: { applyFormat } }) });

    const code = await handler(ctx, commandIntent(['pg_1', '--tab', '1']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(applyFormat).toHaveBeenCalledWith({
      operation: 'apply-format',
      pageId: 'pg_1',
      tabIndex: 1,
      ops: [{ type: 'upsertRegion', region: { id: 'g1', range: 'A1:F', headerRows: 1 } }],
    });
  });

  it('prefers --json-input over stdin and never reads it', async () => {
    const applyFormat = vi.fn(async () => APPLY_RESULT);
    const readStdin = vi.fn(async () => 'should not be used');
    const handler = createSheetsFormatHandler({ readStdin });
    const ctx = createFakeContext({ sdk: fakeSdk({ sheets: { applyFormat } }) });

    expect(await handler(ctx, commandIntent(['pg_1', '--json-input', OPS]))).toBe(EXIT_SUCCESS);
    expect(readStdin).not.toHaveBeenCalled();
  });

  it('rejects malformed and non-array JSON as usage errors before any network call', async () => {
    const applyFormat = vi.fn(async () => APPLY_RESULT);
    const ctx = createFakeContext({ sdk: fakeSdk({ sheets: { applyFormat } }) });

    expect(await createSheetsFormatHandler({ readStdin: async () => 'not json' })(ctx, commandIntent(['pg_1'])))
      .toBe(EXIT_USAGE_ERROR);
    expect(await createSheetsFormatHandler({ readStdin: async () => '{"type":"clearConditionalRules"}' })(ctx, commandIntent(['pg_1'])))
      .toBe(EXIT_USAGE_ERROR);
    expect(applyFormat).not.toHaveBeenCalled();
  });

  it('exits 2 without a pageId, never reading input', async () => {
    const applyFormat = vi.fn(async () => APPLY_RESULT);
    const readStdin = vi.fn(async () => OPS);
    const handler = createSheetsFormatHandler({ readStdin });
    const ctx = createFakeContext({ sdk: fakeSdk({ sheets: { applyFormat } }) });

    expect(await handler(ctx, commandIntent([]))).toBe(EXIT_USAGE_ERROR);
    expect(readStdin).not.toHaveBeenCalled();
    expect(applyFormat).not.toHaveBeenCalled();
  });

  it('does not gate on --yes, unlike delete-rows', async () => {
    // Formatting is presentation, recoverable by writing it again. Prompting
    // for "bold the header row" would only train the habit of passing --yes
    // blind, which is what makes the gate on delete-rows worth anything.
    const applyFormat = vi.fn(async () => APPLY_RESULT);
    const prompt = vi.fn(async () => 'n');
    const handler = createSheetsFormatHandler({ readStdin: async () => OPS });
    const ctx = createFakeContext({ isTTY: true, prompt, sdk: fakeSdk({ sheets: { applyFormat } }) });

    expect(await handler(ctx, commandIntent(['pg_1']))).toBe(EXIT_SUCCESS);
    expect(prompt).not.toHaveBeenCalled();
    expect(applyFormat).toHaveBeenCalled();
  });

  it('surfaces a server refusal — which names the op index — as a runtime error', async () => {
    const applyFormat = vi.fn(async () => {
      throw new Error('Op 2 (setColumnWidth): "range" is not a field of this op.');
    });
    const stderr = createRecordingSink();
    const handler = createSheetsFormatHandler({ readStdin: async () => OPS });
    const ctx = createFakeContext({ stderr, sdk: fakeSdk({ sheets: { applyFormat } }) });

    expect(await handler(ctx, commandIntent(['pg_1']))).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('Op 2 (setColumnWidth)');
  });

  it('--json emits exactly the SDK response', async () => {
    const stdout = createRecordingSink();
    const handler = createSheetsFormatHandler({ readStdin: async () => OPS });
    const ctx = createFakeContext({ stdout, sdk: fakeSdk({ sheets: { applyFormat: async () => APPLY_RESULT } }) });

    await handler(ctx, commandIntent(['pg_1', '--json']));

    expect(JSON.parse(stdout.lines.join(''))).toEqual(APPLY_RESULT);
  });
});
