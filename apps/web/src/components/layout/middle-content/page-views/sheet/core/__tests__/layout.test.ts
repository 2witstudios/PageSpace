import { describe, it, expect } from 'vitest';
import {
  isMobileWidth,
  computeEditorPosition,
} from '../layout';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const viewport = (width: number, height: number) => ({ width, height });

describe('isMobileWidth', () => {
  it('uses the container width when provided (mobile)', () => {
    assert({
      given: 'a container width below 640',
      should: 'be mobile regardless of the viewport width',
      actual: isMobileWidth(500, 2000),
      expected: true,
    });
  });

  it('uses the container width when provided (desktop)', () => {
    assert({
      given: 'a container width at/above 640',
      should: 'not be mobile even with a small viewport',
      actual: isMobileWidth(800, 300),
      expected: false,
    });
  });

  it('falls back to the viewport width when the container width is undefined', () => {
    assert({
      given: 'no measured container width and a narrow viewport',
      should: 'fall back to the viewport width (mobile)',
      actual: isMobileWidth(undefined, 375),
      expected: true,
    });
  });

  it('falls back to the viewport width when the container width is undefined (desktop)', () => {
    assert({
      given: 'no measured container width and a wide viewport',
      should: 'fall back to the viewport width (desktop)',
      actual: isMobileWidth(undefined, 1280),
      expected: false,
    });
  });
});

describe('computeEditorPosition', () => {
  const cell = { top: 100, left: 50, width: 120, height: 30 };

  it('positions the editor at the cell on desktop with no keyboard', () => {
    assert({
      given: 'a desktop editor with no on-screen keyboard',
      should: 'sit exactly over the cell, min width 120',
      actual: computeEditorPosition(cell, 0, { height: 800 }, false),
      expected: { left: 50, top: 100, width: 120, height: 30 },
    });
  });

  it('applies the mobile minimums', () => {
    assert({
      given: 'a mobile editor over a small cell',
      should: 'apply minWidth 100 and minHeight 36',
      actual: computeEditorPosition({ top: 100, left: 50, width: 40, height: 20 }, 0, { height: 800 }, true),
      expected: { left: 50, top: 100, width: 100, height: 36 },
    });
  });

  it('moves the editor above the keyboard when it would be occluded', () => {
    // viewport 800, keyboard 400 -> available 400; cell bottom 700 > 380 -> lift up
    const result = computeEditorPosition({ top: 670, left: 50, width: 120, height: 30 }, 400, { height: 800 }, false);
    assert({
      given: 'a cell that would sit behind the keyboard',
      should: 'lift the editor to available - height - 20',
      actual: result.top,
      expected: 400 - 30 - 20,
    });
  });

  it('never lifts the editor above the top padding of 20', () => {
    // available tiny so adjustedTop would go negative -> clamp to 20
    const result = computeEditorPosition({ top: 670, left: 50, width: 120, height: 30 }, 780, { height: 800 }, false);
    assert({
      given: 'a keyboard so tall the lift would push the editor off-screen',
      should: 'clamp the top to 20',
      actual: result.top,
      expected: 20,
    });
  });

  it('does not adjust when the keyboard does not occlude the cell', () => {
    assert({
      given: 'a keyboard present but the cell sits above it',
      should: 'leave the top at the cell top',
      actual: computeEditorPosition({ top: 100, left: 50, width: 120, height: 30 }, 200, { height: 800 }, false).top,
      expected: 100,
    });
  });
});
