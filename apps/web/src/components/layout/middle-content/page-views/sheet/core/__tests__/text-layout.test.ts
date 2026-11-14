import { describe, it, expect } from 'vitest';
import type {
  CellFormat,
  SheetData,
  SheetEvaluationCell,
  SheetSparseEvaluation,
} from '@pagespace/lib/sheets/sheet';
import { buildColumnAxis, type AxisGeometry } from '../grid-metrics';
import {
  CELL_HORIZONTAL_PADDING,
  CELL_VERTICAL_PADDING,
  cellFont,
  computeAutoRowHeights,
  countWrappedLines,
  spillExtent,
  spillSourceLeftOf,
  wrappedCellHeight,
  type MeasureText,
} from '../text-layout';

/** 7px per character, whatever the font. */
const measure: MeasureText = (text) => text.length * 7;

const sheet = (overrides: Partial<SheetData> = {}): SheetData => ({
  version: 2,
  rowCount: 50,
  columnCount: 10,
  cells: {},
  ...overrides,
});

const cell = (
  address: string,
  display: string,
  extra: Partial<SheetEvaluationCell> = {},
): SheetEvaluationCell => ({
  address,
  raw: display,
  value: display,
  display,
  type: 'string',
  dependsOn: [],
  dependents: [],
  ...extra,
});

const evaluationOf = (...cells: SheetEvaluationCell[]): SheetSparseEvaluation => ({
  byAddress: Object.fromEntries(cells.map((entry) => [entry.address, entry])),
  dependencies: {},
});

describe('cellFont', () => {
  it('defaults to 14px regular in the given family', () => {
    expect(cellFont(undefined, 'Inter')).toBe('normal 400 14px Inter');
  });

  it('carries bold, italic, size and mono', () => {
    const format: CellFormat = { bold: true, italic: true, fontSize: 18, fontFamily: 'mono' };
    expect(cellFont(format, 'Inter', 'Menlo')).toBe('italic 600 18px Menlo');
  });
});

describe('countWrappedLines', () => {
  it('is one line for empty text', () => {
    expect(countWrappedLines('', 100, 'f', measure)).toBe(1);
  });

  it('is one line when the text fits', () => {
    expect(countWrappedLines('hello', 100, 'f', measure)).toBe(1);
  });

  it('wraps by word', () => {
    // 10 chars per line at 70px.
    expect(countWrappedLines('aaaa bbbb cccc dddd', 70, 'f', measure)).toBe(2);
  });

  it('honours explicit newlines, including blank lines', () => {
    expect(countWrappedLines('a\n\nb', 100, 'f', measure)).toBe(3);
  });

  it('breaks a word longer than the line by character', () => {
    // 25 chars, 10 per line.
    expect(countWrappedLines('a'.repeat(25), 70, 'f', measure)).toBe(3);
  });

  it('treats a non-positive width as one character per line rather than looping', () => {
    expect(countWrappedLines('abc', 0, 'f', measure)).toBe(3);
  });
});

describe('wrappedCellHeight', () => {
  it('is line-height times lines plus vertical padding', () => {
    expect(wrappedCellHeight(2, 14)).toBe(Math.ceil(2 * 14 * 1.25 + CELL_VERTICAL_PADDING));
  });
});

describe('computeAutoRowHeights', () => {
  const columns = (data: SheetData): AxisGeometry => buildColumnAxis(data);
  const long = 'word '.repeat(60).trim();

  it('grows a row holding a wrapped cell', () => {
    const data = sheet();
    const evaluation = evaluationOf(cell('A1', long, { format: { wrap: true } }));
    const heights = computeAutoRowHeights(data, evaluation, columns(data), 32, 'f', measure);
    expect(heights.get(0)).toBeGreaterThan(32);
  });

  it('ignores unwrapped cells', () => {
    const data = sheet();
    const evaluation = evaluationOf(cell('A1', long));
    expect(computeAutoRowHeights(data, evaluation, columns(data), 32, 'f', measure).size).toBe(0);
  });

  it('never shrinks below the base height', () => {
    const data = sheet();
    const evaluation = evaluationOf(cell('A1', 'hi', { format: { wrap: true } }));
    expect(computeAutoRowHeights(data, evaluation, columns(data), 32, 'f', measure).has(0)).toBe(false);
  });

  it('leaves a row with a stored height alone', () => {
    const data = sheet({ rowHeights: { '1': 40 } });
    const evaluation = evaluationOf(cell('A1', long, { format: { wrap: true } }));
    expect(computeAutoRowHeights(data, evaluation, columns(data), 32, 'f', measure).has(0)).toBe(false);
  });

  it('takes the tallest wrapped cell in the row', () => {
    const data = sheet();
    const short = 'word '.repeat(30).trim();
    const tall = computeAutoRowHeights(
      data,
      evaluationOf(cell('A1', long, { format: { wrap: true } })),
      columns(data),
      32,
      'f',
      measure,
    ).get(0);
    const both = computeAutoRowHeights(
      data,
      evaluationOf(
        cell('A1', short, { format: { wrap: true } }),
        cell('B1', long, { format: { wrap: true } }),
      ),
      columns(data),
      32,
      'f',
      measure,
    ).get(0);
    expect(both).toBe(tall);
  });

  it('clamps to the maximum row height', () => {
    const data = sheet();
    const huge = 'x\n'.repeat(2000);
    const evaluation = evaluationOf(cell('A1', huge, { format: { wrap: true } }));
    expect(computeAutoRowHeights(data, evaluation, columns(data), 32, 'f', measure).get(0)).toBe(1000);
  });

  it('skips errors and off-grid addresses', () => {
    const data = sheet({ rowCount: 2 });
    const evaluation = evaluationOf(
      cell('A1', long, { format: { wrap: true }, error: 'boom' }),
      cell('A9', long, { format: { wrap: true } }),
    );
    expect(computeAutoRowHeights(data, evaluation, columns(data), 32, 'f', measure).size).toBe(0);
  });
});

describe('spillExtent', () => {
  const data = sheet();
  const axis = buildColumnAxis(data); // 112px columns
  // 40 chars = 280px of text; needs 280 + padding.
  const text = 'x'.repeat(40);
  const base = { columnAxis: axis, frozenColumns: 0, fontFamily: 'f', measure };

  it('spills across empty neighbours until the text fits', () => {
    const evaluation = evaluationOf(cell('A1', text));
    const extra = spillExtent({ ...base, evaluation, row: 0, column: 0 });
    // Needs 280 + padding = 296 > 112; A+B = 224, A+B+C = 336.
    expect(extra).toBe(224);
    expect(112 + extra).toBeGreaterThanOrEqual(280 + CELL_HORIZONTAL_PADDING);
  });

  it('stops at the first non-empty neighbour', () => {
    const evaluation = evaluationOf(cell('A1', text), cell('C1', 'z'));
    expect(spillExtent({ ...base, evaluation, row: 0, column: 0 })).toBe(112);
  });

  it('treats the editing cell as occupied', () => {
    const evaluation = evaluationOf(cell('A1', text));
    expect(
      spillExtent({ ...base, evaluation, row: 0, column: 0, isOccupied: (_r, c) => c === 1 }),
    ).toBe(0);
  });

  it('does not spill text that fits', () => {
    expect(spillExtent({ ...base, evaluation: evaluationOf(cell('A1', 'short')), row: 0, column: 0 })).toBe(0);
  });

  it('does not spill numbers, errors, wrapped or non-left-aligned text', () => {
    const cases = [
      cell('A1', text, { type: 'number' }),
      cell('A1', text, { error: 'bad' }),
      cell('A1', text, { format: { wrap: true } }),
      cell('A1', text, { format: { align: 'center' } }),
      cell('A1', text, { format: { align: 'right' } }),
    ];
    for (const entry of cases) {
      expect(spillExtent({ ...base, evaluation: evaluationOf(entry), row: 0, column: 0 })).toBe(0);
    }
  });

  it('spills when explicitly left-aligned', () => {
    const evaluation = evaluationOf(cell('A1', text, { format: { align: 'left' } }));
    expect(spillExtent({ ...base, evaluation, row: 0, column: 0 })).toBe(224);
  });

  it('does not cross from a frozen column into the scrolling body', () => {
    const evaluation = evaluationOf(cell('A1', text));
    expect(spillExtent({ ...base, frozenColumns: 1, evaluation, row: 0, column: 0 })).toBe(0);
    expect(spillExtent({ ...base, frozenColumns: 2, evaluation, row: 0, column: 0 })).toBe(112);
  });

  it('stops at the last column', () => {
    const narrow = sheet({ columnCount: 2 });
    const evaluation = evaluationOf(cell('A1', text));
    expect(
      spillExtent({ ...base, columnAxis: buildColumnAxis(narrow), evaluation, row: 0, column: 0 }),
    ).toBe(112);
  });
});

describe('spillSourceLeftOf', () => {
  const axis = buildColumnAxis(sheet());
  const base = { columnAxis: axis, frozenColumns: 0, fontFamily: 'f', measure };

  it('finds an off-screen cell whose text spills into view', () => {
    const evaluation = evaluationOf(cell('A1', 'x'.repeat(40)));
    expect(spillSourceLeftOf({ ...base, evaluation, row: 0, columnStart: 2 })).toBe(0);
  });

  it('returns null when the nearest non-empty cell does not reach', () => {
    const evaluation = evaluationOf(cell('A1', 'x'.repeat(20)));
    expect(spillSourceLeftOf({ ...base, evaluation, row: 0, columnStart: 3 })).toBeNull();
  });

  it('returns null when the cell just left of the window is occupied', () => {
    const evaluation = evaluationOf(cell('A1', 'x'.repeat(40)), cell('B1', 'y'));
    expect(spillSourceLeftOf({ ...base, evaluation, row: 0, columnStart: 2 })).toBeNull();
  });

  it('does not look into frozen columns', () => {
    const evaluation = evaluationOf(cell('A1', 'x'.repeat(40)));
    expect(spillSourceLeftOf({ ...base, frozenColumns: 1, evaluation, row: 0, columnStart: 2 })).toBeNull();
  });

  it('returns null at the left edge', () => {
    expect(spillSourceLeftOf({ ...base, evaluation: evaluationOf(), row: 0, columnStart: 0 })).toBeNull();
  });
});
