/**
 * @module @pagespace/lib/sheets/region-format
 * @description Turning a declared region into presentation.
 *
 * This is where taste lives. A region says `C is money`; this module decides
 * that money means two decimals, grouped thousands, and the sheet's currency —
 * so retuning how money looks is a change here, not a migration of every stored
 * region, and an agent that declares structure cannot produce something garish
 * because it never chooses a colour at all.
 *
 * Pure, and separate from `regions` on purpose: parsing has to stay stable
 * (stored data crosses it), while these defaults are expected to be revised.
 */

import { decodeColumnLabel } from './address';
import { readableTextColor } from './format';
import { PALETTE, type PaletteHue } from './palette';
import { parseRegionRange, resolveRegionRows, type ColumnRole, type RegionColumn, type SheetRegion } from './regions';
import type { CellFormat } from './types';

/**
 * Used when a region names no theme, or names one the palette does not have.
 * Taken from the palette rather than written out, so it cannot name a hue that
 * does not exist.
 */
const DEFAULT_HUE: PaletteHue = PALETTE[0];
export const DEFAULT_REGION_THEME = DEFAULT_HUE.name;

/** What `decodeColumnLabel` will accept without throwing. */
const COLUMN_LABEL = /^[A-Z]{1,7}$/;

/**
 * Precision per role, where the role implies one.
 *
 * `number` deliberately has none: a bare number column is the one case where
 * the data's own precision is the best answer. See the `number` branch below.
 */
const ROLE_DECIMALS: Partial<Record<ColumnRole, number>> = {
  currency: 2,
  percent: 1,
};

/**
 * The presentation a column's role implies.
 *
 * Note what is *not* here: alignment. Numerics are right-aligned with tabular
 * figures by the grid itself, so storing alignment would duplicate a decision
 * the renderer already makes — and then fight it wherever the two disagree.
 */
export function columnRoleFormat(column: RegionColumn): CellFormat {
  const decimals = column.decimals ?? ROLE_DECIMALS[column.role];

  switch (column.role) {
    case 'currency':
      // `decimals` is never undefined here: ROLE_DECIMALS supplies a default
      // for both roles that have one.
      return {
        number: {
          kind: 'currency',
          currency: column.currency ?? 'USD',
          thousands: true,
          decimals,
        },
      };

    case 'percent':
      return { number: { kind: 'percent', decimals } };

    case 'number':
      // Without a declared precision there is nothing honest to impose. The
      // engine's `number` kind defaults to two decimals, which renders a column
      // of counts as `12.00`; defaulting to zero instead would round `3.7` to
      // `4` and misstate the data. `auto` renders the value as it is, and
      // declaring `decimals` is how a column opts into a uniform look.
      return decimals === undefined
        ? { number: { kind: 'auto' } }
        : { number: { kind: 'number', thousands: true, decimals } };

    case 'date':
      return { number: { kind: 'date', dateStyle: 'medium' } };

    case 'datetime':
      return { number: { kind: 'datetime', dateStyle: 'medium' } };

    case 'id':
      // An identifier that looks numeric is not a number: formatting it would
      // group its digits and drop a leading zero. Monospace because ids are
      // compared by eye, column-wise.
      return { number: { kind: 'text' }, fontFamily: 'mono' };

    case 'text':
      return {};
  }
}

export interface RegionTheme {
  hue: PaletteHue;
  header: CellFormat;
  total: CellFormat;
}

const hueByName = (name: string | undefined): PaletteHue => {
  // A region may name a hue this build does not have — an older palette, or a
  // typo that `parseRegion` cannot check without importing the palette. Falling
  // back beats refusing to render the table.
  return PALETTE.find((entry) => entry.name === name) ?? DEFAULT_HUE;
};

/**
 * The header and total treatments for a theme.
 *
 * Both fills carry an explicit text colour, and that is not belt-and-braces: a
 * stored fill is an absolute colour and does NOT re-tint in dark mode, so a pale
 * total-row fill left to inherit the theme's text colour renders near-white text
 * on near-white in dark mode. `readableTextColor` picks the side of the contrast
 * threshold that works against the fill in either theme, which is the only
 * choice that survives being exported to XLSX and published as static HTML too.
 */
export function regionTheme(name?: string): RegionTheme {
  const hue = hueByName(name);

  return {
    hue,
    header: {
      bold: true,
      background: hue.deep,
      color: readableTextColor(hue.deep),
    },
    total: {
      bold: true,
      background: hue.tint,
      color: readableTextColor(hue.tint),
    },
  };
}

/**
 * Resolves the derived format at a cell, or `undefined` where no region covers
 * it.
 *
 * A factory rather than a bare function because this is called once per cell of
 * a full evaluation: everything that depends only on the region set — resolved
 * bounds, per-column role formats, the theme's two treatments, the total-row
 * lookup — is computed once here instead of per cell. The returned closure does
 * a bounds test and at most three object spreads.
 */
export type RegionResolver = (row: number, column: number) => CellFormat | undefined;

interface PreparedRegion {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
  headerEnd: number;
  totalRows: ReadonlySet<number>;
  columns: ReadonlyMap<number, CellFormat>;
  header: CellFormat;
  total: CellFormat;
}

const NO_REGIONS: RegionResolver = () => undefined;

const prepare = (region: SheetRegion, rowCount: number): PreparedRegion | null => {
  const bounds = parseRegionRange(region.range);
  // Already validated by `parseRegion`, but this is also reachable with a region
  // handed straight in, and a table that cannot be located formats nothing.
  if (!bounds) return null;

  const { rowStart, rowEnd } = resolveRegionRows(bounds, rowCount);
  const theme = regionTheme(region.theme);

  const columns = new Map<number, CellFormat>();
  for (const column of region.columns ?? []) {
    // `decodeColumnLabel` THROWS on anything that is not letters, and this is
    // reached from `evaluateSheet`, which takes a `SheetData` directly — so a
    // region that never went through `parseRegion` (a hand-built sheet, or a
    // future caller) could abort the evaluation of the whole sheet over one
    // malformed label. Skipping the column degrades to "this column is not
    // styled", which is the right failure for presentation.
    if (!COLUMN_LABEL.test(column.column)) continue;

    const format = columnRoleFormat(column);
    // An empty format (role `text`) would still cost a spread per cell for
    // nothing.
    if (Object.keys(format).length > 0) columns.set(decodeColumnLabel(column.column), format);
  }

  const headerRows = region.headerRows ?? 1;

  return {
    rowStart,
    rowEnd,
    colStart: bounds.colStart,
    colEnd: bounds.colEnd,
    headerEnd: rowStart + headerRows - 1,
    // Stored 1-based, compared 0-based: the row numbers a person reads are the
    // row numbers they declare.
    totalRows: new Set((region.totalRows ?? []).map((row) => row - 1)),
    columns,
    header: theme.header,
    total: theme.total,
  };
};

export function createRegionResolver(
  regions: readonly SheetRegion[] | undefined,
  rowCount: number
): RegionResolver {
  if (!regions || regions.length === 0) return NO_REGIONS;

  const prepared = regions
    .map((region) => prepare(region, rowCount))
    .filter((region): region is PreparedRegion => region !== null);

  if (prepared.length === 0) return NO_REGIONS;

  return (row, column) => {
    let format: CellFormat | undefined;

    // Declaration order is precedence order: a later region layers over an
    // earlier one where they overlap, matching how conditional rules stack.
    for (const region of prepared) {
      if (row < region.rowStart || row > region.rowEnd) continue;
      if (column < region.colStart || column > region.colEnd) continue;

      if (row <= region.headerEnd) {
        // A header cell holds a label, not data, so the column's role format is
        // deliberately not applied: a currency format on the word "Revenue"
        // describes nothing.
        format = { ...format, ...region.header };
        continue;
      }

      const role = region.columns.get(column);
      if (role) format = { ...format, ...role };
      // A total IS data, so its role format stays and the emphasis layers over.
      if (region.totalRows.has(row)) format = { ...format, ...region.total };
    }

    return format;
  };
}
