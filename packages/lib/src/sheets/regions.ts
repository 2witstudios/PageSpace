/**
 * @module @pagespace/lib/sheets/regions
 * @description Declared structure: which rows are headers, what a column
 * *means*, where the totals are.
 *
 * A region says what an area of the sheet IS, not how it looks. Presentation is
 * derived from it (see `region-format`) rather than written per cell, and that
 * distinction is the whole point of the module:
 *
 *  - A derived format covers rows that do not exist yet, so appending a row to a
 *    table inherits its formatting with no second pass and nothing to keep in
 *    sync. Per-cell formatting cannot do this — it covers the cells that existed
 *    when it was applied, which is why a table formatted cell-by-cell decays the
 *    moment it grows.
 *  - It keeps the *reason* for a format. `C is money` survives a column being
 *    widened, re-themed, or exported; `C2:C51 has number.kind = currency` is the
 *    residue of that decision with the decision thrown away.
 *
 * Pure, and deliberately free of any evaluation or storage dependency: parsing
 * is the boundary every stored region crosses, and it has to be testable without
 * an engine or a database.
 */

import { MAX_ADDRESSABLE_COLUMN, MAX_ADDRESSABLE_ROW, decodeCellAddress, decodeColumnLabel } from './address';

/**
 * What a column holds. A role is a *meaning*, not a format — `currency` is
 * "this column is money", and which number format renders that is
 * `region-format`'s decision, so retuning presentation never means rewriting
 * stored regions.
 */
export type ColumnRole =
  | 'text'
  | 'number'
  | 'currency'
  | 'percent'
  | 'date'
  | 'datetime'
  | 'id';

const ROLES: ReadonlySet<string> = new Set<ColumnRole>([
  'text',
  'number',
  'currency',
  'percent',
  'date',
  'datetime',
  'id',
]);

export interface RegionColumn {
  /** Column letters, normalized uppercase. */
  column: string;
  role: ColumnRole;
  /** ISO 4217, for `role: 'currency'`. */
  currency?: string;
  /** Overrides the role's default precision. */
  decimals?: number;
}

export interface SheetRegion {
  id: string;
  /** Shown to people and to agents reading the sheet back; never rendered. */
  name?: string;
  /**
   * The area, A1-style. The row end may be omitted — `"A1:F"` means "column A
   * to F, from row 1 to the end of the sheet" — which is what lets the region
   * cover rows that do not exist yet.
   */
  range: string;
  /** Leading rows that are headers rather than data. Defaults to 1. */
  headerRows?: number;
  /** Absolute 1-based row numbers that hold totals. */
  totalRows?: number[];
  columns?: RegionColumn[];
  /** A hue name from the shared palette. */
  theme?: string;
  // No `freezeHeader`. Frozen panes are tab-level state (`frozenRows` on the
  // tab), not presentation derived per cell, so there is nothing for a region
  // to carry: a field here would be parsed, stored and honoured by nothing. A
  // caller that wants the header pinned asks for a freeze; `format_sheet`
  // accepts `freezeHeader` as an INPUT and turns it into exactly that.
}

/**
 * A parsed region range, 0-based, with `rowEnd: null` meaning "open".
 *
 * Kept separate from the string so the open end stays explicit all the way to
 * the point it is resolved: collapsing it to a number at parse time would bake
 * in the extent the sheet happened to have when it was parsed, which is exactly
 * the staleness the open form exists to avoid.
 */
export interface RegionBounds {
  rowStart: number;
  colStart: number;
  colEnd: number;
  rowEnd: number | null;
}

/**
 * A sheet with more than this many declared tables is not a layout anyone
 * authored; it is a loop that got away from something. Bounded here because
 * regions are API-writable jsonb.
 */
export const MAX_REGIONS = 50;
/** Past the widest realistic table; also bounds work per region. */
export const MAX_REGION_COLUMNS = 256;
export const MAX_REGION_TOTAL_ROWS = 64;
export const MAX_REGION_HEADER_ROWS = 16;
/** See `parseConditionalRules` for why the map form needs its own bound. */
export const MAX_REGION_MAP_KEYS_SCANNED = MAX_REGIONS * 10;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const COLUMN_ONLY = /^[A-Z]{1,7}$/;

/**
 * Parse `"A1:F200"` or the open `"A1:F"`.
 *
 * Written here rather than reusing `addressesOfRange`/`rangeAnchor` because
 * both deliberately reject a missing row end (`"A1:"` is a truncated range, and
 * silently treating it as one cell would look like it worked). For a region the
 * open end is meaningful rather than truncated, so it needs its own reader —
 * and a region is described by its bounds, never expanded to an address list,
 * which is what keeps an open region free regardless of sheet size.
 */
export function parseRegionRange(range: string): RegionBounds | null {
  if (typeof range !== 'string') return null;

  const normalized = range.trim().toUpperCase();
  const [rawStart, rawEnd, ...extra] = normalized.split(':');
  // A region is an area. A bare cell would be a region of one, which is a
  // per-cell format wearing a costume.
  if (!rawStart || !rawEnd || extra.length > 0) return null;

  let start: { row: number; column: number };
  try {
    start = decodeCellAddress(rawStart);
  } catch {
    return null;
  }

  let end: { row: number | null; column: number };
  if (COLUMN_ONLY.test(rawEnd)) {
    // `decodeColumnLabel` throws on anything but letters, which the regex above
    // has already established.
    end = { row: null, column: decodeColumnLabel(rawEnd) };
  } else {
    try {
      const decoded = decodeCellAddress(rawEnd);
      end = { row: decoded.row, column: decoded.column };
    } catch {
      return null;
    }
  }

  if (end.column > MAX_ADDRESSABLE_COLUMN || start.column > MAX_ADDRESSABLE_COLUMN) return null;
  if (start.row > MAX_ADDRESSABLE_ROW || (end.row !== null && end.row > MAX_ADDRESSABLE_ROW)) {
    return null;
  }

  // Corners in either order, as everywhere else a range is accepted.
  const colStart = Math.min(start.column, end.column);
  const colEnd = Math.max(start.column, end.column);
  const rowStart = end.row === null ? start.row : Math.min(start.row, end.row);
  const rowEnd = end.row === null ? null : Math.max(start.row, end.row);

  if (colEnd - colStart + 1 > MAX_REGION_COLUMNS) return null;

  return { rowStart, colStart, colEnd, rowEnd };
}

/**
 * Close an open region against the sheet's extent.
 *
 * `rowCount` is the *declared* extent, not the last row holding data. Using the
 * data would make a region's reach depend on its contents: clearing the last
 * row would silently shrink the table, and the formatting of rows above it
 * would change because a cell below them became empty. The declared extent is
 * what `appendRows` grows, so inheritance follows the sheet rather than the
 * data.
 */
export function resolveRegionRows(
  bounds: RegionBounds,
  rowCount: number
): { rowStart: number; rowEnd: number } {
  const last = Math.max(0, Math.floor(rowCount) - 1);
  return {
    rowStart: bounds.rowStart,
    rowEnd: bounds.rowEnd === null ? Math.max(bounds.rowStart, last) : bounds.rowEnd,
  };
}

const readColumns = (value: unknown): RegionColumn[] | null => {
  if (!Array.isArray(value)) return null;

  const columns: RegionColumn[] = [];
  // Sliced before validating, not after: the bound is on how much is inspected,
  // not on how much survives.
  for (const entry of value.slice(0, MAX_REGION_COLUMNS)) {
    if (!isObject(entry)) continue;
    if (typeof entry.column !== 'string') continue;

    const column = entry.column.trim().toUpperCase();
    if (!COLUMN_ONLY.test(column) || decodeColumnLabel(column) > MAX_ADDRESSABLE_COLUMN) continue;
    if (typeof entry.role !== 'string' || !ROLES.has(entry.role)) continue;

    // Same cast-and-delete shape as `parseRegion`, and for the same reason:
    // unknown fields travel through, but an unknown *value* of a known field
    // must not. Spreading `entry` over a validated object would let
    // `decimals: 99` survive simply because validation declined to set it.
    const parsed = { ...entry, column, role: entry.role as ColumnRole } as unknown as RegionColumn;

    // A 3-letter code is the whole contract; anything else would reach
    // `Intl.NumberFormat` and throw at render time, far from here.
    if (typeof entry.currency === 'string' && /^[A-Za-z]{3}$/.test(entry.currency)) {
      parsed.currency = entry.currency.toUpperCase();
    } else {
      delete parsed.currency;
    }

    if (
      typeof entry.decimals === 'number' &&
      Number.isInteger(entry.decimals) &&
      entry.decimals >= 0 &&
      entry.decimals <= 10
    ) {
      parsed.decimals = entry.decimals;
    } else {
      delete parsed.decimals;
    }

    columns.push(parsed);
  }

  // Two entries for one column would make derivation order-dependent for no
  // expressible reason; the last one wins, as a later declaration does
  // everywhere else here.
  const byColumn = new Map<string, RegionColumn>();
  for (const column of columns) byColumn.set(column.column, column);
  return [...byColumn.values()];
};

const readTotalRows = (value: unknown): number[] | null => {
  if (!Array.isArray(value)) return null;
  const rows = value
    .slice(0, MAX_REGION_TOTAL_ROWS)
    .filter(
      (row): row is number =>
        typeof row === 'number' && Number.isInteger(row) && row >= 1 && row <= MAX_ADDRESSABLE_ROW
    );
  return [...new Set(rows)].sort((a, b) => a - b);
};

/**
 * Validate one stored region.
 *
 * Same contract as `parseConditionalRule`: a region whose core shape is unusable
 * is dropped rather than half-applied, while unknown *fields* inside an
 * otherwise valid region are carried through untouched, so a region written by a
 * newer build survives a load/save cycle here instead of being silently
 * downgraded.
 */
export function parseRegion(value: unknown): SheetRegion | null {
  if (!isObject(value)) return null;

  const id = typeof value.id === 'string' && value.id !== '' ? value.id : null;
  if (!id) return null;

  if (typeof value.range !== 'string') return null;
  const bounds = parseRegionRange(value.range);
  if (!bounds) return null;

  // The cast asserts exactly what the assignments below establish: every field
  // `SheetRegion` declares is either validated here or removed, so what survives
  // from `value` is only the unknown extras a newer build wrote — which travel
  // through untouched. TypeScript cannot see that, because spreading a
  // `Record<string, unknown>` types every inherited key as `unknown`.
  const region = { ...value, id, range: value.range.trim().toUpperCase() } as unknown as SheetRegion;

  if (typeof value.name === 'string' && value.name.trim() !== '') {
    region.name = value.name.trim().slice(0, 200);
  } else {
    delete region.name;
  }

  // A header band taller than the region is not a header band; dropping the
  // field falls back to the default rather than rejecting the whole region,
  // because the columns and totals are still usable.
  const height = bounds.rowEnd === null ? null : bounds.rowEnd - bounds.rowStart + 1;
  if (
    typeof value.headerRows === 'number' &&
    Number.isInteger(value.headerRows) &&
    value.headerRows >= 0 &&
    value.headerRows <= MAX_REGION_HEADER_ROWS &&
    (height === null || value.headerRows <= height)
  ) {
    region.headerRows = value.headerRows;
  } else {
    delete region.headerRows;
  }

  const totalRows = readTotalRows(value.totalRows);
  if (totalRows && totalRows.length > 0) region.totalRows = totalRows;
  else delete region.totalRows;

  const columns = readColumns(value.columns);
  if (columns && columns.length > 0) region.columns = columns;
  else delete region.columns;

  if (typeof value.theme === 'string' && /^[a-z]{1,24}$/.test(value.theme.trim().toLowerCase())) {
    region.theme = value.theme.trim().toLowerCase();
  } else {
    delete region.theme;
  }

  return region;
}

/**
 * Validate a stored region list, in either the array form or the numerically
 * keyed map the TOML bag uses.
 *
 * Mirrors `parseConditionalRules`, including why the map form enumerates with a
 * bounded `for...in` rather than `Object.keys(...).slice(...)`: `Object.keys`
 * always enumerates and allocates for every own key before anything can bound
 * it, so slicing afterwards bounds the work downstream and not the enumeration.
 */
export function parseRegions(value: unknown): SheetRegion[] | undefined {
  let entries: unknown[];

  if (Array.isArray(value)) {
    entries = value;
  } else if (isObject(value)) {
    const keys: string[] = [];
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      keys.push(key);
      if (keys.length >= MAX_REGION_MAP_KEYS_SCANNED) break;
    }

    entries = keys
      .map((key) => ({ key, index: Number(key) }))
      .filter(({ index }) => Number.isFinite(index))
      .sort((a, b) => a.index - b.index)
      .map(({ key }) => value[key]);
  } else {
    return undefined;
  }

  // Collected incrementally and stopped at the cap rather than parsing
  // everything and slicing: `entries` is unbounded and parsing one is real work.
  const regions: SheetRegion[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (regions.length >= MAX_REGIONS) break;
    const region = parseRegion(entry);
    // Duplicate ids would make `upsertRegion` ambiguous about which one it
    // replaced, so the first wins and later ones are dropped.
    if (!region || seen.has(region.id)) continue;
    seen.add(region.id);
    regions.push(region);
  }

  return regions.length > 0 ? regions : undefined;
}
