import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { homeSectionPath } from './home-section-path';

describe('homeSectionPath()', () => {
  test('an old link with no query', () => {
    assert({
      given: 'Home and the calendar section',
      should: 'land on Home’s calendar',
      actual: homeSectionPath('home1', 'calendar', {}),
      expected: '/home1/calendar',
    });
  });

  test('an old link with a query', () => {
    assert({
      given: 'a bookmarked day view with a repeated filter',
      should: 'carry every parameter on to Home',
      actual: homeSectionPath('home1', 'calendar', { date: '2026-10-20', view: 'day', tag: ['a', 'b'], skip: undefined }),
      expected: '/home1/calendar?date=2026-10-20&view=day&tag=a&tag=b',
    });
  });
});
