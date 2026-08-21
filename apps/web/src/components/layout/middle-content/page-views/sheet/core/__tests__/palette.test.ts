import { describe, it, expect } from 'vitest';
import {
  NEUTRALS,
  PALETTE,
  normalizeHex,
  parseHex,
  readableTextColor,
  relativeLuminance,
  swatchRow,
} from '../palette';
import { isValidHexColor } from '@pagespace/lib/sheets/sheet';

describe('palette', () => {
  it('offers the same twelve hues the rest of the product uses', () => {
    expect(PALETTE.map((hue) => hue.name)).toEqual([
      'slate', 'blue', 'cyan', 'teal', 'green', 'amber',
      'orange', 'red', 'pink', 'purple', 'violet', 'indigo',
    ]);
  });

  it('only contains colours the CellFormat schema will accept', () => {
    // A swatch the model rejects is a button that silently does nothing, so
    // this asserts against the lib's own validator rather than a local regex.
    const every = [
      ...PALETTE.flatMap((hue) => [hue.tint, hue.mid, hue.deep]),
      ...NEUTRALS,
    ];
    for (const color of every) {
      expect(isValidHexColor(color), `${color} rejected by the format schema`).toBe(true);
    }
  });

  it('returns one swatch per hue for a strength', () => {
    expect(swatchRow('tint')).toHaveLength(PALETTE.length);
    expect(swatchRow('mid')[1]).toBe('#3b82f6');
  });
});

describe('parseHex / normalizeHex', () => {
  it('parses the long form', () => {
    expect(parseHex('#3b82f6')).toEqual({ r: 0x3b, g: 0x82, b: 0xf6 });
  });

  it('expands the short form people actually type', () => {
    expect(parseHex('#f00')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('is case- and whitespace-insensitive', () => {
    expect(parseHex('  #FFAA00 ')).toEqual({ r: 255, g: 170, b: 0 });
  });

  it.each(['red', 'rgb(1,2,3)', '#12345', 'javascript:alert(1)', '', '#'])(
    'rejects %j',
    (value) => {
      expect(parseHex(value)).toBeNull();
      expect(normalizeHex(value)).toBeNull();
    },
  );

  it('normalises to the #rrggbb the model stores', () => {
    expect(normalizeHex('#F00')).toBe('#ff0000');
    expect(normalizeHex('3b82f6')).toBe('#3b82f6');
  });

  it('normalises anything it accepts into something the schema accepts', () => {
    expect(isValidHexColor(normalizeHex('#abc'))).toBe(true);
  });
});

describe('readableTextColor', () => {
  it('puts dark text on a pale fill', () => {
    expect(readableTextColor('#ffffff')).toBe('#000000');
    expect(readableTextColor('#fef3c7')).toBe('#000000');
  });

  it('puts light text on a deep fill', () => {
    expect(readableTextColor('#000000')).toBe('#ffffff');
    expect(readableTextColor('#1d4ed8')).toBe('#ffffff');
  });

  it('keeps every palette tint on dark text and every deep shade on light text', () => {
    // The guarantee the swatch grid depends on: a tick mark is visible on
    // every swatch we render, in both rows.
    for (const hue of PALETTE) {
      expect(readableTextColor(hue.tint), `${hue.name} tint`).toBe('#000000');
      expect(readableTextColor(hue.deep), `${hue.name} deep`).toBe('#ffffff');
    }
  });

  it('falls back to dark text for an unparseable colour rather than throwing', () => {
    expect(readableTextColor('nonsense')).toBe('#000000');
    expect(relativeLuminance('nonsense')).toBe(1);
  });
});
