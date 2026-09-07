import { describe, it, expect } from 'vitest';
import {
  MAX_REGIONS,
  MAX_REGION_COLUMNS,
  MAX_REGION_HEADER_ROWS,
  MAX_REGION_TOTAL_ROWS,
  parseRegion,
  parseRegionRange,
  parseRegions,
  resolveRegionRows,
  type SheetRegion,
} from '../sheets/regions';

const region = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'r1',
  range: 'A1:F',
  ...over,
});

describe('parseRegionRange', () => {
  it('parses a closed range', () => {
    expect(parseRegionRange('A1:F200')).toEqual({
      rowStart: 0,
      colStart: 0,
      colEnd: 5,
      rowEnd: 199,
    });
  });

  it('parses an open range, keeping the open end explicit', () => {
    // The whole point of the open form: nothing here bakes in a row count.
    expect(parseRegionRange('B2:D')).toEqual({
      rowStart: 1,
      colStart: 1,
      colEnd: 3,
      rowEnd: null,
    });
  });

  it('normalizes corners given in either order', () => {
    expect(parseRegionRange('F200:A1')).toEqual(parseRegionRange('A1:F200'));
    expect(parseRegionRange('f1:c')).toEqual({ rowStart: 0, colStart: 2, colEnd: 5, rowEnd: null });
  });

  it('rejects a bare cell, which would be a per-cell format in disguise', () => {
    expect(parseRegionRange('A1')).toBeNull();
  });

  it('rejects a truncated or malformed range', () => {
    expect(parseRegionRange('A1:')).toBeNull();
    expect(parseRegionRange(':F2')).toBeNull();
    expect(parseRegionRange('A1:B2:C3')).toBeNull();
    expect(parseRegionRange('1:5')).toBeNull();
    // An end that is neither plain column letters nor a cell address: the
    // column-only branch declines it and decoding it as a cell throws.
    expect(parseRegionRange('A1:F2X')).toBeNull();
    expect(parseRegionRange('A1:$F$2')).toBeNull();
    expect(parseRegionRange('')).toBeNull();
    // Exported, so it is reachable with a non-string from untyped jsonb.
    expect(parseRegionRange(null as unknown as string)).toBeNull();
    expect(parseRegionRange(undefined as unknown as string)).toBeNull();
  });

  it('rejects a range past the addressable grid', () => {
    // Guarded here rather than left to the consumer: a region is stored as a
    // string, so an absurd bound would otherwise only fail once something tried
    // to iterate it.
    expect(parseRegionRange('A1:C9999999999')).toBeNull();
    expect(parseRegionRange('A9999999999:C1')).toBeNull();
    // Past ZZZ on either corner.
    expect(parseRegionRange('AAAAA1:B2')).toBeNull();
    expect(parseRegionRange('A1:AAAAA2')).toBeNull();
  });

  it('rejects a span wider than the column cap', () => {
    expect(parseRegionRange(`A1:${'A'.repeat(1)}1`)).not.toBeNull();
    // AAA is column 703; well past MAX_REGION_COLUMNS from column A.
    expect(parseRegionRange('A1:AAA')).toBeNull();
    expect(MAX_REGION_COLUMNS).toBe(256);
  });
});

describe('resolveRegionRows', () => {
  it('closes an open region against the declared extent', () => {
    const bounds = parseRegionRange('A1:F')!;
    expect(resolveRegionRows(bounds, 20)).toEqual({ rowStart: 0, rowEnd: 19 });
    // Growing the sheet extends the region with no rewrite — the row-append
    // property this model exists for.
    expect(resolveRegionRows(bounds, 5000)).toEqual({ rowStart: 0, rowEnd: 4999 });
  });

  it('uses the declared extent, not the data', () => {
    // A sheet whose trailing rows are empty still has those rows, so a region
    // covering them must not shrink when a cell is cleared.
    const bounds = parseRegionRange('A2:C')!;
    expect(resolveRegionRows(bounds, 100).rowEnd).toBe(99);
  });

  it('leaves a closed region alone regardless of extent', () => {
    const bounds = parseRegionRange('A1:F10')!;
    expect(resolveRegionRows(bounds, 5000)).toEqual({ rowStart: 0, rowEnd: 9 });
  });

  it('never returns an end above its start on a degenerate extent', () => {
    const bounds = parseRegionRange('A9:C')!;
    expect(resolveRegionRows(bounds, 1)).toEqual({ rowStart: 8, rowEnd: 8 });
  });
});

describe('parseRegion', () => {
  it('accepts a minimal region', () => {
    expect(parseRegion(region())).toEqual({ id: 'r1', range: 'A1:F' });
  });

  it('rejects a region with no usable id or range', () => {
    expect(parseRegion(region({ id: '' }))).toBeNull();
    expect(parseRegion(region({ id: 7 }))).toBeNull();
    expect(parseRegion(region({ range: 'A1' }))).toBeNull();
    expect(parseRegion(region({ range: 42 }))).toBeNull();
    expect(parseRegion(null)).toBeNull();
    expect(parseRegion([])).toBeNull();
  });

  it('normalizes the range so a round trip is stable', () => {
    expect(parseRegion(region({ range: ' a1:f ' }))?.range).toBe('A1:F');
  });

  it('carries unknown fields through untouched', () => {
    // A region written by a newer build must survive a load/save cycle rather
    // than being silently downgraded.
    const parsed = parseRegion(region({ sparkline: { column: 'G' }, futureFlag: true }));
    expect(parsed).toMatchObject({ sparkline: { column: 'G' }, futureFlag: true });
  });

  it('keeps a name and a theme, trimmed and normalized', () => {
    const parsed = parseRegion(region({ name: '  Q3 Budget  ', theme: ' Blue ' }));
    expect(parsed?.name).toBe('Q3 Budget');
    expect(parsed?.theme).toBe('blue');
  });

  it('bounds a name rather than storing an essay', () => {
    expect(parseRegion(region({ name: 'x'.repeat(500) }))?.name).toHaveLength(200);
  });

  it('drops a blank name and a theme that is not a plain hue token', () => {
    expect(parseRegion(region({ name: '   ' }))?.name).toBeUndefined();
    expect(parseRegion(region({ theme: 'blue-500' }))?.theme).toBeUndefined();
    expect(parseRegion(region({ theme: '#3b82f6' }))?.theme).toBeUndefined();
  });

  it('keeps freezeHeader only when it is actually a boolean', () => {
    expect(parseRegion(region({ freezeHeader: true }))?.freezeHeader).toBe(true);
    expect(parseRegion(region({ freezeHeader: 'yes' }))?.freezeHeader).toBeUndefined();
  });

  it('drops an unusable optional field without rejecting the region', () => {
    const parsed = parseRegion(
      region({ headerRows: 'two', totalRows: 'no', columns: 'nope', theme: 12 })
    );
    expect(parsed).toEqual({ id: 'r1', range: 'A1:F' });
  });

  it('rejects a header band taller than a closed region', () => {
    expect(parseRegion(region({ range: 'A1:F3', headerRows: 9 }))?.headerRows).toBeUndefined();
    expect(parseRegion(region({ range: 'A1:F3', headerRows: 3 }))?.headerRows).toBe(3);
    // An open region has no height to exceed.
    expect(parseRegion(region({ range: 'A1:F', headerRows: MAX_REGION_HEADER_ROWS }))?.headerRows)
      .toBe(MAX_REGION_HEADER_ROWS);
    expect(
      parseRegion(region({ range: 'A1:F', headerRows: MAX_REGION_HEADER_ROWS + 1 }))?.headerRows
    ).toBeUndefined();
  });

  it('accepts headerRows of 0 for a headerless table', () => {
    expect(parseRegion(region({ headerRows: 0 }))?.headerRows).toBe(0);
  });

  it('validates, dedupes and sorts total rows', () => {
    expect(parseRegion(region({ totalRows: [12, 4, 12, 0, -3, 1.5, 'x'] }))?.totalRows).toEqual([
      4, 12,
    ]);
  });

  it('bounds how many total rows it will take', () => {
    const many = Array.from({ length: MAX_REGION_TOTAL_ROWS + 40 }, (_, i) => i + 1);
    expect(parseRegion(region({ totalRows: many }))?.totalRows).toHaveLength(
      MAX_REGION_TOTAL_ROWS
    );
  });

  it('validates column roles and normalizes the letters', () => {
    const parsed = parseRegion(
      region({
        columns: [
          { column: ' c ', role: 'currency', currency: 'usd' },
          { column: 'E', role: 'percent', decimals: 1 },
          { column: 'F', role: 'bogus' },
          { column: '3', role: 'text' },
          { column: 'G' },
          { column: 5, role: 'text' },
          'nope',
        ],
      })
    );
    expect(parsed?.columns).toEqual([
      { column: 'C', role: 'currency', currency: 'USD' },
      { column: 'E', role: 'percent', decimals: 1 },
    ]);
  });

  it('drops a currency code that is not three letters', () => {
    // Anything else would reach Intl.NumberFormat and throw at render time,
    // far from here.
    const parsed = parseRegion(
      region({ columns: [{ column: 'A', role: 'currency', currency: 'DOLLARS' }] })
    );
    expect(parsed?.columns?.[0]).toEqual({ column: 'A', role: 'currency' });
  });

  it('rejects out-of-range decimals rather than clamping them', () => {
    const parsed = parseRegion(region({ columns: [{ column: 'A', role: 'number', decimals: 99 }] }));
    expect(parsed?.columns?.[0].decimals).toBeUndefined();
  });

  it('lets the last declaration of a column win', () => {
    const parsed = parseRegion(
      region({
        columns: [
          { column: 'A', role: 'text' },
          { column: 'A', role: 'currency' },
        ],
      })
    );
    expect(parsed?.columns).toEqual([{ column: 'A', role: 'currency' }]);
  });

  it('keeps unknown fields on a column too', () => {
    const parsed = parseRegion(
      region({ columns: [{ column: 'A', role: 'number', unitLabel: 'kg' }] })
    );
    expect(parsed?.columns?.[0]).toMatchObject({ column: 'A', role: 'number', unitLabel: 'kg' });
  });
});

describe('parseRegions', () => {
  it('reads the array form', () => {
    const parsed = parseRegions([region(), region({ id: 'r2', range: 'H1:J9' })]);
    expect(parsed?.map((r: SheetRegion) => r.id)).toEqual(['r1', 'r2']);
  });

  it('reads the numerically keyed map form the TOML bag uses, in index order', () => {
    const parsed = parseRegions({
      '1': region({ id: 'second' }),
      '0': region({ id: 'first' }),
      '10': region({ id: 'third' }),
    });
    expect(parsed?.map((r: SheetRegion) => r.id)).toEqual(['first', 'second', 'third']);
  });

  it('returns undefined for a non-list and for an empty result', () => {
    expect(parseRegions(undefined)).toBeUndefined();
    expect(parseRegions('nope')).toBeUndefined();
    expect(parseRegions([])).toBeUndefined();
    expect(parseRegions([{ id: '', range: 'A1' }])).toBeUndefined();
  });

  it('drops invalid entries without dropping the valid ones around them', () => {
    const parsed = parseRegions([region({ id: 'a' }), { nope: true }, region({ id: 'b' })]);
    expect(parsed?.map((r: SheetRegion) => r.id)).toEqual(['a', 'b']);
  });

  it('keeps the first of a duplicated id so upsert stays unambiguous', () => {
    const parsed = parseRegions([
      region({ id: 'dup', range: 'A1:B9' }),
      region({ id: 'dup', range: 'C1:D9' }),
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0].range).toBe('A1:B9');
  });

  it('ignores inherited enumerable keys on the map form', () => {
    // `for...in` walks the prototype chain, so a polluted Object.prototype must
    // not become a region.
    const proto = { '0': region({ id: 'inherited' }) };
    const own = Object.create(proto) as Record<string, unknown>;
    own['1'] = region({ id: 'own' });
    const parsed = parseRegions(own);
    expect(parsed?.map((r: SheetRegion) => r.id)).toEqual(['own']);
  });

  it('caps how many regions it will collect', () => {
    const many = Array.from({ length: MAX_REGIONS + 25 }, (_, i) => region({ id: `r${i}` }));
    expect(parseRegions(many)).toHaveLength(MAX_REGIONS);
  });

  it('stops enumerating a hostile map instead of walking every key', () => {
    const hostile: Record<string, unknown> = {};
    for (let i = 0; i < 5_000; i++) hostile[String(i)] = region({ id: `r${i}` });
    expect(parseRegions(hostile)).toHaveLength(MAX_REGIONS);
  });
});
