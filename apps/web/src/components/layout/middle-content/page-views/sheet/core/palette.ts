/**
 * The colour vocabulary for sheet formatting.
 *
 * The hues are the twelve the product already uses for task statuses
 * (`StatusConfigManager`'s `COLOR_PRESETS`), so a dashboard built here reads as
 * PageSpace rather than as Excel. They are restated as hex because
 * `CellFormat.color`/`background` are `#rrggbb` — the same values travel into
 * the XLSX export and the published page, where a Tailwind class means nothing.
 *
 * Consequence worth stating plainly: a stored fill is an absolute colour, so it
 * does not re-tint in dark mode. That is deliberate — it is what makes the
 * exported workbook and the published page match what the author saw. The
 * `tint` row is the one to reach for when a fill has to work in both themes.
 */

/** A named hue with its three usable strengths. */
export interface PaletteHue {
  name: string;
  /** Pale fill: readable under dark text in either theme. */
  tint: string;
  /** Saturated fill or emphatic text. */
  mid: string;
  /** Deep text colour, or a strong fill under white text. */
  deep: string;
}

export const PALETTE: readonly PaletteHue[] = [
  { name: 'slate',  tint: '#f1f5f9', mid: '#64748b', deep: '#334155' },
  { name: 'blue',   tint: '#dbeafe', mid: '#3b82f6', deep: '#1d4ed8' },
  { name: 'cyan',   tint: '#cffafe', mid: '#06b6d4', deep: '#0e7490' },
  { name: 'teal',   tint: '#ccfbf1', mid: '#14b8a6', deep: '#0f766e' },
  { name: 'green',  tint: '#dcfce7', mid: '#22c55e', deep: '#15803d' },
  { name: 'amber',  tint: '#fef3c7', mid: '#f59e0b', deep: '#b45309' },
  { name: 'orange', tint: '#ffedd5', mid: '#f97316', deep: '#c2410c' },
  { name: 'red',    tint: '#fee2e2', mid: '#ef4444', deep: '#b91c1c' },
  { name: 'pink',   tint: '#fce7f3', mid: '#ec4899', deep: '#be185d' },
  { name: 'purple', tint: '#f3e8ff', mid: '#a855f7', deep: '#7e22ce' },
  { name: 'violet', tint: '#ede9fe', mid: '#8b5cf6', deep: '#6d28d9' },
  { name: 'indigo', tint: '#e0e7ff', mid: '#6366f1', deep: '#4338ca' },
] as const;

/** Greys and the two extremes, offered as a separate row. */
export const NEUTRALS: readonly string[] = [
  '#ffffff',
  '#f8fafc',
  '#e2e8f0',
  '#cbd5e1',
  '#94a3b8',
  '#475569',
  '#1e293b',
  '#000000',
] as const;

export type PaletteStrength = keyof Omit<PaletteHue, 'name'>;

/** Every swatch of one strength, in palette order. */
export const swatchRow = (strength: PaletteStrength): string[] =>
  PALETTE.map((hue) => hue[strength]);

/**
 * Parse `#rgb` or `#rrggbb` into channel values, or null if it is neither.
 * Accepting the short form matters because it is what people type by hand.
 */
export const parseHex = (value: string): { r: number; g: number; b: number } | null => {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;

  const digits = match[1];
  const expanded =
    digits.length === 3
      ? digits
          .split('')
          .map((d) => d + d)
          .join('')
      : digits;

  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16),
  };
};

/**
 * Normalise typed input to the `#rrggbb` the model stores, or null if it is not
 * a colour. Everything the user types goes through here before it reaches
 * `CellFormat`, so the schema never has to reject a merely-informal spelling.
 */
export const normalizeHex = (value: string): string | null => {
  const parsed = parseHex(value.startsWith('#') ? value : `#${value}`);
  if (!parsed) return null;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(parsed.r)}${hex(parsed.g)}${hex(parsed.b)}`;
};


/**
 * Re-exported from the lib so the tick drawn on a swatch is decided by exactly
 * the same rule that decides a filled cell's text colour. Two copies of this
 * would be free to disagree, and the disagreement would show as a tick you
 * cannot see on a colour you just picked.
 */
export { readableTextColor } from '@pagespace/lib/sheets/sheet';
