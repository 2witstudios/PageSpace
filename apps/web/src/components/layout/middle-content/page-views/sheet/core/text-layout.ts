/**
 * Pure text geometry for cells: how tall a wrapped cell needs to be, and how
 * far an unwrapped one may spill into its empty neighbours.
 *
 * Measuring text is the one thing that needs the browser, so it is injected as
 * `MeasureText`; everything else here is arithmetic over the sheet, which keeps
 * it testable and lets it run for cells virtualization never rendered (a row's
 * height has to be known before the row is on screen, or the axis would jump
 * as the user scrolls).
 */

import {
  decodeCellAddress,
  encodeCellAddress,
  type CellFormat,
  type SheetData,
  type SheetEvaluationCell,
  type SheetSparseEvaluation,
} from '@pagespace/lib/sheets/sheet';
import { MAX_ROW_HEIGHT, axisOffset, axisSize, type AxisGeometry } from './grid-metrics';

/** Width in px of `text` drawn in the CSS `font` shorthand. */
export type MeasureText = (text: string, font: string) => number;

/** `px-2` on both sides plus the cell's 1px right hairline. */
export const CELL_HORIZONTAL_PADDING = 17;
/** Breathing room above and below a wrapped block. */
export const CELL_VERTICAL_PADDING = 8;
/** `text-sm`. */
export const DEFAULT_CELL_FONT_SIZE = 14;
/** `leading-tight`. */
const LINE_HEIGHT_RATIO = 1.25;
/**
 * How many columns a spill may cross. Far more than any readable spill, and it
 * bounds the per-cell work so a sparse sheet with one long string cannot make
 * every render walk the whole row.
 */
const MAX_SPILL_COLUMNS = 50;

/**
 * Whether a cell renders as a number: right-aligned with tabular mono figures,
 * unless its format sets an alignment. The grid and the measurer both use
 * this, so a wrapped number is measured in the face it is drawn in.
 */
export const rendersAsNumber = (
  type: SheetEvaluationCell['type'] | undefined,
  format: CellFormat | undefined,
): boolean => type === 'number' && !format?.align;

/**
 * The canvas font a cell is drawn in. An explicit `fontFamily` wins (it is an
 * inline style, which beats the cell's `font-mono` class); otherwise numbers
 * are mono and everything else is sans.
 */
export const cellFont = (
  format: CellFormat | undefined,
  sansFamily: string,
  monoFamily: string = sansFamily,
  isNumber: boolean = false,
): string => {
  const style = format?.italic ? 'italic' : 'normal';
  const weight = format?.bold ? 600 : 400;
  const size = format?.fontSize ?? DEFAULT_CELL_FONT_SIZE;
  const isMono = format?.fontFamily ? format.fontFamily === 'mono' : isNumber;
  return `${style} ${weight} ${size}px ${isMono ? monoFamily : sansFamily}`;
};

/**
 * A paragraph as the units a line may break between: words split on spaces,
 * and each word further split after its hyphens, which CSS also treats as a
 * break opportunity. `joiner` is what precedes a unit when it shares a line
 * with the previous one. Empty units stand for runs of spaces, which
 * `pre-wrap` keeps.
 */
const breakUnits = (paragraph: string): Array<{ text: string; joiner: string }> =>
  paragraph.split(' ').flatMap((word, wordIndex) =>
    word.split(/(?<=-)/).map((text, segmentIndex) => ({
      text,
      joiner: segmentIndex > 0 ? '' : wordIndex > 0 ? ' ' : '',
    })),
  );

/**
 * Lines `text` occupies at `maxWidth`, matching the cell's CSS: `pre-wrap`
 * keeps explicit newlines and `overflow-wrap: anywhere` breaks a word that is
 * wider than the line.
 */
export const countWrappedLines = (
  text: string,
  maxWidth: number,
  font: string,
  measure: MeasureText,
): number => {
  let lines = 0;
  for (const paragraph of text.split('\n')) {
    // `started` rather than `current !== ''`: leading spaces are content
    // under `pre-wrap`, so a line that so far holds only them has begun.
    let current = '';
    let started = false;
    for (const { text: unit, joiner } of breakUnits(paragraph)) {
      const candidate = started ? current + joiner + unit : unit;
      if (measure(candidate, font) <= maxWidth) {
        current = candidate;
        started = true;
        continue;
      }
      // A space that does not fit hangs past the line end, as in CSS,
      // rather than forcing a break of its own.
      if (unit === '') continue;
      if (current !== '') lines++;
      if (measure(unit, font) <= maxWidth) {
        current = unit;
        started = true;
        continue;
      }
      // A unit wider than the line breaks by character; at least one
      // character always goes on a line, so a zero width cannot loop.
      let chunk = '';
      for (const character of unit) {
        if (chunk && measure(chunk + character, font) > maxWidth) {
          lines++;
          chunk = character;
        } else {
          chunk += character;
        }
      }
      current = chunk;
      started = true;
    }
    lines++;
  }
  return lines;
};

export const wrappedCellHeight = (lines: number, fontSize: number = DEFAULT_CELL_FONT_SIZE): number =>
  Math.ceil(lines * fontSize * LINE_HEIGHT_RATIO + CELL_VERTICAL_PADDING);

const decodeSafely = (address: string): { row: number; column: number } | null => {
  try {
    return decodeCellAddress(address);
  } catch {
    return null;
  }
};

const hasStoredRowHeight = (sheet: Pick<SheetData, 'rowHeights'>, row: number): boolean =>
  typeof sheet.rowHeights?.[String(row + 1)] === 'number';

/**
 * Heights for rows whose wrapped content is taller than `baseHeight`.
 *
 * Only rows that need to grow are returned. A row the user sized by hand is
 * skipped, so dragging a row shorter clips its text instead of being undone by
 * the next render.
 */
export const computeAutoRowHeights = (
  sheet: Pick<SheetData, 'rowCount' | 'columnCount' | 'rowHeights'>,
  evaluation: SheetSparseEvaluation,
  columnAxis: AxisGeometry,
  baseHeight: number,
  fontFamily: string,
  measure: MeasureText,
  monoFamily?: string,
): Map<number, number> => {
  const heights = new Map<number, number>();

  for (const [address, cell] of Object.entries(evaluation.byAddress)) {
    if (!cell.format?.wrap || cell.error || !cell.display) continue;
    const position = decodeSafely(address);
    if (!position) continue;
    const { row, column } = position;
    if (row < 0 || row >= sheet.rowCount || column < 0 || column >= sheet.columnCount) continue;
    if (hasStoredRowHeight(sheet, row)) continue;

    const contentWidth = axisSize(columnAxis, column) - CELL_HORIZONTAL_PADDING;
    const font = cellFont(cell.format, fontFamily, monoFamily, rendersAsNumber(cell.type, cell.format));
    const lines = countWrappedLines(cell.display, contentWidth, font, measure);
    const height = Math.min(
      MAX_ROW_HEIGHT,
      wrappedCellHeight(lines, cell.format.fontSize ?? DEFAULT_CELL_FONT_SIZE),
    );
    if (height > baseHeight && height > (heights.get(row) ?? 0)) heights.set(row, height);
  }

  return heights;
};

interface SpillContext {
  evaluation: SheetSparseEvaluation;
  columnAxis: AxisGeometry;
  frozenColumns: number;
  fontFamily: string;
  monoFamily?: string;
  measure: MeasureText;
  /** Extra occupancy the evaluation does not know about, e.g. the cell being edited. */
  isOccupied?: (row: number, column: number) => boolean;
}

const cellAt = (
  evaluation: SheetSparseEvaluation,
  row: number,
  column: number,
): SheetEvaluationCell | undefined => evaluation.byAddress[encodeCellAddress(row, column)];

const isEmptyAt = (context: SpillContext, row: number, column: number): boolean => {
  if (context.isOccupied?.(row, column)) return false;
  const cell = cellAt(context.evaluation, row, column);
  // Judged on what is stored, not what is shown: a formula that evaluates to
  // "" still occupies its cell and must stop a spill.
  return !cell || (!cell.error && cell.raw.trim() === '');
};

const canSpill = (cell: SheetEvaluationCell | undefined): cell is SheetEvaluationCell =>
  !!cell &&
  !!cell.display &&
  !cell.error &&
  cell.type !== 'number' &&
  !cell.format?.wrap &&
  (!cell.format?.align || cell.format.align === 'left');

/**
 * Extra px an unwrapped text cell may paint into its empty right-hand
 * neighbours: enough to fit the text, stopping at the first occupied cell, the
 * last column, or the frozen edge (the frozen pane clips there anyway, so
 * spilling past it would only hide text under the scrolling body).
 */
export const spillExtent = (context: SpillContext & { row: number; column: number }): number => {
  const { evaluation, columnAxis, frozenColumns, row, column } = context;
  const cell = cellAt(evaluation, row, column);
  if (!canSpill(cell)) return 0;

  const width = axisSize(columnAxis, column);
  // `canSpill` has already excluded numbers, so this is always the text face.
  const font = cellFont(cell.format, context.fontFamily, context.monoFamily);
  const needed = context.measure(cell.display, font) + CELL_HORIZONTAL_PADDING;
  if (needed <= width) return 0;

  const limit = Math.min(
    columnAxis.count,
    column < frozenColumns ? frozenColumns : columnAxis.count,
    column + 1 + MAX_SPILL_COLUMNS,
  );
  let extra = 0;
  for (let next = column + 1; next < limit; next++) {
    if (!isEmptyAt(context, row, next)) break;
    extra += axisSize(columnAxis, next);
    if (width + extra >= needed) break;
  }
  return extra;
};

/**
 * The nearest cell left of `columnStart` whose spill reaches into it, or null.
 *
 * Virtualization only renders the visible columns, so without this a spill
 * would vanish the moment its source column scrolled off the left edge.
 */
export const spillSourceLeftOf = (
  context: SpillContext & { row: number; columnStart: number },
): number | null => {
  const { columnAxis, frozenColumns, row, columnStart } = context;
  const floor = Math.max(frozenColumns, columnStart - MAX_SPILL_COLUMNS);

  for (let column = columnStart - 1; column >= floor; column--) {
    if (isEmptyAt(context, row, column)) continue;
    const extent = spillExtent({ ...context, row, column });
    const reach = axisOffset(columnAxis, column) + axisSize(columnAxis, column) + extent;
    return reach > axisOffset(columnAxis, columnStart) ? column : null;
  }
  return null;
};
