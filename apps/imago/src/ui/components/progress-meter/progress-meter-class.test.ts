import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  progressMeterBarClass,
  progressMeterClass,
  progressMeterCountClass,
} from './progress-meter-class';

describe('progressMeterClass', () => {
  test('the wrapper', () => {
    assert({
      given: 'the bar and its count',
      should: 'keep them on one line 8px apart without shrinking',
      actual: progressMeterClass,
      expected: 'flex flex-none items-center gap-2',
    });
  });
});

describe('progressMeterBarClass', () => {
  test('the bar', () => {
    assert({
      given: 'the native <progress> element',
      should: 'use the theme’s progress-meter utility (28 × 3px track, accent fill)',
      actual: progressMeterBarClass,
      expected: 'progress-meter',
    });
  });
});

describe('progressMeterCountClass', () => {
  test('the count', () => {
    assert({
      given: 'the "1/3" count beside the bar',
      should: 'set it in the smallest size, faint, with tabular figures',
      actual: progressMeterCountClass,
      expected: 'text-2xs text-ink-faint tabular-nums',
    });
  });
});
