import { describe, it, expect } from 'vitest';
import { createEmptySheet, setColumnFormat, type SheetData } from '@pagespace/lib/sheets/sheet';
import {
  activeFormat,
  applyFormatCommand,
  inferDecimals,
  selectionAddresses,
} from '../format-commands';
import type { SelectionState } from '../selection';

const single = (row: number, column: number): SelectionState => ({
  type: 'single',
  cell: { row, column },
});

const range = (
  start: [number, number],
  end: [number, number],
): SelectionState => ({
  type: 'range',
  range: {
    start: { row: start[0], column: start[1] },
    end: { row: end[0], column: end[1] },
  },
});

const base = (): SheetData => createEmptySheet();

describe('selectionAddresses', () => {
  it('covers a single cell', () => {
    expect(selectionAddresses(single(0, 0))).toEqual(['A1']);
  });

  it('covers a rectangle row-major', () => {
    expect(selectionAddresses(range([0, 0], [1, 1]))).toEqual(['A1', 'B1', 'A2', 'B2']);
  });

  it('normalises a range dragged up-and-left', () => {
    expect(selectionAddresses(range([1, 1], [0, 0]))).toEqual(['A1', 'B1', 'A2', 'B2']);
  });
});

describe('toggle commands', () => {
  it('turns a field on across the whole selection', () => {
    const next = applyFormatCommand(base(), range([0, 0], [1, 1]), { kind: 'toggle', field: 'bold' });
    expect(next.formats?.A1?.bold).toBe(true);
    expect(next.formats?.B2?.bold).toBe(true);
  });

  it('turns the whole selection off when the anchor is already on', () => {
    let sheet = applyFormatCommand(base(), range([0, 0], [1, 1]), { kind: 'toggle', field: 'bold' });
    sheet = applyFormatCommand(sheet, range([0, 0], [1, 1]), { kind: 'toggle', field: 'bold' });
    expect(sheet.formats?.A1?.bold).toBeUndefined();
    expect(sheet.formats?.B2?.bold).toBeUndefined();
  });

  it('follows the anchor rather than each cell, so a mixed selection becomes uniform', () => {
    // A1 bold, B1 not. Toggling the pair must make BOTH non-bold (anchor is on),
    // not flip each cell independently and leave the range still mixed.
    let sheet = applyFormatCommand(base(), single(0, 0), { kind: 'toggle', field: 'bold' });
    sheet = applyFormatCommand(sheet, range([0, 0], [0, 1]), { kind: 'toggle', field: 'bold' });
    expect(sheet.formats?.A1?.bold).toBeUndefined();
    expect(sheet.formats?.B1?.bold).toBeUndefined();
  });

  it('clears the field instead of storing false, leaving no husk behind', () => {
    let sheet = applyFormatCommand(base(), single(0, 0), { kind: 'toggle', field: 'italic' });
    sheet = applyFormatCommand(sheet, single(0, 0), { kind: 'toggle', field: 'italic' });
    expect(sheet.formats?.A1).toBeUndefined();
  });

  it('leaves the cell value alone', () => {
    const sheet = base();
    sheet.cells.A1 = '=SUM(B1:B9)';
    const next = applyFormatCommand(sheet, single(0, 0), { kind: 'toggle', field: 'bold' });
    expect(next.cells.A1).toBe('=SUM(B1:B9)');
  });

  it('preserves sibling formatting when toggling one field', () => {
    let sheet = applyFormatCommand(base(), single(0, 0), { kind: 'color', value: '#ff0000' });
    sheet = applyFormatCommand(sheet, single(0, 0), { kind: 'toggle', field: 'bold' });
    expect(sheet.formats?.A1).toEqual({ color: '#ff0000', bold: true });
  });
});

describe('activeFormat', () => {
  it('reports the anchor cell of a range, not its end', () => {
    let sheet = applyFormatCommand(base(), single(0, 0), { kind: 'toggle', field: 'bold' });
    sheet = applyFormatCommand(sheet, single(1, 1), { kind: 'toggle', field: 'italic' });
    expect(activeFormat(sheet, range([0, 0], [1, 1]))).toMatchObject({ bold: true });
  });

  it('folds in the column default so the toolbar reflects what is rendered', () => {
    const sheet = setColumnFormat(base(), 0, { align: 'right' });
    expect(activeFormat(sheet, single(5, 0)).align).toBe('right');
  });

  it('is an empty object for an unformatted cell rather than undefined', () => {
    expect(activeFormat(base(), single(3, 3))).toEqual({});
  });
});

describe('number formats', () => {
  it('sets a kind', () => {
    const next = applyFormatCommand(base(), single(0, 0), { kind: 'numberKind', value: 'percent' });
    expect(next.formats?.A1?.number).toEqual({ kind: 'percent' });
  });

  it('defaults currency to USD', () => {
    const next = applyFormatCommand(base(), single(0, 0), { kind: 'numberKind', value: 'currency' });
    expect(next.formats?.A1?.number?.currency).toBe('USD');
  });

  it('carries decimals across a kind change that still has a fractional part', () => {
    let sheet = applyFormatCommand(base(), single(0, 0), { kind: 'numberKind', value: 'number' });
    sheet = applyFormatCommand(sheet, single(0, 0), { kind: 'decimals', delta: 3 });
    sheet = applyFormatCommand(sheet, single(0, 0), { kind: 'numberKind', value: 'currency' });
    expect(sheet.formats?.A1?.number?.decimals).toBe(3);
  });

  it('drops a currency code when switching to a kind that has no currency', () => {
    let sheet = applyFormatCommand(base(), single(0, 0), { kind: 'numberKind', value: 'currency' });
    sheet = applyFormatCommand(sheet, single(0, 0), { kind: 'numberKind', value: 'percent' });
    expect(sheet.formats?.A1?.number?.currency).toBeUndefined();
  });

  it('clears the number format entirely for `auto`', () => {
    let sheet = applyFormatCommand(base(), single(0, 0), { kind: 'numberKind', value: 'currency' });
    sheet = applyFormatCommand(sheet, single(0, 0), { kind: 'numberKind', value: 'auto' });
    expect(sheet.formats?.A1?.number).toBeUndefined();
  });
});

describe('decimals', () => {
  it('starts from the decimals the value already shows', () => {
    const sheet = base();
    sheet.cells.A1 = '1.25';
    const next = applyFormatCommand(sheet, single(0, 0), { kind: 'decimals', delta: 1 });
    expect(next.formats?.A1?.number?.decimals).toBe(3);
  });

  it('adopts a number format so the setting is actually visible', () => {
    const next = applyFormatCommand(base(), single(0, 0), { kind: 'decimals', delta: 2 });
    expect(next.formats?.A1?.number).toEqual({ kind: 'number', decimals: 2 });
  });

  it('keeps the existing kind when nudging', () => {
    let sheet = applyFormatCommand(base(), single(0, 0), { kind: 'numberKind', value: 'currency' });
    sheet = applyFormatCommand(sheet, single(0, 0), { kind: 'decimals', delta: 1 });
    expect(sheet.formats?.A1?.number?.kind).toBe('currency');
  });

  it('clamps at zero and returns the sheet unchanged when already there', () => {
    const sheet = applyFormatCommand(base(), single(0, 0), { kind: 'decimals', delta: -1 });
    // 0 - 1 clamps to 0, which differs from `undefined`, so the first press does
    // pin the format at 0 decimals.
    expect(sheet.formats?.A1?.number?.decimals).toBe(0);
    expect(applyFormatCommand(sheet, single(0, 0), { kind: 'decimals', delta: -1 })).toBe(sheet);
  });

  it('clamps at the schema maximum', () => {
    const next = applyFormatCommand(base(), single(0, 0), { kind: 'decimals', delta: 99 });
    expect(next.formats?.A1?.number?.decimals).toBe(10);
  });
});

describe('inferDecimals', () => {
  it.each([
    ['1.25', 2],
    ['-0.5', 1],
    ['42', 0],
    ['', 0],
    [undefined, 0],
    ['=SUM(A1:A2)', 0],
    ['1.23456789012345', 10],
  ])('reads %j as %i', (raw, expected) => {
    expect(inferDecimals(raw as string | undefined)).toBe(expected);
  });
});

describe('font size', () => {
  it('clamps into the schema range instead of storing something that gets dropped', () => {
    expect(
      applyFormatCommand(base(), single(0, 0), { kind: 'fontSize', value: 1000 }).formats?.A1
        ?.fontSize,
    ).toBe(96);
    expect(
      applyFormatCommand(base(), single(0, 0), { kind: 'fontSize', value: 1 }).formats?.A1?.fontSize,
    ).toBe(6);
  });

  it('clears with undefined', () => {
    let sheet = applyFormatCommand(base(), single(0, 0), { kind: 'fontSize', value: 24 });
    sheet = applyFormatCommand(sheet, single(0, 0), { kind: 'fontSize', value: undefined });
    expect(sheet.formats?.A1).toBeUndefined();
  });
});

describe('clear', () => {
  it('removes formatting but keeps values', () => {
    let sheet = base();
    sheet.cells.A1 = 'Revenue';
    sheet = applyFormatCommand(sheet, single(0, 0), { kind: 'toggle', field: 'bold' });
    sheet = applyFormatCommand(sheet, single(0, 0), { kind: 'clear' });
    expect(sheet.formats?.A1).toBeUndefined();
    expect(sheet.cells.A1).toBe('Revenue');
  });
});
