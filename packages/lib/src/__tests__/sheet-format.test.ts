import { describe, it, expect } from 'vitest';
import {
  applyNumberFormat,
  cellFormatSchema,
  cellFormatToInlineCss,
  cellFormatToStyle,
  clearCellFormats,
  createEmptySheet,
  evaluateSheet,
  getEffectiveCellFormat,
  isValidHexColor,
  moveCellMetadata,
  numberFormatToExcelCode,
  parseCellFormat,
  resolveCellFormat,
  parseSheetContent,
  sanitizeSheetData,
  serializeSheetContent,
  setCellFormats,
  setColumnFormat,
  setColumnWidth,
  setFrozen,
  setRowHeight,
  shiftAxisMetadata,
  type CellFormat,
  type SheetData,
} from '../sheets/sheet';

const displayOf = (sheet: SheetData, address: string) =>
  evaluateSheet(sheet).byAddress[address]?.display;

describe('applyNumberFormat', () => {
  it.each([
    ['number with default decimals', 1234.5, { kind: 'number' as const }, '1,234.50'],
    ['number without grouping', 1234.5, { kind: 'number' as const, thousands: false }, '1234.50'],
    ['number with zero decimals', 1234.56, { kind: 'number' as const, decimals: 0 }, '1,235'],
    ['currency', 1234.5, { kind: 'currency' as const, currency: 'USD' }, '$1,234.50'],
    ['negative currency', -1234.5, { kind: 'currency' as const, currency: 'USD' }, '-$1,234.50'],
    ['zero currency', 0, { kind: 'currency' as const, currency: 'USD' }, '$0.00'],
    ['euro currency', 10, { kind: 'currency' as const, currency: 'EUR', decimals: 0 }, '€10'],
    ['unknown currency falls back to the code', 10, { kind: 'currency' as const, currency: 'SEK', decimals: 0 }, 'SEK 10'],
    ['percent', 0.15, { kind: 'percent' as const }, '15%'],
    ['percent with decimals', 0.1555, { kind: 'percent' as const, decimals: 2 }, '15.55%'],
    ['scientific', 12345, { kind: 'scientific' as const, decimals: 2 }, '1.23e+4'],
    ['plain', 1234.5, { kind: 'plain' as const }, '1234.5'],
    ['text', 42, { kind: 'text' as const }, '42'],
  ])('formats %s', (_name, value, format, expected) => {
    expect(applyNumberFormat(value, format)).toBe(expected);
  });

  it('formats dates without shifting the day across timezones', () => {
    // The engine stores dates as strings. Going through `new Date(string)` would
    // parse this as UTC midnight and then read local getters, landing on the
    // previous day west of Greenwich.
    expect(applyNumberFormat('2026-01-01', { kind: 'date', dateStyle: 'iso' })).toBe('2026-01-01');
    expect(applyNumberFormat('2026-01-01', { kind: 'date', dateStyle: 'short' })).toBe('1/1/2026');
    expect(applyNumberFormat('2026-01-01', { kind: 'date', dateStyle: 'long' })).toBe(
      'January 1, 2026'
    );
    expect(applyNumberFormat('2026-01-01', { kind: 'date', dateStyle: 'medium' })).toBe(
      'Jan 1, 2026'
    );
  });

  it('formats times and datetimes', () => {
    expect(applyNumberFormat('2026-01-01T09:05:03', { kind: 'time' })).toBe('09:05:03');
    expect(applyNumberFormat('2026-01-01T09:05:03', { kind: 'datetime', dateStyle: 'iso' })).toBe(
      '2026-01-01 09:05:03'
    );
  });

  it('declines rather than mangling values a format cannot render', () => {
    // Returning null lets the caller fall back to the engine's own rendering,
    // so an inapplicable format degrades to the plain value.
    expect(applyNumberFormat('not a number', { kind: 'currency' })).toBeNull();
    expect(applyNumberFormat('not a date', { kind: 'date' })).toBeNull();
    expect(applyNumberFormat(true, { kind: 'currency' })).toBeNull();
    expect(applyNumberFormat(1, { kind: 'auto' })).toBeNull();
    expect(applyNumberFormat(1, undefined)).toBeNull();
    expect(applyNumberFormat(Number.POSITIVE_INFINITY, { kind: 'number' })).toBeNull();
  });

  it('coerces numeric strings so imported text numbers still format', () => {
    expect(applyNumberFormat('1234.5', { kind: 'currency', currency: 'USD' })).toBe('$1,234.50');
  });

  it('renders an unrecognised custom pattern as plain rather than discarding it', () => {
    const format = { kind: 'custom' as const, pattern: '[Red]#,##0.00_);' };
    expect(applyNumberFormat(5, format)).toBeNull();
    // …but the pattern survives to the Excel round trip.
    expect(numberFormatToExcelCode(format)).toBe('[Red]#,##0.00_);');
  });

  it('clamps decimals to the supported range', () => {
    expect(applyNumberFormat(1, { kind: 'number', decimals: 999 })).toBe('1.0000000000');
    expect(applyNumberFormat(1, { kind: 'number', decimals: -5 })).toBe('1');
  });
});

describe('numberFormatToExcelCode', () => {
  it.each([
    [{ kind: 'number' as const }, '#,##0.00'],
    [{ kind: 'number' as const, thousands: false, decimals: 0 }, '0'],
    [{ kind: 'currency' as const, currency: 'USD' }, '"$"#,##0.00'],
    [{ kind: 'percent' as const, decimals: 1 }, '0.0%'],
    [{ kind: 'scientific' as const, decimals: 2 }, '0.00E+00'],
    [{ kind: 'date' as const }, 'yyyy-mm-dd'],
    [{ kind: 'text' as const }, '@'],
  ])('maps %o', (format, expected) => {
    expect(numberFormatToExcelCode(format)).toBe(expected);
  });

  it('returns undefined when Excel default rendering is correct', () => {
    expect(numberFormatToExcelCode({ kind: 'auto' })).toBeUndefined();
    expect(numberFormatToExcelCode(undefined)).toBeUndefined();
  });
});

describe('format validation', () => {
  it('accepts a well-formed format', () => {
    const format: CellFormat = {
      bold: true,
      color: '#112233',
      background: '#AABBCC',
      align: 'right',
      number: { kind: 'currency', currency: 'USD', decimals: 2 },
    };
    expect(cellFormatSchema.safeParse(format).success).toBe(true);
    expect(parseCellFormat(format)).toEqual(format);
  });

  it.each([
    ['a javascript: url', { color: 'javascript:alert(1)' }],
    ['an rgb() function', { color: 'rgb(255,0,0)' }],
    ['a css injection attempt', { background: '#fff;background:url(x)' }],
    ['a named color', { color: 'red' }],
    ['a short hex', { color: '#fff' }],
    ['an out-of-range font size', { fontSize: 9999 }],
    ['an unknown alignment', { align: 'justify' }],
  ])('rejects %s', (_name, format) => {
    expect(parseCellFormat(format)).toBeUndefined();
  });

  it('rejects non-hex colors at the render boundary too', () => {
    // Defence in depth: even if a bad color reached storage, it must not be
    // emitted into a style attribute on a published page.
    expect(isValidHexColor('javascript:alert(1)')).toBe(false);
    const css = cellFormatToInlineCss({ color: 'javascript:alert(1)' } as CellFormat);
    expect(css).not.toContain('javascript');
    expect(css).toBe('');
  });

  it('never emits CSS-significant characters', () => {
    const css = cellFormatToInlineCss({
      bold: true,
      color: '#001122',
      background: '#334455',
    });
    expect(css).toBe('font-weight:600;color:#001122;background-color:#334455');
    // Semicolons separate declarations and are expected; braces, angle brackets
    // and quotes would mean something escaped the allow-list.
    expect(css).not.toMatch(/[{}<>"']/);
  });

  it('does not throw on a stored __proto__ key', () => {
    // `FIELD_SCHEMAS[key]` on an object literal resolves `__proto__` through
    // the prototype chain to a non-schema, which threw inside every load and
    // every save of a document carrying such a key.
    const hostile = JSON.parse('{"bold":true,"__proto__":{"polluted":"yes"},"constructor":{"x":1}}');

    expect(() => parseCellFormat(hostile)).not.toThrow();
    expect(parseCellFormat(hostile)).toEqual({ bold: true });
  });

  it('cannot reach Object.prototype through a stored format', () => {
    const hostile = JSON.parse('{"bold":true,"__proto__":{"polluted":"yes"}}');

    let sheet = createEmptySheet();
    sheet = setCellFormats(sheet, ['A1'], parseCellFormat(hostile)!);
    resolveCellFormat(parseCellFormat(hostile), { align: 'right' });

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(sheet.formats?.A1).toEqual({ bold: true });
  });

  it('keeps an unknown field out of the rendered CSS', () => {
    // Unknown fields are preserved for forward compatibility, so they must be
    // inert at every render boundary.
    const format = parseCellFormat({
      bold: true,
      evilKey: '"><script>alert(1)</script>',
      color: '#001122',
    });

    expect(format).toHaveProperty('evilKey');
    expect(cellFormatToInlineCss(format)).toBe('font-weight:600;color:#001122');
    expect(Object.keys(cellFormatToStyle(format))).toEqual(['fontWeight', 'color']);
  });

  it('treats an empty format as absent', () => {
    expect(parseCellFormat({})).toBeUndefined();
    expect(parseCellFormat({ bold: undefined })).toBeUndefined();
  });
});

describe('cellFormatToStyle', () => {
  it('maps every supported field', () => {
    const style = cellFormatToStyle({
      bold: true,
      italic: true,
      underline: true,
      strike: true,
      align: 'center',
      valign: 'top',
      wrap: true,
      color: '#111111',
      background: '#222222',
      fontSize: 14,
      fontFamily: 'mono',
      borders: { top: { style: 'thick', color: '#333333' } },
    });

    expect(style.fontWeight).toBe('600');
    expect(style.fontStyle).toBe('italic');
    expect(style.textDecoration).toBe('underline line-through');
    expect(style.textAlign).toBe('center');
    expect(style.alignItems).toBe('flex-start');
    expect(style.whiteSpace).toBe('pre-wrap');
    expect(style.color).toBe('#111111');
    expect(style.backgroundColor).toBe('#222222');
    expect(style.fontSize).toBe('14px');
    expect(style.fontFamily).toContain('--font-mono');
    expect(style.borderTop).toBe('3px solid #333333');
  });

  it('returns an empty object for no format', () => {
    expect(cellFormatToStyle(undefined)).toEqual({});
  });
});

describe('format operations', () => {
  it('merges patches and drops fields set to undefined', () => {
    let sheet = createEmptySheet();
    sheet = setCellFormats(sheet, ['A1'], { bold: true, italic: true });
    expect(sheet.formats?.A1).toEqual({ bold: true, italic: true });

    sheet = setCellFormats(sheet, ['A1'], { bold: undefined });
    expect(sheet.formats?.A1).toEqual({ italic: true });
  });

  it('removes the entry entirely once nothing is left', () => {
    let sheet = createEmptySheet();
    sheet = setCellFormats(sheet, ['A1'], { bold: true });
    sheet = setCellFormats(sheet, ['A1'], { bold: undefined });
    expect(sheet.formats).toBeUndefined();
  });

  it('normalizes addresses and ignores invalid ones', () => {
    let sheet = createEmptySheet();
    sheet = setCellFormats(sheet, ['a1', 'not-an-address'], { bold: true });
    expect(Object.keys(sheet.formats ?? {})).toEqual(['A1']);
  });

  it('clears formatting without touching values', () => {
    let sheet = createEmptySheet();
    sheet.cells.A1 = 'keep me';
    sheet = setCellFormats(sheet, ['A1'], { bold: true });
    sheet = clearCellFormats(sheet, ['A1']);

    expect(sheet.formats).toBeUndefined();
    expect(sheet.cells.A1).toBe('keep me');
  });

  it('lets a cell format override its column default', () => {
    let sheet = createEmptySheet();
    sheet = setColumnFormat(sheet, 0, { align: 'right', bold: true });
    sheet = setCellFormats(sheet, ['A1'], { align: 'center' });

    expect(getEffectiveCellFormat(sheet, 'A1')).toEqual({ align: 'center', bold: true });
    expect(getEffectiveCellFormat(sheet, 'A2')).toEqual({ align: 'right', bold: true });
  });

  it('clamps widths and heights to sane bounds', () => {
    let sheet = createEmptySheet();
    sheet = setColumnWidth(sheet, 0, 5);
    sheet = setRowHeight(sheet, 0, 100000);

    expect(sheet.columnWidths?.A).toBe(24);
    expect(sheet.rowHeights?.['1']).toBe(1000);

    sheet = setColumnWidth(sheet, 0, undefined);
    expect(sheet.columnWidths).toBeUndefined();
  });

  it('treats a zero freeze as no freeze', () => {
    const sheet = setFrozen(createEmptySheet(), 0, 2);
    expect(sheet.frozenRows).toBeUndefined();
    expect(sheet.frozenColumns).toBe(2);
  });

  it('does not let a normalized key destroy its collision partner', () => {
    // `A1` and `a1` normalize to the same address. Without a guard the loser
    // is decided by iteration order and its formatting is gone.
    const sheet: SheetData = {
      ...createEmptySheet(),
      formats: { A1: { bold: true }, a1: { italic: true } } as Record<string, CellFormat>,
    };

    const moved = moveCellMetadata(sheet, new Map());

    expect(Object.keys(moved.formats ?? {})).toEqual(['A1']);
    expect(moved.formats?.A1).toEqual({ bold: true });
    // The map changed, so the version must say so.
    expect(moved.version).toBe(sheet.version + 1);
  });

  it('bumps the version when a collision drops the loser in the relocation pass', () => {
    // The winner maps to its own address, so the "did the key change?" signal
    // says no — but the loser's formatting is gone, which is a change.
    const sheet: SheetData = {
      ...createEmptySheet(),
      formats: { C1: { bold: true }, B1: { italic: true } } as Record<string, CellFormat>,
    };

    const moved = moveCellMetadata(sheet, new Map([['C1', 'C1'], ['B1', 'C1']]));

    expect(moved.formats).toEqual({ C1: { bold: true } });
    expect(moved.version).toBe(sheet.version + 1);
  });

  it('bumps the version whenever the format map actually changes', () => {
    const withLowercase: SheetData = {
      ...createEmptySheet(),
      formats: { a1: { bold: true } } as Record<string, CellFormat>,
    };
    // A key rewritten by normalization is a change even with an empty map.
    expect(moveCellMetadata(withLowercase, new Map()).version).toBe(withLowercase.version + 1);

    let unchanged = createEmptySheet();
    unchanged = setCellFormats(unchanged, ['A1'], { bold: true });
    expect(moveCellMetadata(unchanged, new Map()).version).toBe(unchanged.version);
  });

  it('bumps the version when a format is dropped for an unmappable target', () => {
    let sheet = createEmptySheet();
    sheet = setCellFormats(sheet, ['A1'], { bold: true });

    const moved = moveCellMetadata(sheet, new Map([['A1', 'not-an-address']]));

    expect(moved.formats).toBeUndefined();
    expect(moved.version).toBe(sheet.version + 1);
  });

  it('shifts column widths and formats when a column is inserted', () => {
    let sheet = createEmptySheet();
    sheet = setColumnWidth(sheet, 0, 100);
    sheet = setColumnWidth(sheet, 2, 300);
    sheet = setColumnFormat(sheet, 2, { bold: true });

    const shifted = shiftAxisMetadata(sheet, 'column', 1, 1);

    // A stays put; C moves to D and takes its width and default format with it.
    expect(shifted.columnWidths?.A).toBe(100);
    expect(shifted.columnWidths?.D).toBe(300);
    expect(shifted.columnWidths?.C).toBeUndefined();
    expect(shifted.columnFormats?.D).toEqual({ bold: true });
  });

  it('drops per-column metadata for a deleted column', () => {
    let sheet = createEmptySheet();
    sheet = setColumnWidth(sheet, 1, 200);
    sheet = setColumnWidth(sheet, 2, 300);

    const shifted = shiftAxisMetadata(sheet, 'column', 1, -1);

    expect(shifted.columnWidths?.B).toBe(300);
    expect(Object.keys(shifted.columnWidths ?? {})).toEqual(['B']);
  });

  it('shifts row heights when a row is inserted', () => {
    let sheet = createEmptySheet();
    sheet = setRowHeight(sheet, 0, 20);
    sheet = setRowHeight(sheet, 4, 60);

    const shifted = shiftAxisMetadata(sheet, 'row', 1, 2);

    expect(shifted.rowHeights?.['1']).toBe(20);
    expect(shifted.rowHeights?.['7']).toBe(60);
  });

  it('relocates formats when cells move', () => {
    let sheet = createEmptySheet();
    sheet = setCellFormats(sheet, ['A1', 'A2'], { bold: true });

    const moved = moveCellMetadata(
      sheet,
      new Map([
        ['A1', 'A5'],
        ['A2', null],
      ])
    );

    expect(moved.formats?.A5).toEqual({ bold: true });
    expect(moved.formats?.A1).toBeUndefined();
    expect(moved.formats?.A2).toBeUndefined();
  });
});

describe('review findings', () => {
  it('the currency Excel code honours thousands: false', () => {
    // `applyNumberFormat` renders ungrouped for this format; the Excel code
    // must match or the workbook groups digits the grid does not.
    const format = { kind: 'currency' as const, currency: 'USD', thousands: false };
    expect(applyNumberFormat(1234.5, format)).toBe('$1234.50');
    expect(numberFormatToExcelCode(format)).toBe('"$"0.00');
  });

  it('drops only the offending field, not the whole format', () => {
    // An invalid field must not take valid ones with it: the user can see the
    // bold and did not ask to lose it.
    const sheet: SheetData = {
      ...createEmptySheet(),
      formats: {
        A1: { fontSize: 9999 } as CellFormat,
        A2: { bold: true, fontSize: 5 } as CellFormat,
      },
    };

    const sanitized = sanitizeSheetData(sheet);
    expect(sanitized.formats?.A1).toBeUndefined();
    expect(sanitized.formats?.A2).toEqual({ bold: true });
  });

  it('preserves a format field written by a newer build', () => {
    // Stripping unknown fields would delete a newer build's work the first
    // time an older build saves — the cross-version loss the ranges
    // passthrough exists to prevent.
    const sheet: SheetData = {
      ...createEmptySheet(),
      formats: { A1: { bold: true, futureField: 'keep me' } as unknown as CellFormat },
    };

    expect(sanitizeSheetData(sheet).formats?.A1).toEqual({
      bold: true,
      futureField: 'keep me',
    });
  });

  it('keeps a stored dimension exactly as authored', () => {
    // Sanitization runs on every save, so clamping here would rewrite a
    // hand-authored 10px gutter to the editor minimum and destroy it.
    const sheet: SheetData = {
      ...createEmptySheet(),
      columnWidths: { A: 10, B: 999999 },
      rowHeights: { '1': 8 },
    };

    const sanitized = sanitizeSheetData(sheet);
    expect(sanitized.columnWidths).toEqual({ A: 10, B: 999999 });
    expect(sanitized.rowHeights).toEqual({ '1': 8 });
  });

  it('rejects a meaningless stored dimension', () => {
    const sheet: SheetData = {
      ...createEmptySheet(),
      columnWidths: { A: -500, B: 0, C: 180 },
    };

    expect(sanitizeSheetData(sheet).columnWidths).toEqual({ C: 180 });
  });

  it('sanitizeSheetData validates column and row metadata too', () => {
    const sheet: SheetData = {
      ...createEmptySheet(),
      columnFormats: { A: { align: 'right' }, '!!': { bold: true } as CellFormat },
      columnWidths: { A: 100, '3': 50 },
      rowHeights: { '1': 30, ABC: 40 },
    };

    const sanitized = sanitizeSheetData(sheet);
    expect(sanitized.columnFormats).toEqual({ A: { align: 'right' } });
    expect(sanitized.columnWidths).toEqual({ A: 100 });
    expect(sanitized.rowHeights).toEqual({ '1': 30 });
  });

  it('settles a fractional width on the first save, not the second', () => {
    // Guarding the raw value let 0.4 through, which stored as 0 and was only
    // dropped by the NEXT save. A sub-half width is still discarded — but now
    // on the first pass, so two consecutive saves agree.
    const first = sanitizeSheetData({
      ...createEmptySheet(),
      columnWidths: { A: 0.4, B: 30.6 },
    });
    const second = sanitizeSheetData(first);

    expect(first.columnWidths).toEqual({ B: 31 });
    expect(second.columnWidths).toEqual(first.columnWidths);
  });

  it('moveCellMetadata lets a relocated format win a collision', () => {
    // A structural edit maps only the cells that moved. Without explicit
    // handling, a moved A1 -> A5 and a stationary A5 both write key A5 and
    // iteration order decides which format survives.
    let sheet = createEmptySheet();
    sheet = setCellFormats(sheet, ['A1'], { bold: true });
    sheet = setCellFormats(sheet, ['A5'], { italic: true });

    const moved = moveCellMetadata(sheet, new Map([['A1', 'A5']]));

    expect(moved.formats?.A5).toEqual({ bold: true });
    expect(moved.formats?.A1).toBeUndefined();
  });

  it('moveCellMetadata bumps the version like every other mutator', () => {
    let sheet = createEmptySheet();
    sheet = setCellFormats(sheet, ['A1'], { bold: true });
    const before = sheet.version;

    const moved = moveCellMetadata(sheet, new Map([['A1', 'A2']]));
    expect(moved.version).toBe(before + 1);
  });
});

describe('formats and the evaluator', () => {
  it('applies the format to the displayed value', () => {
    let sheet = createEmptySheet();
    sheet.cells.B1 = '1234.5';
    sheet = setCellFormats(sheet, ['B1'], { number: { kind: 'currency', currency: 'USD' } });

    expect(displayOf(sheet, 'B1')).toBe('$1,234.50');
  });

  it('formats a formula result', () => {
    let sheet = createEmptySheet();
    sheet.cells.A1 = '1000';
    sheet.cells.B1 = '=A1*1.5';
    sheet = setCellFormats(sheet, ['B1'], { number: { kind: 'currency', currency: 'USD' } });

    expect(displayOf(sheet, 'B1')).toBe('$1,500.00');
  });

  it('leaves concatenation and comparison operating on raw values', () => {
    // The single most important constraint of formatting in the evaluator: it
    // must rewrite `display` only. If it touched `value`, `="Total: "&A1`
    // would embed a currency symbol and `A1=B1` would compare formatted text.
    let sheet = createEmptySheet();
    sheet.cells.A1 = '1234.5';
    sheet.cells.B1 = '1234.5';
    sheet.cells.C1 = '="Total: "&A1';
    sheet.cells.D1 = '=A1*2';
    sheet.cells.E1 = '=A1=B1';
    sheet = setCellFormats(sheet, ['A1', 'B1'], {
      number: { kind: 'currency', currency: 'USD' },
    });

    expect(displayOf(sheet, 'A1')).toBe('$1,234.50');
    expect(displayOf(sheet, 'C1')).toBe('Total: 1234.5');
    expect(displayOf(sheet, 'D1')).toBe('2469');
    expect(displayOf(sheet, 'E1')).toBe('true');
  });

  it('does not format an error cell', () => {
    let sheet = createEmptySheet();
    sheet.cells.A1 = '=1/0';
    sheet = setCellFormats(sheet, ['A1'], { number: { kind: 'currency' } });

    expect(displayOf(sheet, 'A1')).toBe('#ERROR');
  });

  it('exposes the resolved format on the evaluated cell', () => {
    let sheet = createEmptySheet();
    sheet.cells.A1 = '1';
    sheet = setColumnFormat(sheet, 0, { bold: true });
    sheet = setCellFormats(sheet, ['A1'], { italic: true });

    expect(evaluateSheet(sheet).byAddress.A1?.format).toEqual({ bold: true, italic: true });
  });
});

describe('formats through the persistence round trip', () => {
  it('preserves formats, widths, heights and frozen panes', () => {
    let sheet = createEmptySheet();
    sheet.cells.A1 = 'Revenue';
    sheet.cells.B1 = '1234.5';
    sheet = setCellFormats(sheet, ['A1'], {
      bold: true,
      background: '#fef3c7',
      align: 'center',
      borders: { bottom: { style: 'medium', color: '#111111' } },
    });
    sheet = setCellFormats(sheet, ['B1'], {
      number: { kind: 'currency', currency: 'USD', decimals: 2 },
    });
    sheet = setColumnFormat(sheet, 1, { align: 'right' });
    sheet = setColumnWidth(sheet, 1, 180);
    sheet = setRowHeight(sheet, 0, 32);
    sheet = setFrozen(sheet, 1, 1);

    const restored = parseSheetContent(serializeSheetContent(sheet));

    expect(restored.formats?.A1).toEqual(sheet.formats?.A1);
    expect(restored.formats?.B1).toEqual(sheet.formats?.B1);
    expect(restored.columnFormats?.B).toEqual({ align: 'right' });
    expect(restored.columnWidths).toEqual({ B: 180 });
    expect(restored.rowHeights).toEqual({ '1': 32 });
    expect(restored.frozenRows).toBe(1);
    expect(restored.frozenColumns).toBe(1);
    expect(displayOf(restored, 'B1')).toBe('$1,234.50');
  });

  it('keeps formatting on a cell whose contents were cleared', () => {
    // A blank but coloured cell is a legitimate part of a laid-out sheet, and
    // is the reason formats live beside `cells` rather than inside them.
    let sheet = createEmptySheet();
    sheet = setCellFormats(sheet, ['A1'], { background: '#fef3c7' });

    const restored = parseSheetContent(serializeSheetContent(sheet));
    expect(restored.formats?.A1).toEqual({ background: '#fef3c7' });
    expect(restored.cells.A1).toBeUndefined();
  });

  it('drops a stored format that fails validation', () => {
    const hostile = [
      '#%PAGESPACE_SHEETDOC v1',
      '',
      '[[sheets]]',
      'name = "Sheet1"',
      'order = 0',
      '',
      '[sheets.meta]',
      'row_count = 5',
      'column_count = 5',
      '',
      '[sheets.cells.A1]',
      'value = 1',
      'type = "number"',
      'format = { color = "javascript:alert(1)" }',
      '',
    ].join('\n');

    const restored = parseSheetContent(hostile);
    expect(restored.cells.A1).toBe('1');
    expect(restored.formats?.A1).toBeUndefined();
  });

  it('keeps formats for cells outside the current bounds', () => {
    // A sheet that temporarily shrinks must not lose styling it will need
    // again when it grows back.
    let sheet = createEmptySheet(2, 2);
    sheet = setCellFormats(sheet, ['Z99'], { bold: true });

    expect(sanitizeSheetData(sheet).formats?.Z99).toEqual({ bold: true });
  });

  it('drops formats whose address is not a valid reference', () => {
    const sheet: SheetData = {
      ...createEmptySheet(),
      formats: { 'not-an-address': { bold: true } } as Record<string, CellFormat>,
    };

    expect(sanitizeSheetData(sheet).formats).toBeUndefined();
  });
});
