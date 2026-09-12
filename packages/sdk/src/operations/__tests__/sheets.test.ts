import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { ResponseValidationError } from '../../errors.js';
import {
  appendRows,
  applySheetFormat,
  deleteRows,
  describeSheet,
  getRows,
  queryRows,
  readSheetFormatting,
  updateCells,
} from '../sheets.js';

const config = { baseUrl: 'https://pagespace.ai' };
const SHEETS_URL = 'https://pagespace.ai/api/mcp/sheets';

/** A formula cell as the store materialises it: authored text AND its result. */
const formulaCell = { raw: '=B1*C1', value: 7.5, type: 'number' as const };

describe('sheets — wire operation naming', () => {
  it('sends each method under its own operation, defaulted so callers need not repeat it', () => {
    // The facade method is the camelCase of the wire operation; if these drift,
    // a request lands on the wrong branch of the route's switch.
    const cases: ReadonlyArray<readonly [{ inputSchema: { parse: (v: unknown) => unknown } }, string]> = [
      [queryRows, 'query-rows'],
      [getRows, 'get-rows'],
      [describeSheet, 'describe'],
      [updateCells, 'update-cells'],
    ];
    for (const [operation, wire] of cases) {
      const parsed = operation.inputSchema.parse(
        operation === updateCells ? { pageId: 'p1', cells: [{ address: 'A1', value: 'x' }] } : { pageId: 'p1' },
      ) as { operation: string };
      expect(parsed.operation).toBe(wire);
    }
    expect((appendRows.inputSchema.parse({ pageId: 'p1', rows: [{ A: 'x' }] }) as { operation: string }).operation).toBe('append-rows');
    expect((deleteRows.inputSchema.parse({ pageId: 'p1', fromRow: 0, count: 1 }) as { operation: string }).operation).toBe('delete-rows');
  });

  it('posts to the sheets route, not the documents route', () => {
    const parsed = queryRows.inputSchema.parse({ pageId: 'p1' });
    const request = buildRequest(queryRows, parsed, config);
    expect(request.method).toBe('POST');
    expect(request.url).toBe(SHEETS_URL);
  });
});

describe('sheets.queryRows — filter shape', () => {
  it('accepts a nested and/or/not filter', () => {
    const where = {
      and: [
        { column: 'A', op: 'eq' as const, value: 'open' },
        { or: [{ column: 'B', op: 'gt' as const, value: 10 }, { not: { column: 'C', op: 'isEmpty' as const } }] },
      ],
    };
    const parsed = queryRows.inputSchema.parse({ pageId: 'p1', where });
    expect(buildRequest(queryRows, parsed, config).body).toContain('"op":"gt"');
  });

  it('accepts an array value for "in" and no value at all for "isEmpty"', () => {
    expect(() => queryRows.inputSchema.parse({ pageId: 'p1', where: { column: 'A', op: 'in', value: ['a', 1, true] } })).not.toThrow();
    expect(() => queryRows.inputSchema.parse({ pageId: 'p1', where: { column: 'A', op: 'isEmpty' } })).not.toThrow();
  });

  it('accepts a seven-letter column and rejects an eighth', () => {
    // Capping at three would make every column past ZZZ unfilterable — a 400
    // on valid input, which is what the route's own schema guards against.
    expect(() => queryRows.inputSchema.parse({ pageId: 'p1', select: ['ABCDEFG'] })).not.toThrow();
    expect(() => queryRows.inputSchema.parse({ pageId: 'p1', select: ['ABCDEFGH'] })).toThrow();
    expect(() => queryRows.inputSchema.parse({ pageId: 'p1', select: ['A1'] })).toThrow();
  });

  it('rejects a page size above the server ceiling before any request is made', () => {
    expect(() => queryRows.inputSchema.parse({ pageId: 'p1', limit: 5_000 })).not.toThrow();
    expect(() => queryRows.inputSchema.parse({ pageId: 'p1', limit: 5_001 })).toThrow();
  });
});

describe('sheets.queryRows — response contract', () => {
  it('parses rows carrying both authored text and computed value', () => {
    const fixture = {
      pageId: 's1', pageTitle: 'Ledger', tabIndex: 0,
      rows: [{ rowIndex: 0, cells: { A: { raw: 'widget', value: 'widget', type: 'string' }, D: formulaCell } }],
      total: 42,
      hasMore: true,
    };
    const result = parseResponse(queryRows, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });

  it('keeps cell formatting as opaque data rather than rejecting it', () => {
    // `CellFormat` already exists in db and lib with a compile-time guard
    // between them; a third hand-written copy here would be the one nothing
    // keeps honest, and would reject valid responses the first time a format
    // key is added.
    const fixture = {
      pageId: 's1', pageTitle: null, tabIndex: 0,
      rows: [{ rowIndex: 0, cells: { A: { raw: '1', value: 1, type: 'number', format: { bold: true, number: { kind: 'currency', currency: 'USD' } } } } }],
      total: 1, hasMore: false,
    };
    expect(parseResponse(queryRows, 200, new Headers(), JSON.stringify(fixture))).toEqual(fixture);
  });

  it('parses an error cell', () => {
    const fixture = {
      pageId: 's1', pageTitle: null, tabIndex: 0,
      rows: [{ rowIndex: 3, cells: { B: { raw: '=1/0', error: { type: 'DIV/0', message: 'Division by zero' } } } }],
      total: 1, hasMore: false,
    };
    expect(parseResponse(queryRows, 200, new Headers(), JSON.stringify(fixture))).toEqual(fixture);
  });

  it('rejects a response missing the match total', () => {
    // `total` is what lets a caller say "20 of 4,312" without a second request.
    const fixture = { pageId: 's1', pageTitle: null, tabIndex: 0, rows: [], hasMore: false };
    expect(parseResponse(queryRows, 200, new Headers(), JSON.stringify(fixture))).toBeInstanceOf(ResponseValidationError);
  });
});

describe('sheets.getRows — positional paging', () => {
  it('parses the continuation cursor, including the empty-page null', () => {
    // `nextFromRow` is a POSITION. A caller advancing by rows.length would loop
    // forever on a sparse tab (rows 0-9, then 500-509); following this
    // terminates.
    const fixture = {
      pageId: 's1', pageTitle: 'Ledger', tabIndex: 0,
      rows: [{ rowIndex: 500, cells: { A: { raw: 'x' } } }],
      rowCount: 510, columnCount: 8, nextFromRow: 501, hasMore: true,
    };
    expect(parseResponse(getRows, 200, new Headers(), JSON.stringify(fixture))).toEqual(fixture);

    const exhausted = { ...fixture, rows: [], nextFromRow: null, hasMore: false };
    expect(parseResponse(getRows, 200, new Headers(), JSON.stringify(exhausted))).toEqual(exhausted);
  });
});

describe('sheets.describe — input contract', () => {
  it('refuses a tabIndex, which could only make tab discovery fail', () => {
    // The route resolves getTab({pageId, tabIndex}) before dispatching, so a
    // non-existent index 409s before the describe branch — which lists every
    // tab and ignores the index. Accepting the field would break discovery for
    // exactly the caller who does not yet know which tabs exist.
    expect(() => describeSheet.inputSchema.parse({ pageId: 'p1' })).not.toThrow();
    expect(() => describeSheet.inputSchema.parse({ pageId: 'p1', tabIndex: 3 })).toThrow();
  });

  it('still takes tabIndex on every operation that actually uses it', () => {
    for (const operation of [queryRows, getRows]) {
      expect(() => operation.inputSchema.parse({ pageId: 'p1', tabIndex: 3 })).not.toThrow();
    }
    expect(() => appendRows.inputSchema.parse({ pageId: 'p1', tabIndex: 3, rows: [{ A: 'x' }] })).not.toThrow();
    expect(() => deleteRows.inputSchema.parse({ pageId: 'p1', tabIndex: 3, fromRow: 0, count: 1 })).not.toThrow();
  });
});

describe('sheets.describe — response contract', () => {
  it('parses tabs with a null frozen-row count', () => {
    const fixture = {
      pageId: 's1', pageTitle: 'Ledger',
      tabs: [{ tabIndex: 0, name: 'Sheet1', rowCount: 5305, columnCount: 10, frozenRows: null }],
    };
    expect(parseResponse(describeSheet, 200, new Headers(), JSON.stringify(fixture))).toEqual(fixture);
  });
});

describe('sheets writes — response contracts', () => {
  it('appendRows reports where the batch landed', () => {
    // `firstRowIndex` lets a caller address what it just wrote without
    // re-reading the sheet.
    const fixture = { pageId: 's1', pageTitle: 'Ledger', firstRowIndex: 5, appended: 3, rowCount: 8 };
    expect(parseResponse(appendRows, 200, new Headers(), JSON.stringify(fixture))).toEqual(fixture);
  });

  it('appendRows rejects an empty batch before any request', () => {
    expect(() => appendRows.inputSchema.parse({ pageId: 'p1', rows: [] })).toThrow();
  });

  it('updateCells reports the recompute count, not a whole-sheet recalculation', () => {
    const fixture = { pageId: 's1', pageTitle: 'Ledger', cellsUpdated: 1, recomputed: 2, rowCount: 5305, columnCount: 10 };
    expect(parseResponse(updateCells, 200, new Headers(), JSON.stringify(fixture))).toEqual(fixture);
  });

  it('updateCells requires A1 addresses', () => {
    expect(() => updateCells.inputSchema.parse({ pageId: 'p1', cells: [{ address: 'A1', value: 'x' }] })).not.toThrow();
    expect(() => updateCells.inputSchema.parse({ pageId: 'p1', cells: [{ address: 'A', value: 'x' }] })).toThrow();
  });

  it('deleteRows requires both bounds — neither is guessed', () => {
    // A wrong guess here destroys data, so the route refuses rather than
    // defaulting; the schema refuses first, without a network call.
    expect(() => deleteRows.inputSchema.parse({ pageId: 'p1', fromRow: 0, count: 5 })).not.toThrow();
    expect(() => deleteRows.inputSchema.parse({ pageId: 'p1', fromRow: 0 })).toThrow();
    expect(() => deleteRows.inputSchema.parse({ pageId: 'p1', count: 5 })).toThrow();
  });

  it('deleteRows parses its result', () => {
    const fixture = { pageId: 's1', pageTitle: 'Ledger', deleted: 5, rowCount: 5300 };
    expect(parseResponse(deleteRows, 200, new Headers(), JSON.stringify(fixture))).toEqual(fixture);
  });
});


// ---------------------------------------------------------------------------
// Formatting — the presentation half
// ---------------------------------------------------------------------------

/** The minimum a stored `cell` rule needs; `format` is opaque by design. */
const cellRule = {
  kind: 'cell' as const,
  id: 'r1',
  ranges: ['C2:C40'],
  condition: { operator: 'lessThan' as const, value: '0' },
  format: { color: '#b91c1c', bold: true },
};

describe('sheets formatting — wire operation naming', () => {
  it('defaults each operation field, so a caller need not repeat it', () => {
    expect((readSheetFormatting.inputSchema.parse({ pageId: 'p1' }) as { operation: string }).operation)
      .toBe('read-formatting');
    expect(
      (applySheetFormat.inputSchema.parse({
        pageId: 'p1',
        ops: [{ type: 'clearConditionalRules' }],
      }) as { operation: string }).operation,
    ).toBe('apply-format');
  });

  it('posts both to the sheets route', () => {
    for (const operation of [readSheetFormatting, applySheetFormat] as const) {
      expect(operation.method).toBe('POST');
      expect(operation.path).toBe('/api/mcp/sheets');
    }
  });

  it('leaves applyFormat non-destructive, so the CLI does not demand --yes to bold a header', () => {
    // Formatting is presentation: writing it again restores it. `deleteRows`
    // is the flagged one because the rows are gone.
    expect(applySheetFormat.destructive).toBeUndefined();
    expect(deleteRows.destructive).toBe(true);
  });
});

describe('sheets.readFormatting', () => {
  it('takes no ranges at all, and reads the declarative layer for free', () => {
    // The layer a caller about to WRITE formatting needs. Per-cell formats
    // live on the rows, so they cost a read and are opt-in.
    expect(() => readSheetFormatting.inputSchema.parse({ pageId: 'p1' })).not.toThrow();
    expect(() => readSheetFormatting.inputSchema.parse({ pageId: 'p1', ranges: ['A1:F40', 'H2'] })).not.toThrow();
  });

  it('parses the whole presentation model, rules and regions included', () => {
    const fixture = {
      pageId: 's1',
      pageTitle: 'Budget',
      tabIndex: 0,
      rowCount: 40,
      columnCount: 6,
      frozenRows: 1,
      frozenColumns: null,
      columnFormats: { C: { number: { kind: 'currency', currency: 'USD' } } },
      columnWidths: { C: 140 },
      rowHeights: { '1': 32 },
      conditionalFormats: [
        cellRule,
        { kind: 'colorScale', id: 'r2', ranges: ['D2:D40'], min: { type: 'min', color: '#ffffff' }, max: { type: 'max', color: '#1d4ed8' } },
        { kind: 'dataBar', id: 'r3', ranges: ['E2:E40'], color: '#1d4ed8' },
        { kind: 'formula', id: 'r4', ranges: ['A2:A40'], formula: '=A2>AVERAGE(A2:A40)', format: { bold: true } },
      ],
      regions: [
        { id: 'g1', name: 'Spend', range: 'A1:F', headerRows: 1, totalRows: [40], columns: [{ column: 'C', role: 'currency', currency: 'USD' }], theme: 'blue' },
      ],
      cellFormats: { A1: { bold: true } },
    };
    expect(parseResponse(readSheetFormatting, 200, new Headers(), JSON.stringify(fixture))).toEqual(fixture);
  });

  it('rejects a response whose rule kind is not one of the four', () => {
    // The read exists so a caller can write what it read straight back. A rule
    // shape the caller cannot round-trip must not arrive as a valid one.
    const fixture = {
      pageId: 's1', pageTitle: 'Budget', tabIndex: 0, rowCount: 1, columnCount: 1,
      frozenRows: null, frozenColumns: null,
      columnFormats: {}, columnWidths: {}, rowHeights: {},
      conditionalFormats: [{ kind: 'gradient', id: 'r1', ranges: ['A1'] }],
      regions: [], cellFormats: {},
    };
    expect(() => parseResponse(readSheetFormatting, 200, new Headers(), JSON.stringify(fixture)))
      .toThrow(ResponseValidationError);
  });
});

describe('sheets.applyFormat — the op union', () => {
  it('accepts every op in the union', () => {
    const ops = [
      { type: 'setCellFormat', range: 'A1:F1', patch: { bold: true } },
      { type: 'clearCellFormat', range: 'A2:F2' },
      { type: 'setColumnFormat', column: 'C', patch: { number: { kind: 'currency' } } },
      { type: 'setColumnWidth', column: 'C', width: 140 },
      { type: 'setRowHeight', row: 1, height: 32 },
      { type: 'setFrozen', rows: 1 },
      { type: 'addConditionalRule', rule: cellRule },
      { type: 'updateConditionalRule', id: 'r1', patch: { ranges: ['C2:C99'] } },
      { type: 'removeConditionalRule', id: 'r1' },
      { type: 'moveConditionalRule', id: 'r1', direction: 1 },
      { type: 'clearConditionalRules' },
      { type: 'setConditionalRules', rules: [cellRule] },
      { type: 'setRegions', regions: [{ id: 'g1', range: 'A1:F' }] },
      { type: 'upsertRegion', region: { id: 'g1', range: 'A1:F', headerRows: 1 } },
      { type: 'removeRegion', id: 'g1' },
    ];
    expect(() => applySheetFormat.inputSchema.parse({ pageId: 'p1', ops })).not.toThrow();
    // Every op sent, in the order given: `clearCellFormat` after
    // `setCellFormat` over the same cells means something different from the
    // reverse, so a schema that reordered or deduped them would be wrong.
    const parsed = applySheetFormat.inputSchema.parse({ pageId: 'p1', ops }) as { ops: Array<{ type: string }> };
    expect(parsed.ops.map((op) => op.type)).toEqual(ops.map((op) => op.type));
  });

  it('rejects an empty op list and an unknown op type before any request', () => {
    expect(() => applySheetFormat.inputSchema.parse({ pageId: 'p1', ops: [] })).toThrow();
    expect(() => applySheetFormat.inputSchema.parse({ pageId: 'p1', ops: [{ type: 'setBorders', range: 'A1' }] })).toThrow();
  });

  it('rejects a field the op does not take, rather than sending it to be ignored', () => {
    // A caller that sent `{type: 'setFrozen', rows: 1, range: 'A1:F1'}`
    // believes it froze AND styled; an op that silently did half of that
    // reports success for something other than what was asked.
    expect(() => applySheetFormat.inputSchema.parse({
      pageId: 'p1',
      ops: [{ type: 'setFrozen', rows: 1, range: 'A1:F1' }],
    })).toThrow();
  });

  it('requires setFrozen to name an axis, and lets null clear one', () => {
    expect(() => applySheetFormat.inputSchema.parse({ pageId: 'p1', ops: [{ type: 'setFrozen' }] })).toThrow();
    expect(() => applySheetFormat.inputSchema.parse({ pageId: 'p1', ops: [{ type: 'setFrozen', rows: null }] })).not.toThrow();
    // An omitted axis keeps whatever the tab holds, under the server's lock —
    // so "freeze one row" never has to restate a column freeze.
    const parsed = applySheetFormat.inputSchema.parse({
      pageId: 'p1', ops: [{ type: 'setFrozen', rows: 1 }],
    }) as { ops: Array<Record<string, unknown>> };
    expect('columns' in parsed.ops[0]!).toBe(false);
  });

  it('lets null clear a width or height, and refuses one below the minimum', () => {
    expect(() => applySheetFormat.inputSchema.parse({ pageId: 'p1', ops: [{ type: 'setColumnWidth', column: 'C', width: null }] })).not.toThrow();
    expect(() => applySheetFormat.inputSchema.parse({ pageId: 'p1', ops: [{ type: 'setColumnWidth', column: 'C', width: 1 }] })).toThrow();
    expect(() => applySheetFormat.inputSchema.parse({ pageId: 'p1', ops: [{ type: 'setRowHeight', row: 1, height: null }] })).not.toThrow();
    expect(() => applySheetFormat.inputSchema.parse({ pageId: 'p1', ops: [{ type: 'setRowHeight', row: 0, height: 32 }] })).toThrow();
  });

  it('requires a caller-supplied rule id — the caller\'s own idempotency key', () => {
    // Unlike the AI tool, which mints ids. Here a retried `addConditionalRule`
    // after a timeout is refused as a duplicate instead of adding the rule a
    // second time under a fresh id.
    const { id: _id, ...withoutId } = cellRule;
    expect(() => applySheetFormat.inputSchema.parse({ pageId: 'p1', ops: [{ type: 'addConditionalRule', rule: withoutId }] })).toThrow();
  });

  it('rejects a cell rule sent in the AI tool\'s flat shape', () => {
    // `format_sheet` flattens `operator`/`value` onto the rule because a
    // discriminated union blows past the schema-size ceiling a model's tool
    // definition can carry. The stored shape nests them under `condition`, and
    // a caller that guessed the flat one must be told, not silently dropped.
    expect(() => applySheetFormat.inputSchema.parse({
      pageId: 'p1',
      ops: [{ type: 'addConditionalRule', rule: { kind: 'cell', id: 'r1', ranges: ['A1'], operator: 'lessThan', value: '0', format: { bold: true } } }],
    })).toThrow();
  });

  it('refuses more ops than the server will plan', () => {
    const op = { type: 'clearCellFormat', range: 'A1' };
    expect(() => applySheetFormat.inputSchema.parse({ pageId: 'p1', ops: Array.from({ length: 200 }, () => op) })).not.toThrow();
    expect(() => applySheetFormat.inputSchema.parse({ pageId: 'p1', ops: Array.from({ length: 201 }, () => op) })).toThrow();
  });

  it('parses a result, including the no-op retry', () => {
    const fixture = {
      pageId: 's1', pageTitle: 'Budget', tabIndex: 0,
      changed: true,
      cellsFormatted: 6, rowsTouched: 1, tabFieldsChanged: ['frozenRows', 'regions'],
      conditionalRules: 2, ruleIdsAdded: ['r1'], ruleIdsRemoved: [],
      regions: 1, regionIdsAdded: ['g1'], regionIdsRemoved: [],
      rowCount: 40, columnCount: 6, recomputed: [],
    };
    expect(parseResponse(applySheetFormat, 200, new Headers(), JSON.stringify(fixture))).toEqual(fixture);
    // `changed: false` is the sheet already looking like this. A caller must be
    // able to tell that apart from a write, so the field is not optional.
    const noop = { ...fixture, changed: false, cellsFormatted: 0, rowsTouched: 0, tabFieldsChanged: [], ruleIdsAdded: [], regionIdsAdded: [] };
    expect(parseResponse(applySheetFormat, 200, new Headers(), JSON.stringify(noop))).toEqual(noop);
    const { changed: _changed, ...missing } = fixture;
    expect(() => parseResponse(applySheetFormat, 200, new Headers(), JSON.stringify(missing))).toThrow(ResponseValidationError);
  });
});
