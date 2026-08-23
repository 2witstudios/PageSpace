import { describe, it, expect } from 'vitest';
import { parse as parseToml } from '@iarna/toml';
import {
  SHEETDOC_MAGIC,
  SHEETDOC_VERSION,
  createEmptySheet,
  parseSheetContent,
  parseSheetContentSafe,
  serializeSheetContent,
  stringifySheetDoc,
  SheetSerializationError,
  type SheetDoc,
} from '../sheets/sheet';

/**
 * Regression suite for the serializer's escaping.
 *
 * A cell value that serializes to invalid TOML is not a cosmetic problem: the
 * parser throws, `parseSheetContent` falls back to an empty sheet, and the
 * next autosave persists that empty sheet — losing every cell in the document,
 * not just the offending one. Public form submissions are written straight
 * through `updateSheetCells`, so the input reaching this code is not trusted.
 */

const serializeAndParse = (cells: Record<string, string>) => {
  const sheet = createEmptySheet();
  Object.assign(sheet.cells, cells);
  return parseSheetContent(serializeSheetContent(sheet));
};

describe('SheetDoc serialization round trip', () => {
  const hostileValues: Array<[name: string, value: string]> = [
    ['a newline', 'line one\nline two'],
    ['a CRLF', 'carriage\r\nreturn'],
    ['a bare carriage return', 'before\rafter'],
    ['a tab', 'column\tseparated'],
    ['a backslash', 'C:\\Users\\jono'],
    ['a double quote', 'she said "hello"'],
    ['triple quotes', 'a """ b'],
    ['a single quote', "it's fine"],
    ['a NUL byte', 'null\u0000byte'],
    ['a unit separator', 'unit\u001fseparator'],
    ['DEL', 'delete\u007fchar'],
    ['a TOML comment marker', '#not a comment = really'],
    ['a TOML table header', '[sheets.cells.A1]'],
    ['an equals sign', 'key = value'],
    ['an astral-plane emoji', 'party 🎉 time'],
    ['an RTL mark', 'mixed \u200fdirection'],
    ['a 10KB value', 'x'.repeat(10_000)],
    ['only whitespace-adjacent quotes', '   "   '],
  ];

  it.each(hostileValues)('preserves a cell containing %s', (_name, value) => {
    const parsed = serializeAndParse({ A1: value, B1: 'unrelated neighbour' });

    expect(parsed.cells.A1).toBe(value);
    // The neighbour is the canary: the failure mode is losing the whole
    // document, not just the cell that triggered it.
    expect(parsed.cells.B1).toBe('unrelated neighbour');
  });

  it.each(hostileValues)('emits parseable TOML for a cell containing %s', (_name, value) => {
    const sheet = createEmptySheet();
    sheet.cells.A1 = value;
    const serialized = serializeSheetContent(sheet);

    // Strip the magic header, which is not TOML.
    const body = serialized.split('\n').slice(1).join('\n');
    expect(() => parseToml(body)).not.toThrow();
  });

  it('preserves a formula containing a quoted newline', () => {
    const parsed = serializeAndParse({ A1: '="first\nsecond"', B1: '=1+1' });

    expect(parsed.cells.A1).toBe('="first\nsecond"');
    expect(parsed.cells.B1).toBe('=1+1');
  });

  it('round-trips many hostile cells at once', () => {
    const cells = Object.fromEntries(
      hostileValues.map(([, value], index) => [`A${index + 1}`, value])
    );
    const parsed = serializeAndParse(cells);

    expect(parsed.cells).toEqual(expect.objectContaining(cells));
    expect(Object.keys(parsed.cells)).toHaveLength(hostileValues.length);
  });

  it('quotes column keys that are not bare-key safe', () => {
    const doc: SheetDoc = {
      version: SHEETDOC_VERSION,
      sheets: [
        {
          name: 'Sheet1',
          order: 0,
          meta: { rowCount: 5, columnCount: 5 },
          columns: { 'a key with spaces': { width: 120 } },
          cells: {},
          ranges: {},
          dependencies: {},
        },
      ],
    };

    const body = stringifySheetDoc(doc).split('\n').slice(1).join('\n');
    expect(() => parseToml(body)).not.toThrow();
    expect(body).toContain('"a key with spaces"');
  });

  it('quotes range keys that are not bare-key safe', () => {
    const doc: SheetDoc = {
      version: SHEETDOC_VERSION,
      sheets: [
        {
          name: 'Sheet1',
          order: 0,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {},
          cells: {},
          ranges: { 'my range': { ref: 'A1:B2' } },
          dependencies: {},
        },
      ],
    };

    const body = stringifySheetDoc(doc).split('\n').slice(1).join('\n');
    expect(() => parseToml(body)).not.toThrow();
  });

  it('round-trips a Date, whatever its year', () => {
    // A Date reaches the emitter through an unknown format field of TOML
    // datetime type. `Object.entries(date)` is empty, so it once serialized as
    // `{}`; and `toISOString` uses the expanded-year form outside 0000-9999,
    // which is not TOML and failed the serializer's self-verify — making the
    // whole document unsavable rather than losing one field.
    // The restored type differs by year, deliberately: a year TOML can express
    // comes back as a real datetime, while an out-of-range one is quoted and
    // comes back as the string — preserved either way, and the document saves.
    const cases: Array<[string, Date, 'date' | 'string']> = [
      ['a normal year', new Date('2020-01-01T00:00:00Z'), 'date'],
      ['a five-digit year', new Date(Date.UTC(10000, 0, 1)), 'string'],
      ['a negative year', new Date(Date.UTC(-1, 0, 1)), 'string'],
    ];

    for (const [name, when, restoredAs] of cases) {
      const sheet = {
        ...createEmptySheet(),
        formats: { A1: { bold: true, when } as never },
      };

      expect(() => serializeSheetContent(sheet), name).not.toThrow();

      const restored = parseSheetContent(serializeSheetContent(sheet)).formats?.A1 as
        | (Record<string, unknown> | undefined);

      expect(restored?.bold, name).toBe(true);

      if (restoredAs === 'date') {
        expect(restored?.when, name).toBeInstanceOf(Date);
        expect((restored?.when as Date).toISOString(), name).toBe(when.toISOString());
      } else {
        expect(restored?.when, name).toBe(when.toISOString());
      }
    }
  });

  it('does not let an invalid Date break the document', () => {
    const sheet = {
      ...createEmptySheet(),
      formats: { A1: { bold: true, when: new Date('not a date') } as never },
    };

    expect(() => serializeSheetContent(sheet)).not.toThrow();
    expect(parseSheetContent(serializeSheetContent(sheet)).formats?.A1).toEqual({
      bold: true,
      when: '',
    });
  });

  it('quotes cell-address keys that are not bare-key safe', () => {
    const doc: SheetDoc = {
      version: SHEETDOC_VERSION,
      sheets: [
        {
          name: 'Sheet1',
          order: 0,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {},
          // Cell addresses are normally A1-shaped, but the emitter must not
          // depend on an upstream guarantee to produce valid TOML.
          cells: { 'not an address': { value: 1 } },
          ranges: {},
          dependencies: {},
        },
      ],
    };

    const body = stringifySheetDoc(doc).split('\n').slice(1).join('\n');
    expect(() => parseToml(body)).not.toThrow();
  });

  it('quotes dependency keys that are not bare-key safe', () => {
    const doc: SheetDoc = {
      version: SHEETDOC_VERSION,
      sheets: [
        {
          name: 'Sheet1',
          order: 0,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {},
          cells: {},
          ranges: {},
          dependencies: { 'not an address': { dependsOn: [], dependents: ['A1'] } },
        },
      ],
    };

    const body = stringifySheetDoc(doc).split('\n').slice(1).join('\n');
    expect(() => parseToml(body)).not.toThrow();
  });

  it('throws SheetSerializationError rather than emitting unparseable TOML', () => {
    // `order` is emitted as a bare numeric literal, so a non-finite value
    // produces `order = NaN` — invalid TOML. The guard must turn that into a
    // loud failure on save instead of content that reads back as an empty
    // sheet on the next load.
    const doc = {
      version: SHEETDOC_VERSION,
      sheets: [
        {
          name: 'Sheet1',
          order: Number.NaN,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {},
          cells: {},
          ranges: {},
          dependencies: {},
        },
      ],
    } as unknown as SheetDoc;

    expect(() => stringifySheetDoc(doc)).toThrow(SheetSerializationError);
  });
});

describe('parseSheetContentSafe', () => {
  it('reports a parse failure instead of silently returning an empty sheet', () => {
    const result = parseSheetContentSafe(`${SHEETDOC_MAGIC} ${SHEETDOC_VERSION}\nthis is [not toml`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('toml');
      expect(result.message).toBeTruthy();
    }
  });

  it('reports an unsupported version as a failure, not as empty content', () => {
    const result = parseSheetContentSafe(`${SHEETDOC_MAGIC} v99`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Unsupported SheetDoc version');
    }
  });

  it('reports malformed JSON as a failure', () => {
    const result = parseSheetContentSafe('{"cells": ');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('json');
    }
  });

  it('does not lock a page whose content was never a sheet', () => {
    // Legacy plain text or HTML on a SHEET page holds no sheet data to lose.
    // Reporting a failure would disable editing forever with nothing to
    // recover, so it degrades to an empty sheet as it always did.
    for (const legacy of ['<p>some old html</p>', 'just some text', 'not,a,sheet']) {
      const result = parseSheetContentSafe(legacy);
      expect(result.ok).toBe(true);
    }
  });

  it('still reports malformed JSON, which may be a truncated sheet', () => {
    const result = parseSheetContentSafe('{"cells": {"A1": "1"');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('json');
    }
  });

  it('emits parseable TOML for a hostile meta key on a carried-through tab', () => {
    // Extra tabs are re-emitted verbatim, including their meta, so an
    // unescaped meta key would make the whole document unsavable — every
    // keystroke would throw.
    const doc: SheetDoc = {
      version: SHEETDOC_VERSION,
      sheets: [
        {
          name: 'First',
          order: 0,
          meta: { rowCount: 5, columnCount: 5 },
          columns: {},
          cells: {},
          ranges: {},
          dependencies: {},
        },
        {
          name: 'Second',
          order: 1,
          meta: { rowCount: 5, columnCount: 5, 'a key with spaces': 'value' },
          columns: {},
          cells: {},
          ranges: {},
          dependencies: {},
        },
      ],
    };

    expect(() => stringifySheetDoc(doc)).not.toThrow();
    const body = stringifySheetDoc(doc).split('\n').slice(1).join('\n');
    expect(() => parseToml(body)).not.toThrow();
  });

  it('treats genuinely empty content as success', () => {
    for (const empty of ['', '   ', null, undefined]) {
      const result = parseSheetContentSafe(empty);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sheet.cells).toEqual({});
      }
    }
  });

  it('agrees with parseSheetContent on well-formed content', () => {
    const sheet = createEmptySheet();
    sheet.cells.A1 = 'value with\nnewline';
    const serialized = serializeSheetContent(sheet);

    const result = parseSheetContentSafe(serialized);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sheet).toEqual(parseSheetContent(serialized));
    }
  });
});

describe('cells outside the current rectangle', () => {
  it('survives a save instead of being silently deleted', () => {
    // The serializer used to walk `rowCount × columnCount` grid positions and
    // emit what it found there, so any cell beyond the rectangle — left behind
    // by shrinking the sheet, or written through the API — was dropped on the
    // next save with no error and no warning. It now walks the cells that
    // exist, so shrinking a sheet no longer destroys what falls outside.
    const sheet = createEmptySheet();
    sheet.rowCount = 5;
    sheet.columnCount = 5;
    sheet.cells.A1 = 'inside';
    sheet.cells.Z99 = 'outside';

    const restored = parseSheetContent(serializeSheetContent(sheet));

    expect(restored.cells.A1).toBe('inside');
    expect(restored.cells.Z99).toBe('outside');
  });

  it('keeps a formula that references a cell beyond the rectangle', () => {
    const sheet = createEmptySheet();
    sheet.rowCount = 3;
    sheet.columnCount = 3;
    sheet.cells.A1 = '=Z99*2';
    sheet.cells.Z99 = '21';

    const restored = parseSheetContent(serializeSheetContent(sheet));

    expect(restored.cells.A1).toBe('=Z99*2');
    expect(restored.cells.Z99).toBe('21');
  });
});
