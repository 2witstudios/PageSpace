import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { ResponseValidationError } from '../../errors.js';
import { appendRows, deleteRows, describeSheet, getRows, queryRows, updateCells } from '../sheets.js';

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
