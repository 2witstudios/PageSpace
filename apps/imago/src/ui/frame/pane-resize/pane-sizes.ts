/**
 * The widths the viewer dragged the docked columns to, as in classic's resizable panels:
 * one for the left pane (every section shares it) and one for Imago docked beside a page.
 * `null` is the theme's token width, so the server render and the hydrating pass agree.
 */
export type PaneSizes = { readonly left: number | null; readonly imago: number | null };

export type ResizableColumn = keyof PaneSizes;

export const NO_SIZES: PaneSizes = { left: null, imago: null };

export const PANE_SIZES_KEY = 'imago:pane-sizes';

/** Each column's hard bounds in CSS pixels. */
export const BOUNDS: Readonly<Record<ResizableColumn, { readonly min: number; readonly max: number }>> = {
  left: { min: 200, max: 480 },
  imago: { min: 300, max: 720 },
};

/** The middle (the page, or Imago on the ground) never gives up more than this. */
export const MIDDLE_MIN = 400;

/** Arrow keys move the seam 16px, 64px with Shift. */
export const KEY_STEP = 16;
export const KEY_STEP_LARGE = 64;

const isWidth = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const bounded = (column: ResizableColumn, value: unknown): number | null =>
  isWidth(value) ? Math.round(Math.min(BOUNDS[column].max, Math.max(BOUNDS[column].min, value))) : null;

/** What localStorage held; anything malformed is the token width. */
export const parseSizes = (raw: string | null): PaneSizes => {
  if (raw === null) return NO_SIZES;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return NO_SIZES;
    const record = parsed as Record<string, unknown>;
    return { left: bounded('left', record.left), imago: bounded('imago', record.imago) };
  } catch {
    return NO_SIZES;
  }
};

export const serializeSizes = (sizes: PaneSizes): string => JSON.stringify(sizes);

/**
 * The largest width the column may take now: its hard maximum, less whatever the middle would
 * have to give up below MIDDLE_MIN. `current` and `middle` are the measured widths.
 */
export const maxWidthFor = (column: ResizableColumn, current: number, middle: number): number =>
  Math.max(BOUNDS[column].min, Math.min(BOUNDS[column].max, current + middle - MIDDLE_MIN));

export const clampWidth = (column: ResizableColumn, width: number, max: number): number =>
  Math.round(Math.min(max, Math.max(BOUNDS[column].min, width)));

/**
 * The widths the docked columns can take in a row this wide, so the middle keeps MIDDLE_MIN
 * however the saved pair was reached (each saved under a different layout, or a window narrowed
 * since). Imago gives way first, then the left pane, neither below its minimum. A column that is
 * not docked is null. The saved widths are left alone, so widening the window brings them back.
 */
export const fitWidths = (
  rowWidth: number | null,
  docked: { readonly left: number | null; readonly imago: number | null },
): { readonly left: number | null; readonly imago: number | null } => {
  if (rowWidth === null) return docked;
  let excess = (docked.left ?? 0) + (docked.imago ?? 0) + MIDDLE_MIN - rowWidth;
  const give = (column: ResizableColumn, width: number | null): number | null => {
    if (width === null || excess <= 0) return width;
    const next = Math.max(Math.min(width, BOUNDS[column].min), width - excess);
    excess -= width - next;
    return next;
  };
  const imago = give('imago', docked.imago);
  return { left: give('left', docked.left), imago };
};

/** The left pane grows as its right edge moves right; Imago grows as its left edge moves left. */
export const widthFromDrag = (column: ResizableColumn, start: number, deltaX: number): number =>
  column === 'left' ? start + deltaX : start - deltaX;

/** The width a key asks for, or null for a key the seam does not take. */
export const widthFromKey = (
  column: ResizableColumn,
  key: string,
  shift: boolean,
  current: number,
  max: number,
): number | null => {
  const step = shift ? KEY_STEP_LARGE : KEY_STEP;
  if (key === 'Home') return BOUNDS[column].min;
  if (key === 'End') return max;
  if (key === 'ArrowRight') return widthFromDrag(column, current, step);
  if (key === 'ArrowLeft') return widthFromDrag(column, current, -step);
  return null;
};

/** The token widths in px (frame.css, v3.css), for the seam's aria-valuenow before any drag. */
export const TOKEN_WIDTHS = { listPane: 300, treePane: 260, paneOverlay: 236, chatPane: 360 } as const;

export type DockedColumn = {
  /** What the column is drawn at, for its seam. */
  readonly width: number;
  /** A px width over the column's token class, or undefined while the token itself fits. */
  readonly size: number | undefined;
};

/**
 * The docked columns' widths for this render: each one's saved width, else its token, fitted to
 * the row. A column that is not docked is null and keeps its class (sheets, Imago on the ground).
 * A token that still fits stays a class, so the pane keeps sliding on its token.
 */
export const dockedColumns = (
  sizes: PaneSizes,
  rowWidth: number | null,
  tokens: { readonly left: number | null; readonly imago: number | null },
): Readonly<Record<ResizableColumn, DockedColumn | null>> => {
  const fitted = fitWidths(rowWidth, {
    left: tokens.left === null ? null : (sizes.left ?? tokens.left),
    imago: tokens.imago === null ? null : (sizes.imago ?? tokens.imago),
  });
  const column = (key: ResizableColumn): DockedColumn | null => {
    const width = fitted[key];
    if (width === null) return null;
    return { width, size: sizes[key] !== null || width !== tokens[key] ? width : undefined };
  };
  return { left: column('left'), imago: column('imago') };
};
