import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { floatsOver, tierFor, tierFromMatches, tierQueries } from './viewport-tier';

describe('tierFor()', () => {
  test('the boundaries of every tier', () => {
    assert({
      given: 'widths either side of 600, 1024 and 1280',
      should: 'name phone, narrow, overlay and desktop',
      actual: [320, 599, 600, 1023, 1024, 1279, 1280, 1920].map(tierFor),
      expected: ['phone', 'phone', 'narrow', 'narrow', 'overlay', 'overlay', 'desktop', 'desktop'],
    });
  });
});

describe('tierFromMatches()', () => {
  test('the first matching query wins, none is desktop', () => {
    assert({
      given: 'the phone, narrow and overlay queries',
      should: 'pick the narrowest match',
      actual: [
        tierFromMatches([true, true, true]),
        tierFromMatches([false, true, true]),
        tierFromMatches([false, false, true]),
        tierFromMatches([false, false, false]),
        tierFromMatches([]),
      ],
      expected: ['phone', 'narrow', 'overlay', 'desktop', 'desktop'],
    });
  });

  test('three queries, one per boundary', () => {
    assert({ given: 'the tier queries', should: 'be phone, narrow and overlay', actual: tierQueries.length, expected: 3 });
  });
});

describe('floatsOver()', () => {
  test('only desktop docks', () => {
    assert({
      given: 'every tier',
      should: 'float Imago below 1280',
      actual: (['desktop', 'overlay', 'narrow', 'phone'] as const).map(floatsOver),
      expected: [false, true, true, true],
    });
  });
});
