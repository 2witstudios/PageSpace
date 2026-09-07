import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REGION_THEME,
  columnRoleFormat,
  regionTheme,
} from '../sheets/region-format';
import { PALETTE } from '../sheets/palette';
import { applyNumberFormat, readableTextColor } from '../sheets/format';
import type { ColumnRole, RegionColumn } from '../sheets/regions';

const col = (role: ColumnRole, over: Partial<RegionColumn> = {}): RegionColumn => ({
  column: 'A',
  role,
  ...over,
});

describe('columnRoleFormat', () => {
  it('renders money as money', () => {
    const format = columnRoleFormat(col('currency'));
    expect(format.number).toEqual({ kind: 'currency', currency: 'USD', thousands: true, decimals: 2 });
    // The point of the role: the stored value stays a number and only its
    // display changes.
    expect(applyNumberFormat(1200, format.number)).toBe('$1,200.00');
  });

  it('honours a declared currency and precision', () => {
    const format = columnRoleFormat(col('currency', { currency: 'EUR', decimals: 0 }));
    expect(format.number).toMatchObject({ currency: 'EUR', decimals: 0 });
  });

  it('gives a bare number column no forced precision', () => {
    // The engine's `number` kind defaults to 2 decimals, which would render a
    // column of counts as "12.00"; defaulting to 0 would round 3.7 to 4.
    // `auto` returns null from applyNumberFormat, i.e. "render it as it is".
    const format = columnRoleFormat(col('number'));
    expect(format.number).toEqual({ kind: 'auto' });
    expect(applyNumberFormat(12, format.number)).toBeNull();
    expect(applyNumberFormat(3.7, format.number)).toBeNull();
  });

  it('takes an explicit precision on a number column, with grouping', () => {
    const format = columnRoleFormat(col('number', { decimals: 3 }));
    expect(format.number).toEqual({ kind: 'number', thousands: true, decimals: 3 });
    expect(applyNumberFormat(1234.5, format.number)).toBe('1,234.500');
  });

  it('groups thousands once a precision is declared', () => {
    expect(applyNumberFormat(1234567, columnRoleFormat(col('number', { decimals: 0 })).number)).toBe(
      '1,234,567'
    );
  });

  it('renders a percent from the stored ratio', () => {
    const format = columnRoleFormat(col('percent'));
    expect(applyNumberFormat(0.85, format.number)).toBe('85.0%');
  });

  it('treats an id as text in monospace, not as a number', () => {
    // Grouping an identifier's digits, or dropping its leading zero, makes it a
    // different identifier.
    const format = columnRoleFormat(col('id'));
    expect(format.number).toEqual({ kind: 'text' });
    expect(format.fontFamily).toBe('mono');
  });

  it('leaves text alone', () => {
    expect(columnRoleFormat(col('text'))).toEqual({});
  });

  it('formats dates and datetimes', () => {
    expect(columnRoleFormat(col('date')).number).toEqual({ kind: 'date', dateStyle: 'medium' });
    expect(columnRoleFormat(col('datetime')).number).toEqual({
      kind: 'datetime',
      dateStyle: 'medium',
    });
  });

  it('never emits alignment, which the grid decides', () => {
    // Storing it would duplicate a renderer decision and then fight it.
    const roles: ColumnRole[] = ['text', 'number', 'currency', 'percent', 'date', 'datetime', 'id'];
    for (const role of roles) {
      const format = columnRoleFormat(col(role));
      expect(format.align).toBeUndefined();
      expect(format.valign).toBeUndefined();
    }
  });
});

describe('regionTheme', () => {
  it('bolds and fills the header from the named hue', () => {
    const blue = PALETTE.find((hue) => hue.name === 'blue')!;
    const theme = regionTheme('blue');
    expect(theme.hue.name).toBe('blue');
    expect(theme.header).toMatchObject({ bold: true, background: blue.deep });
    expect(theme.total).toMatchObject({ bold: true, background: blue.tint });
  });

  it('gives every fill an explicit readable text colour', () => {
    // A stored fill is absolute and does not re-tint in dark mode, so a pale
    // total-row fill left to inherit the theme's text colour renders
    // near-white on near-white. This is the assertion that catches that.
    for (const hue of PALETTE) {
      const theme = regionTheme(hue.name);
      expect(theme.header.color).toBe(readableTextColor(hue.deep));
      expect(theme.total.color).toBe(readableTextColor(hue.tint));
      expect(theme.header.color).toBeDefined();
      expect(theme.total.color).toBeDefined();
    }
  });

  it('falls back rather than refusing to render an unknown hue', () => {
    // A region may name a hue an older or newer palette had.
    const fallback = regionTheme(DEFAULT_REGION_THEME);
    expect(regionTheme('chartreuse')).toEqual(fallback);
    expect(regionTheme(undefined)).toEqual(fallback);
    expect(regionTheme('')).toEqual(fallback);
  });

  it('defaults to a hue the palette actually has', () => {
    expect(PALETTE.some((hue) => hue.name === DEFAULT_REGION_THEME)).toBe(true);
    // Pinned so a palette reorder is a deliberate change of default, not an
    // accidental one.
    expect(DEFAULT_REGION_THEME).toBe('slate');
  });
});
