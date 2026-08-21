import { describe, it, expect } from 'vitest';
import type { SheetData } from '@pagespace/lib/sheets/sheet';
import {
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_ROW_HEIGHT,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  axisOffset,
  axisSize,
  buildAxis,
  buildColumnAxis,
  buildRowAxis,
  cellViewportRect,
  columnWidthAt,
  frozenCount,
  frozenExtent,
  indexAtOffset,
  isCellVisible,
  rowHeightAt,
  scrollOffsetToReveal,
  visibleRange,
  type GridViewportState,
} from '../grid-metrics';

const sheet = (overrides: Partial<SheetData> = {}): SheetData => ({
  version: 2,
  rowCount: 100,
  columnCount: 26,
  cells: {},
  ...overrides,
});

const view = (overrides: Partial<GridViewportState> = {}): GridViewportState => ({
  bodyLeft: 100,
  bodyTop: 50,
  bodyWidth: 400,
  bodyHeight: 300,
  scrollLeft: 0,
  scrollTop: 0,
  ...overrides,
});

describe('buildAxis', () => {
  it('stores a prefix sum with a trailing total', () => {
    const axis = buildAxis(4, () => 10);
    expect(axis.offsets).toEqual([0, 10, 20, 30, 40]);
    expect(axis.total).toBe(40);
    expect(axis.count).toBe(4);
  });

  it('handles variable sizes', () => {
    const axis = buildAxis(3, (i) => [5, 20, 7][i]);
    expect(axis.offsets).toEqual([0, 5, 25, 32]);
  });

  it('produces an empty axis for a zero count', () => {
    const axis = buildAxis(0, () => 10);
    expect(axis).toEqual({ count: 0, offsets: [0], total: 0 });
  });
});

describe('axisSize / axisOffset', () => {
  const axis = buildAxis(3, (i) => [10, 20, 30][i]);

  it('reads sizes and offsets by index', () => {
    expect(axisSize(axis, 1)).toBe(20);
    expect(axisOffset(axis, 2)).toBe(30);
  });

  it('returns zero size outside the axis rather than NaN', () => {
    expect(axisSize(axis, -1)).toBe(0);
    expect(axisSize(axis, 3)).toBe(0);
  });

  it('clamps offsets to the axis ends', () => {
    expect(axisOffset(axis, -5)).toBe(0);
    expect(axisOffset(axis, 99)).toBe(60);
  });
});

describe('indexAtOffset', () => {
  const axis = buildAxis(4, (i) => [10, 50, 10, 30][i]); // starts 0,10,60,70 total 100

  it.each([
    [0, 0],
    [9, 0],
    [10, 1],
    [59, 1],
    [60, 2],
    [70, 3],
    [99, 3],
  ])('resolves offset %i to index %i', (offset, expected) => {
    expect(indexAtOffset(axis, offset)).toBe(expected);
  });

  it('clamps past either end to a real index', () => {
    expect(indexAtOffset(axis, -100)).toBe(0);
    // Past the end resolves to the LAST index, not `count` — a drag beyond the
    // final row must still select a cell that exists.
    expect(indexAtOffset(axis, 5_000)).toBe(3);
  });

  it('returns 0 for an empty axis instead of -1', () => {
    expect(indexAtOffset(buildAxis(0, () => 10), 42)).toBe(0);
  });
});

describe('stored sizes', () => {
  it('falls back to the defaults when nothing is stored', () => {
    expect(columnWidthAt(sheet(), 0)).toBe(DEFAULT_COLUMN_WIDTH);
    expect(rowHeightAt(sheet(), 0)).toBe(DEFAULT_ROW_HEIGHT);
  });

  it('reads column widths by letter and row heights by 1-based number', () => {
    const s = sheet({ columnWidths: { C: 200 }, rowHeights: { '3': 60 } });
    expect(columnWidthAt(s, 2)).toBe(200);
    expect(rowHeightAt(s, 2)).toBe(60);
    // Neighbours are untouched.
    expect(columnWidthAt(s, 1)).toBe(DEFAULT_COLUMN_WIDTH);
    expect(rowHeightAt(s, 1)).toBe(DEFAULT_ROW_HEIGHT);
  });

  it('clamps an absurd stored size at read time', () => {
    expect(columnWidthAt(sheet({ columnWidths: { A: 99_999 } }), 0)).toBe(MAX_COLUMN_WIDTH);
    expect(columnWidthAt(sheet({ columnWidths: { A: 1 } }), 0)).toBe(MIN_COLUMN_WIDTH);
  });

  it('ignores a non-finite stored size rather than producing a NaN layout', () => {
    expect(columnWidthAt(sheet({ columnWidths: { A: Number.NaN } }), 0)).toBe(DEFAULT_COLUMN_WIDTH);
  });

  it('uses the density base height only where no explicit height is stored', () => {
    const s = sheet({ rowHeights: { '1': 60 } });
    expect(rowHeightAt(s, 0, 26)).toBe(60);
    expect(rowHeightAt(s, 1, 26)).toBe(26);
  });
});

describe('frozen bands', () => {
  it('never freezes the entire axis', () => {
    expect(frozenCount(10, 3)).toBe(2);
    expect(frozenCount(1, 1)).toBe(0);
  });

  it('treats missing or nonsense values as unfrozen', () => {
    expect(frozenCount(undefined, 10)).toBe(0);
    expect(frozenCount(Number.NaN, 10)).toBe(0);
    expect(frozenCount(-3, 10)).toBe(0);
  });

  it('measures the pinned band in pixels', () => {
    const axis = buildAxis(5, () => 20);
    expect(frozenExtent(axis, 2)).toBe(40);
    expect(frozenExtent(axis, 0)).toBe(0);
  });
});

describe('cellViewportRect', () => {
  const columnAxis = buildColumnAxis(sheet());
  const rowAxis = buildRowAxis(sheet());

  it('offsets an unscrolled cell from the body origin', () => {
    const rect = cellViewportRect({ rowAxis, columnAxis, row: 1, column: 2, view: view() });
    expect(rect).toEqual({
      left: 100 + 2 * DEFAULT_COLUMN_WIDTH,
      top: 50 + 1 * DEFAULT_ROW_HEIGHT,
      width: DEFAULT_COLUMN_WIDTH,
      height: DEFAULT_ROW_HEIGHT,
    });
  });

  it('subtracts the scroll offset for a scrolling cell', () => {
    const rect = cellViewportRect({
      rowAxis,
      columnAxis,
      row: 10,
      column: 5,
      view: view({ scrollLeft: 130, scrollTop: 70 }),
    });
    expect(rect.left).toBe(100 + 5 * DEFAULT_COLUMN_WIDTH - 130);
    expect(rect.top).toBe(50 + 10 * DEFAULT_ROW_HEIGHT - 70);
  });

  it('pins a frozen cell so it ignores scroll', () => {
    const scrolled = view({ scrollLeft: 500, scrollTop: 400 });
    const rect = cellViewportRect({
      rowAxis,
      columnAxis,
      row: 0,
      column: 0,
      frozenRows: 1,
      frozenColumns: 1,
      view: scrolled,
    });
    expect(rect.left).toBe(100);
    expect(rect.top).toBe(50);
  });

  it('locates a cell scrolled far out of view, where a DOM lookup would find nothing', () => {
    // This is the whole reason the module exists: the editor anchor must still
    // resolve for a cell with no rendered element.
    const rect = cellViewportRect({
      rowAxis,
      columnAxis,
      row: 90,
      column: 0,
      view: view({ scrollTop: 0 }),
    });
    expect(rect.top).toBe(50 + 90 * DEFAULT_ROW_HEIGHT);
    expect(Number.isFinite(rect.top)).toBe(true);
  });
});

describe('isCellVisible', () => {
  const columnAxis = buildColumnAxis(sheet());
  const rowAxis = buildRowAxis(sheet());

  it('is true for a cell inside the body', () => {
    expect(isCellVisible({ rowAxis, columnAxis, row: 0, column: 0, view: view() })).toBe(true);
  });

  it('is false for a cell scrolled past the bottom', () => {
    expect(isCellVisible({ rowAxis, columnAxis, row: 90, column: 0, view: view() })).toBe(false);
  });

  it('is false for a cell hidden underneath the frozen band', () => {
    // Row 1 sits at y=32; scrolling by 40 puts it at -8, i.e. behind the frozen
    // first row that paints over it. Reporting it visible would draw the editor
    // underneath the pinned band.
    const scrolled = view({ scrollTop: 40 });
    expect(
      isCellVisible({ rowAxis, columnAxis, row: 1, column: 0, frozenRows: 1, view: scrolled }),
    ).toBe(false);
  });

  it('is true for the frozen row itself at the same scroll offset', () => {
    const scrolled = view({ scrollTop: 40 });
    expect(
      isCellVisible({ rowAxis, columnAxis, row: 0, column: 0, frozenRows: 1, view: scrolled }),
    ).toBe(true);
  });
});

describe('scrollOffsetToReveal', () => {
  const axis = buildAxis(100, () => 20); // total 2000

  it('leaves the offset alone when the index is already visible', () => {
    expect(scrollOffsetToReveal(axis, 5, 0, 300)).toBe(0);
  });

  it('scrolls the minimum distance downward', () => {
    // Index 20 ends at 420; a 300px window must end there, not centre it.
    expect(scrollOffsetToReveal(axis, 20, 0, 300)).toBe(120);
  });

  it('scrolls the minimum distance upward', () => {
    expect(scrollOffsetToReveal(axis, 5, 500, 300)).toBe(100);
  });

  it('never returns a negative offset', () => {
    expect(scrollOffsetToReveal(axis, 0, 500, 300)).toBe(0);
  });

  it('keeps the revealed cell clear of the frozen band', () => {
    // With two frozen rows (40px), aligning index 10 to the raw top would hide
    // it behind the band; the offset must back off by the band's height.
    expect(scrollOffsetToReveal(axis, 10, 500, 300, 2)).toBe(200 - 40);
  });

  it('does not scroll for an index inside the frozen band', () => {
    expect(scrollOffsetToReveal(axis, 1, 500, 300, 2)).toBe(500);
  });
});

describe('visibleRange', () => {
  const axis = buildAxis(100, () => 20);

  it('covers the window inclusively', () => {
    expect(visibleRange(axis, 0, 100)).toEqual({ start: 0, end: 5 });
  });

  it('applies overscan without leaving the axis', () => {
    expect(visibleRange(axis, 0, 100, 3)).toEqual({ start: 0, end: 8 });
    expect(visibleRange(axis, 1980, 100, 3)).toEqual({ start: 96, end: 99 });
  });

  it('returns an empty range for an empty axis', () => {
    expect(visibleRange(buildAxis(0, () => 20), 0, 100)).toEqual({ start: 0, end: -1 });
  });
});
