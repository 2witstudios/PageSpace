import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  BOUNDS,
  NO_SIZES,
  TOKEN_WIDTHS,
  clampWidth,
  dockedColumns,
  fitWidths,
  maxWidthFor,
  parseSizes,
  serializeSizes,
  widthFromDrag,
  widthFromKey,
} from './pane-sizes';

describe('parseSizes()', () => {
  test('nothing stored', () => {
    assert({
      given: 'no stored value',
      should: 'use the token widths',
      actual: parseSizes(null),
      expected: NO_SIZES,
    });
  });

  test('a stored pair round-trips', () => {
    assert({
      given: 'sizes written by serializeSizes',
      should: 'read them back',
      actual: parseSizes(serializeSizes({ left: 320, imago: 480 })),
      expected: { left: 320, imago: 480 },
    });
  });

  test('junk and out-of-range values', () => {
    assert({
      given: 'malformed JSON, a non-object, a string width and widths past the bounds',
      should: 'drop what is not a width and clamp what is',
      actual: [
        parseSizes('{nope'),
        parseSizes('42'),
        parseSizes('{"left":"300","imago":null}'),
        parseSizes('{"left":10,"imago":9000}'),
      ],
      expected: [NO_SIZES, NO_SIZES, NO_SIZES, { left: BOUNDS.left.min, imago: BOUNDS.imago.max }],
    });
  });
});

describe('maxWidthFor() and clampWidth()', () => {
  test('the middle keeps its minimum', () => {
    assert({
      given: 'a 300px left pane beside a 500px middle',
      should: 'let the pane grow only by what the middle has above 400px',
      actual: maxWidthFor('left', 300, 500),
      expected: 400,
    });
  });

  test('the hard maximum wins over a wide middle', () => {
    assert({
      given: 'a wide middle',
      should: 'stop at the column maximum',
      actual: maxWidthFor('imago', 360, 2000),
      expected: BOUNDS.imago.max,
    });
  });

  test('a cramped middle never pushes the maximum under the minimum', () => {
    assert({
      given: 'a middle already under 400px',
      should: 'still allow the column minimum',
      actual: maxWidthFor('left', 260, 100),
      expected: BOUNDS.left.min,
    });
  });

  test('clampWidth', () => {
    assert({
      given: 'widths below, inside and above the range',
      should: 'pin them to it, rounded',
      actual: [clampWidth('left', 50, 400), clampWidth('left', 333.6, 400), clampWidth('left', 900, 400)],
      expected: [BOUNDS.left.min, 334, 400],
    });
  });
});

describe('widthFromDrag() and widthFromKey()', () => {
  test('the drag direction follows the edge', () => {
    assert({
      given: 'the pointer moved 40px right',
      should: 'grow the left pane and shrink Imago',
      actual: [widthFromDrag('left', 300, 40), widthFromDrag('imago', 360, 40)],
      expected: [340, 320],
    });
  });

  test('keys', () => {
    assert({
      given: 'the arrow, Shift+arrow, Home, End and an unrelated key',
      should: 'step the seam, jump to the bounds, or ignore the key',
      actual: [
        widthFromKey('left', 'ArrowRight', false, 300, 480),
        widthFromKey('imago', 'ArrowLeft', true, 360, 720),
        widthFromKey('left', 'Home', false, 300, 480),
        widthFromKey('imago', 'End', false, 360, 600),
        widthFromKey('left', 'Enter', false, 300, 480),
      ],
      expected: [316, 424, BOUNDS.left.min, 600, null],
    });
  });
});

describe('fitWidths()', () => {
  test('room to spare', () => {
    assert({
      given: 'a 300px pane and 360px Imago in a 1400px row',
      should: 'keep both',
      actual: fitWidths(1400, { left: 300, imago: 360 }),
      expected: { left: 300, imago: 360 },
    });
  });

  test('a saved pair that would squeeze the middle', () => {
    assert({
      given: 'a 480px pane and 720px Imago, saved apart, opened together in a 1208px row',
      should: 'shrink Imago first, then the pane, until the middle has 400px',
      actual: [fitWidths(1208, { left: 480, imago: 720 }), fitWidths(1000, { left: 480, imago: 720 })],
      expected: [
        { left: 480, imago: 328 },
        { left: 300, imago: 300 },
      ],
    });
  });

  test('neither goes below its minimum', () => {
    assert({
      given: 'a row too narrow for both minimums and the middle',
      should: 'stop at the minimums',
      actual: fitWidths(700, { left: 300, imago: 360 }),
      expected: { left: BOUNDS.left.min, imago: BOUNDS.imago.min },
    });
  });

  test('an undocked column and an unmeasured row', () => {
    assert({
      given: 'Imago not docked, then no measurement yet',
      should: 'fit only the pane, then change nothing',
      actual: [fitWidths(800, { left: 480, imago: null }), fitWidths(null, { left: 480, imago: 720 })],
      expected: [{ left: 400, imago: null }, { left: 480, imago: 720 }],
    });
  });
});

describe('dockedColumns()', () => {
  const tokens = { left: 260, imago: 360 };

  test('token widths that fit stay classes', () => {
    assert({
      given: 'nothing saved in a wide row',
      should: 'draw both at their tokens with no px width over the class',
      actual: dockedColumns(NO_SIZES, 1400, tokens),
      expected: { left: { width: 260, size: undefined, max: 480 }, imago: { width: 360, size: undefined, max: 720 } },
    });
  });

  test('saved widths and squeezed tokens are px widths', () => {
    assert({
      given: 'a saved sidebar width, then tokens in a row too narrow for them',
      should: 'draw the saved width, then the fitted widths, over the classes, each seam capped by what the middle can spare',
      actual: [dockedColumns({ left: 320, imago: null }, 1400, tokens), dockedColumns(NO_SIZES, 900, tokens)],
      expected: [
        { left: { width: 320, size: 320, max: 480 }, imago: { width: 360, size: undefined, max: 680 } },
        { left: { width: 200, size: 200, max: 200 }, imago: { width: 300, size: 300, max: 300 } },
      ],
    });
  });

  test('a column that is not docked', () => {
    assert({
      given: 'Imago not docked',
      should: 'leave it out, whatever was saved for it',
      actual: dockedColumns({ left: null, imago: 500 }, 1400, { left: 260, imago: null }).imago,
      expected: null,
    });
  });
});

describe('TOKEN_WIDTHS', () => {
  test('mirrors the theme', () => {
    const theme = ['frame.css', 'v3.css'].map((file) => readFileSync(join(__dirname, '../../../app/theme', file), 'utf8')).join('\n');
    const token = (name: string) => Number(new RegExp(`--spacing-${name}:\\s*(\\d+)px`).exec(theme)?.[1]);
    assert({
      given: 'the px widths the seams start from',
      should: 'equal the pane width tokens in frame.css and v3.css',
      actual: TOKEN_WIDTHS,
      expected: {
        listPane: token('list-pane'),
        treePane: token('tree-pane'),
        paneOverlay: token('pane-overlay'),
        chatPane: token('chat-pane'),
      },
    });
  });
});
