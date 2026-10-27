import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REGION_THEME,
  columnRoleFormat,
  createRegionResolver,
  regionTheme,
} from '../sheets/region-format';
import { PALETTE } from '../sheets/palette';
import { applyNumberFormat, readableTextColor } from '../sheets/format';
import type { ColumnRole, RegionColumn, SheetRegion } from '../sheets/regions';

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

describe('createRegionResolver', () => {
  const budget = (over: Partial<SheetRegion> = {}): SheetRegion => ({
    id: 'r1',
    range: 'A1:D',
    headerRows: 1,
    theme: 'blue',
    columns: [
      { column: 'B', role: 'currency' },
      { column: 'C', role: 'percent' },
    ],
    totalRows: [5],
    ...over,
  });

  it('returns nothing when there are no regions', () => {
    expect(createRegionResolver(undefined, 100)(0, 0)).toBeUndefined();
    expect(createRegionResolver([], 100)(0, 0)).toBeUndefined();
  });

  it('formats the header band from the theme, without the column role', () => {
    // A currency format on the word "Revenue" describes nothing.
    const at = createRegionResolver([budget()], 50);
    expect(at(0, 1)).toEqual(regionTheme('blue').header);
    expect(at(0, 1)?.number).toBeUndefined();
  });

  it('applies the column role to body cells', () => {
    const at = createRegionResolver([budget()], 50);
    expect(at(1, 1)).toEqual(columnRoleFormat({ column: 'B', role: 'currency' }));
    expect(at(1, 2)).toEqual(columnRoleFormat({ column: 'C', role: 'percent' }));
  });

  it('leaves an undeclared column inside the region unformatted', () => {
    const at = createRegionResolver([budget()], 50);
    expect(at(1, 0)).toBeUndefined();
  });

  it('layers total emphasis over the column role, keeping the role', () => {
    // A total IS data — dropping its currency format would make the one row
    // that matters most read differently from the column above it.
    const at = createRegionResolver([budget()], 50);
    const total = at(4, 1)!;
    expect(total.number).toEqual(columnRoleFormat({ column: 'B', role: 'currency' }).number);
    expect(total.bold).toBe(true);
    expect(total.background).toBe(regionTheme('blue').total.background);
  });

  it('reads total rows as the 1-based numbers a person declares', () => {
    const at = createRegionResolver([budget({ totalRows: [5] })], 50);
    expect(at(4, 1)?.bold).toBe(true);
    expect(at(5, 1)?.bold).toBeUndefined();
  });

  it('covers rows that did not exist when the region was declared', () => {
    // The row-append property: an open region reaches whatever the sheet grew to.
    const at20 = createRegionResolver([budget()], 20);
    const at5000 = createRegionResolver([budget()], 5000);
    expect(at20(4999, 1)).toBeUndefined();
    expect(at5000(4999, 1)).toEqual(columnRoleFormat({ column: 'B', role: 'currency' }));
  });

  it('stops at the region bounds', () => {
    const at = createRegionResolver([budget({ range: 'B2:C10' })], 50);
    expect(at(1, 0)).toBeUndefined();
    expect(at(1, 3)).toBeUndefined();
    expect(at(0, 1)).toBeUndefined();
    expect(at(10, 1)).toBeUndefined();
    expect(at(1, 1)).toBeDefined();
  });

  it('lets a later region layer over an earlier one where they overlap', () => {
    const at = createRegionResolver(
      [
        budget({ id: 'a', theme: 'blue', columns: [{ column: 'B', role: 'currency' }] }),
        budget({ id: 'b', theme: 'red', headerRows: 1 }),
      ],
      50
    );
    expect(at(0, 1)?.background).toBe(regionTheme('red').header.background);
  });

  it('honours headerRows of 0 and a multi-row header band', () => {
    const none = createRegionResolver([budget({ headerRows: 0 })], 50);
    expect(none(0, 1)).toEqual(columnRoleFormat({ column: 'B', role: 'currency' }));

    const deep = createRegionResolver([budget({ headerRows: 3 })], 50);
    expect(deep(2, 1)).toEqual(regionTheme('blue').header);
    expect(deep(3, 1)).toEqual(columnRoleFormat({ column: 'B', role: 'currency' }));
  });

  it('defaults to a single header row when none is declared', () => {
    const at = createRegionResolver([{ id: 'r', range: 'A1:D', columns: [{ column: 'A', role: 'number', decimals: 0 }] }], 50);
    expect(at(0, 0)?.bold).toBe(true);
    expect(at(1, 0)?.bold).toBeUndefined();
  });

  it('still themes a region that declares no columns at all', () => {
    // Declaring only the shape of a table — header band, accent — is a complete
    // and useful thing to say about it.
    const at = createRegionResolver([{ id: 'r', range: 'A1:C', theme: 'green' }], 20);
    expect(at(0, 0)).toEqual(regionTheme('green').header);
    expect(at(1, 0)).toBeUndefined();
  });

  it('skips a malformed column label instead of aborting the whole sheet', () => {
    // `evaluateSheet` takes a SheetData directly, so a region that never went
    // through `parseRegion` can carry a label `decodeColumnLabel` would throw
    // on. Losing one column's styling beats losing the sheet.
    const at = createRegionResolver(
      [
        {
          id: 'r',
          range: 'A1:D',
          headerRows: 0,
          columns: [
            { column: '', role: 'currency' },
            { column: 'B1', role: 'currency' },
            { column: 'C', role: 'currency' },
          ],
        },
      ],
      20
    );
    expect(() => at(1, 0)).not.toThrow();
    expect(at(1, 0)).toBeUndefined();
    expect(at(1, 2)).toEqual(columnRoleFormat({ column: 'C', role: 'currency' }));
  });

  it('drops a region whose range cannot be located rather than failing the sheet', () => {
    const at = createRegionResolver([{ id: 'bad', range: 'nonsense' }, budget()], 50);
    expect(at(1, 1)).toEqual(columnRoleFormat({ column: 'B', role: 'currency' }));
  });

  it('returns nothing when every region is unusable', () => {
    expect(createRegionResolver([{ id: 'bad', range: 'nonsense' }], 50)(0, 0)).toBeUndefined();
  });

  it('does not pay a spread for a text column, which formats nothing', () => {
    const at = createRegionResolver(
      [budget({ columns: [{ column: 'B', role: 'text' }], headerRows: 0, totalRows: [] })],
      50
    );
    expect(at(1, 1)).toBeUndefined();
  });
});
