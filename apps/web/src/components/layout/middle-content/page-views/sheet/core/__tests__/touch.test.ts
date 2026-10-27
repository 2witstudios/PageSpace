import { describe, it, expect } from 'vitest';
import {
  exceededMoveThreshold,
  isTapGesture,
  isDoubleTap,
  MOVE_THRESHOLD,
  TAP_MAX_DURATION,
  DOUBLE_TAP_WINDOW,
} from '../touch';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

describe('exceededMoveThreshold', () => {
  it('is false for a small movement', () => {
    assert({
      given: 'a point within the move threshold',
      should: 'not count as a move',
      actual: exceededMoveThreshold({ x: 100, y: 100 }, { x: 105, y: 103 }),
      expected: false,
    });
  });

  it('is true when the horizontal movement exceeds the threshold', () => {
    assert({
      given: 'a point moved horizontally past the threshold',
      should: 'count as a move',
      actual: exceededMoveThreshold({ x: 100, y: 100 }, { x: 100 + MOVE_THRESHOLD + 1, y: 100 }),
      expected: true,
    });
  });

  it('is true when the vertical movement exceeds the threshold', () => {
    assert({
      given: 'a point moved vertically past the threshold',
      should: 'count as a move',
      actual: exceededMoveThreshold({ x: 100, y: 100 }, { x: 100, y: 100 + MOVE_THRESHOLD + 1 }),
      expected: true,
    });
  });
});

describe('isTapGesture', () => {
  const start = { x: 100, y: 100, time: 1000 };

  it('is a tap for a quick, still touch', () => {
    assert({
      given: 'a short touch that barely moved',
      should: 'be a tap',
      actual: isTapGesture(start, { x: 102, y: 101 }, 1000 + TAP_MAX_DURATION - 1),
      expected: true,
    });
  });

  it('is not a tap when held too long', () => {
    assert({
      given: 'a touch held beyond the tap duration',
      should: 'not be a tap',
      actual: isTapGesture(start, { x: 100, y: 100 }, 1000 + TAP_MAX_DURATION + 1),
      expected: false,
    });
  });

  it('is not a tap when moved too far', () => {
    assert({
      given: 'a quick touch that moved past the threshold',
      should: 'not be a tap',
      actual: isTapGesture(start, { x: 100 + MOVE_THRESHOLD + 1, y: 100 }, 1010),
      expected: false,
    });
  });
});

describe('isDoubleTap', () => {
  it('is a double tap on the same cell within the window', () => {
    assert({
      given: 'a prior tap on the same cell within the double-tap window',
      should: 'be a double tap',
      actual: isDoubleTap({ row: 1, column: 2, time: 1000 }, { row: 1, column: 2 }, 1000 + DOUBLE_TAP_WINDOW - 1),
      expected: true,
    });
  });

  it('is not a double tap when there was no prior tap', () => {
    assert({
      given: 'no prior tap recorded',
      should: 'not be a double tap',
      actual: isDoubleTap(null, { row: 1, column: 2 }, 1200),
      expected: false,
    });
  });

  it('is not a double tap on a different cell', () => {
    assert({
      given: 'a prior tap on a different cell',
      should: 'not be a double tap',
      actual: isDoubleTap({ row: 0, column: 0, time: 1000 }, { row: 1, column: 2 }, 1100),
      expected: false,
    });
  });

  it('is not a double tap after the window has elapsed', () => {
    assert({
      given: 'a prior tap on the same cell but outside the window',
      should: 'not be a double tap',
      actual: isDoubleTap({ row: 1, column: 2, time: 1000 }, { row: 1, column: 2 }, 1000 + DOUBLE_TAP_WINDOW + 1),
      expected: false,
    });
  });
});
