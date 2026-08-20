/**
 * @module @pagespace/lib/sheets/format
 * @description Cell presentation: number formatting, validation, and the
 * translation of a `CellFormat` into CSS or an Excel number-format code.
 *
 * Number formatting is applied at the evaluator's display projection rather
 * than in any one renderer, because `SheetEvaluation.display` is what the grid,
 * the CSV export, the XLSX export and the published page all read. Formatting
 * in a renderer would let those four disagree about what a cell says.
 */

import { z } from 'zod';
import type {
  CellBorderSide,
  CellBorders,
  CellFormat,
  NumberFormat,
  SheetPrimitive,
} from './types';

/** `#rgb` is deliberately not accepted — one canonical form keeps round trips exact. */
export const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export const MAX_DECIMALS = 10;
export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 96;

/**
 * Whether a string is safe to emit into a `style` attribute as a color.
 *
 * Published sheets render to static HTML with inline styles, so this is a
 * trust boundary, not a formatting nicety: it is checked again at render time
 * even though stored formats were validated on parse.
 */
export function isValidHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value);
}

const hexColorSchema = z.string().regex(HEX_COLOR_PATTERN, 'Expected a #rrggbb color');

const numberFormatSchema: z.ZodType<NumberFormat> = z.object({
  kind: z.enum([
    'auto',
    'plain',
    'number',
    'currency',
    'percent',
    'date',
    'time',
    'datetime',
    'scientific',
    'text',
    'custom',
  ]),
  decimals: z.number().int().min(0).max(MAX_DECIMALS).optional(),
  currency: z.string().length(3).optional(),
  thousands: z.boolean().optional(),
  dateStyle: z.enum(['short', 'medium', 'long', 'iso']).optional(),
  pattern: z.string().max(255).optional(),
});

const borderSideSchema: z.ZodType<CellBorderSide> = z.object({
  style: z.enum(['thin', 'medium', 'thick', 'dashed', 'dotted']),
  color: hexColorSchema.optional(),
});

const bordersSchema: z.ZodType<CellBorders> = z.object({
  top: borderSideSchema.optional(),
  right: borderSideSchema.optional(),
  bottom: borderSideSchema.optional(),
  left: borderSideSchema.optional(),
});

export const cellFormatSchema: z.ZodType<CellFormat> = z.object({
  number: numberFormatSchema.optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  valign: z.enum(['top', 'middle', 'bottom']).optional(),
  wrap: z.boolean().optional(),
  color: hexColorSchema.optional(),
  background: hexColorSchema.optional(),
  borders: bordersSchema.optional(),
  fontSize: z.number().int().min(MIN_FONT_SIZE).max(MAX_FONT_SIZE).optional(),
  fontFamily: z.enum(['sans', 'mono']).optional(),
});

/**
 * Per-field schemas, so one bad field does not condemn the whole format.
 *
 * A `Map`, not an object literal: a stored key of `__proto__` or `constructor`
 * resolves through an object's prototype chain to something truthy that is not
 * a schema, and the lookup below would then throw on every load and every save
 * of a document carrying such a key.
 */
const FIELD_SCHEMAS = new Map<string, z.ZodTypeAny>([
  ['number', numberFormatSchema],
  ['bold', z.boolean()],
  ['italic', z.boolean()],
  ['underline', z.boolean()],
  ['strike', z.boolean()],
  ['align', z.enum(['left', 'center', 'right'])],
  ['valign', z.enum(['top', 'middle', 'bottom'])],
  ['wrap', z.boolean()],
  ['color', hexColorSchema],
  ['background', hexColorSchema],
  ['borders', bordersSchema],
  ['fontSize', z.number().int().min(MIN_FONT_SIZE).max(MAX_FONT_SIZE)],
  ['fontFamily', z.enum(['sans', 'mono'])],
]);

/**
 * Keys never carried through, whatever a stored document says. Passing these
 * on would let a crafted sheet reach `Object.prototype` through the spreads in
 * `resolveCellFormat` and `setCellFormats`.
 */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Sanitize a stored format field by field.
 *
 * Deliberately NOT all-or-nothing, and deliberately not `cellFormatSchema`
 * directly, for two reasons:
 *
 * - An invalid field must not take valid ones with it. `{bold: true,
 *   fontSize: 5}` should keep the bold; dropping the whole entry loses styling
 *   the user can see and did not ask to lose.
 * - Unknown fields are preserved. A field written by a newer build would
 *   otherwise be stripped the first time an older build saves — the same
 *   silent cross-version data loss the `ranges` passthrough exists to avoid.
 *
 * Unknown fields are inert at render time: `cellFormatToStyle` reads only
 * known fields and `cellFormatToInlineCss` emits only allow-listed properties,
 * so passing them through carries no injection risk.
 */
export function parseCellFormat(value: unknown): CellFormat | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    if (fieldValue === undefined) continue;
    if (FORBIDDEN_KEYS.has(key)) continue;

    const schema = FIELD_SCHEMAS.get(key);
    if (!schema) {
      // Unknown to this build — carry it through untouched.
      sanitized[key] = fieldValue;
      continue;
    }

    const result = schema.safeParse(fieldValue);
    if (result.success) {
      sanitized[key] = result.data;
    }
  }

  return Object.keys(sanitized).length > 0 ? (sanitized as CellFormat) : undefined;
}

/** Whether a format carries no instructions and can be dropped. */
export function isEmptyFormat(format: CellFormat | undefined): boolean {
  if (!format) return true;
  return Object.values(format).every((value) => value === undefined);
}

/**
 * Merge a column default with a cell's own format, the cell winning per-field.
 * Exposed so callers resolve precedence identically everywhere.
 */
export function resolveCellFormat(
  cellFormat: CellFormat | undefined,
  columnFormat: CellFormat | undefined
): CellFormat | undefined {
  if (!columnFormat) return cellFormat;
  if (!cellFormat) return columnFormat;
  return { ...columnFormat, ...cellFormat };
}

const clampDecimals = (decimals: number | undefined, fallback: number): number => {
  if (decimals === undefined || !Number.isFinite(decimals)) return fallback;
  return Math.min(MAX_DECIMALS, Math.max(0, Math.trunc(decimals)));
};

const groupThousands = (value: string): string => {
  const [whole, fraction] = value.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${fraction}`;
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  CAD: 'CA$',
  AUD: 'A$',
  CHF: 'CHF ',
  CNY: 'CN¥',
  INR: '₹',
  NZD: 'NZ$',
};

const currencySymbol = (code: string | undefined): string => {
  if (!code) return CURRENCY_SYMBOLS.USD;
  return CURRENCY_SYMBOLS[code.toUpperCase()] ?? `${code.toUpperCase()} `;
};

/**
 * Parse the engine's date representation. Dates are stored as strings
 * (`TODAY()` yields `YYYY-MM-DD`), not as serial numbers, so this reads the
 * components directly rather than going through `new Date(string)` — the
 * latter treats a bare date as UTC and then local getters shift it a day in
 * negative-offset timezones.
 */
const parseDateParts = (
  value: string
): { year: number; month: number; day: number; hours: number; minutes: number; seconds: number } | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value.trim());
  if (!match) return null;

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hours: Number(match[4] ?? '0'),
    minutes: Number(match[5] ?? '0'),
    seconds: Number(match[6] ?? '0'),
  };
};

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const pad2 = (value: number): string => String(value).padStart(2, '0');

const formatDateParts = (
  parts: NonNullable<ReturnType<typeof parseDateParts>>,
  style: NumberFormat['dateStyle']
): string => {
  const { year, month, day } = parts;
  switch (style) {
    case 'long':
      return `${MONTHS_LONG[month - 1] ?? month} ${day}, ${year}`;
    case 'medium':
      return `${(MONTHS_LONG[month - 1] ?? String(month)).slice(0, 3)} ${day}, ${year}`;
    case 'short':
      return `${month}/${day}/${year}`;
    case 'iso':
    default:
      return `${year}-${pad2(month)}-${pad2(day)}`;
  }
};

/**
 * Render a computed value for display under a number format.
 *
 * Returns `null` when the format does not apply — an `auto` format, a value
 * the format cannot render (text under a numeric format), or a `custom`
 * pattern this build cannot interpret. The caller then falls back to the
 * engine's default rendering, so an unsupported format degrades to the plain
 * value rather than to an error or an empty cell.
 */
export function applyNumberFormat(
  value: SheetPrimitive,
  format: NumberFormat | undefined
): string | null {
  if (!format || format.kind === 'auto' || format.kind === 'custom') {
    return null;
  }

  if (format.kind === 'text') {
    return String(value);
  }

  if (format.kind === 'date' || format.kind === 'time' || format.kind === 'datetime') {
    const parts = parseDateParts(String(value));
    if (!parts) return null;

    const date = formatDateParts(parts, format.dateStyle);
    const time = `${pad2(parts.hours)}:${pad2(parts.minutes)}:${pad2(parts.seconds)}`;

    if (format.kind === 'date') return date;
    if (format.kind === 'time') return time;
    return `${date} ${time}`;
  }

  // Remaining kinds are numeric. Booleans are deliberately not coerced: `TRUE`
  // formatted as currency should stay `true`, not become `$1.00`.
  if (typeof value !== 'number') {
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return applyNumberFormat(Number(value), format);
    }
    return null;
  }

  if (!Number.isFinite(value)) {
    return null;
  }

  switch (format.kind) {
    case 'plain':
      return String(value);

    case 'number': {
      const decimals = clampDecimals(format.decimals, 2);
      const fixed = value.toFixed(decimals);
      return format.thousands === false ? fixed : groupThousands(fixed);
    }

    case 'currency': {
      const decimals = clampDecimals(format.decimals, 2);
      const symbol = currencySymbol(format.currency);
      const magnitude = Math.abs(value).toFixed(decimals);
      const grouped = format.thousands === false ? magnitude : groupThousands(magnitude);
      return `${value < 0 ? '-' : ''}${symbol}${grouped}`;
    }

    case 'percent': {
      const decimals = clampDecimals(format.decimals, 0);
      const scaled = (value * 100).toFixed(decimals);
      return `${format.thousands === false ? scaled : groupThousands(scaled)}%`;
    }

    case 'scientific': {
      const decimals = clampDecimals(format.decimals, 2);
      return value.toExponential(decimals);
    }

    default:
      return null;
  }
}

/**
 * The Excel number-format code (`z`) matching a format, so an exported
 * workbook shows what the grid shows and still holds real numbers.
 * Returns undefined when Excel's default rendering is correct.
 */
export function numberFormatToExcelCode(format: NumberFormat | undefined): string | undefined {
  if (!format) return undefined;

  // A pattern we could not interpret came from Excel in the first place —
  // hand it straight back rather than losing it.
  if (format.kind === 'custom') return format.pattern;

  const decimals = (fallback: number) => clampDecimals(format.decimals, fallback);
  const fraction = (count: number) => (count > 0 ? `.${'0'.repeat(count)}` : '');

  switch (format.kind) {
    case 'number': {
      const count = decimals(2);
      return format.thousands === false ? `0${fraction(count)}` : `#,##0${fraction(count)}`;
    }
    case 'currency': {
      const count = decimals(2);
      const symbol = currencySymbol(format.currency).trim();
      // `applyNumberFormat` honours `thousands: false` for currency, so the
      // Excel code must too or the workbook groups digits the grid does not.
      const integer = format.thousands === false ? '0' : '#,##0';
      return `"${symbol}"${integer}${fraction(count)}`;
    }
    case 'percent':
      return `0${fraction(decimals(0))}%`;
    case 'scientific':
      return `0${fraction(decimals(2))}E+00`;
    case 'date':
      return format.dateStyle === 'short' ? 'm/d/yyyy' : 'yyyy-mm-dd';
    case 'time':
      return 'hh:mm:ss';
    case 'datetime':
      return 'yyyy-mm-dd hh:mm:ss';
    case 'text':
      return '@';
    case 'plain':
      return '0.##########';
    case 'auto':
    default:
      return undefined;
  }
}

const BORDER_WIDTHS: Record<CellBorderSide['style'], string> = {
  thin: '1px solid',
  medium: '2px solid',
  thick: '3px solid',
  dashed: '1px dashed',
  dotted: '1px dotted',
};

const borderValue = (side: CellBorderSide | undefined): string | undefined => {
  if (!side) return undefined;
  const width = BORDER_WIDTHS[side.style];
  if (!width) return undefined;
  const color = isValidHexColor(side.color) ? side.color : 'currentColor';
  return `${width} ${color}`;
};

/**
 * A `CellFormat` as a style object for the grid.
 *
 * Colors are re-validated here even though they were validated on parse: this
 * value reaches a `style` attribute, and defence in depth is cheap.
 */
export function cellFormatToStyle(format: CellFormat | undefined): Record<string, string> {
  const style: Record<string, string> = {};
  if (!format) return style;

  if (format.bold) style.fontWeight = '600';
  if (format.italic) style.fontStyle = 'italic';

  const decorations = [format.underline && 'underline', format.strike && 'line-through'].filter(
    Boolean
  );
  if (decorations.length > 0) style.textDecoration = decorations.join(' ');

  if (format.align) style.textAlign = format.align;
  if (format.valign) {
    style.verticalAlign = format.valign;
    style.alignItems =
      format.valign === 'top' ? 'flex-start' : format.valign === 'bottom' ? 'flex-end' : 'center';
  }
  if (format.wrap) {
    style.whiteSpace = 'pre-wrap';
    style.overflowWrap = 'anywhere';
  }
  if (isValidHexColor(format.color)) style.color = format.color;
  if (isValidHexColor(format.background)) style.backgroundColor = format.background;
  if (format.fontSize) style.fontSize = `${format.fontSize}px`;
  if (format.fontFamily) {
    style.fontFamily =
      format.fontFamily === 'mono' ? 'var(--font-mono, monospace)' : 'var(--font-sans, sans-serif)';
  }

  const borders: Array<[keyof CellBorders, string]> = [
    ['top', 'borderTop'],
    ['right', 'borderRight'],
    ['bottom', 'borderBottom'],
    ['left', 'borderLeft'],
  ];
  for (const [side, property] of borders) {
    const value = borderValue(format.borders?.[side]);
    if (value) style[property] = value;
  }

  return style;
}

const CSS_PROPERTY_NAMES: Record<string, string> = {
  fontWeight: 'font-weight',
  fontStyle: 'font-style',
  textDecoration: 'text-decoration',
  textAlign: 'text-align',
  verticalAlign: 'vertical-align',
  alignItems: 'align-items',
  whiteSpace: 'white-space',
  overflowWrap: 'overflow-wrap',
  backgroundColor: 'background-color',
  fontSize: 'font-size',
  fontFamily: 'font-family',
  borderTop: 'border-top',
  borderRight: 'border-right',
  borderBottom: 'border-bottom',
  borderLeft: 'border-left',
  color: 'color',
};

/**
 * A `CellFormat` as an inline CSS declaration string, for the published page's
 * static HTML. Only known properties and already-validated values are emitted,
 * so nothing user-supplied reaches the attribute verbatim.
 */
export function cellFormatToInlineCss(format: CellFormat | undefined): string {
  const style = cellFormatToStyle(format);
  const declarations: string[] = [];

  for (const [property, value] of Object.entries(style)) {
    const cssName = CSS_PROPERTY_NAMES[property];
    // An unmapped property means someone added a style key without deciding how
    // it should be published; dropping it is safer than guessing.
    if (!cssName) continue;
    // Belt and braces: never emit a value carrying CSS-significant characters.
    if (/[;{}<>"']/.test(value)) continue;
    declarations.push(`${cssName}:${value}`);
  }

  return declarations.join(';');
}
