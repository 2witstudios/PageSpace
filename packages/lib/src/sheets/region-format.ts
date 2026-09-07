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

import { readableTextColor } from './format';
import { PALETTE, type PaletteHue } from './palette';
import type { ColumnRole, RegionColumn } from './regions';
import type { CellFormat } from './types';

/**
 * Used when a region names no theme, or names one the palette does not have.
 * Taken from the palette rather than written out, so it cannot name a hue that
 * does not exist.
 */
const DEFAULT_HUE: PaletteHue = PALETTE[0];
export const DEFAULT_REGION_THEME = DEFAULT_HUE.name;

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
