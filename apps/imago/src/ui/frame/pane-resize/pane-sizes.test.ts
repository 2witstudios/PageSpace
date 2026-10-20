import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  BOUNDS,
  NO_SIZES,
  clampWidth,
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
