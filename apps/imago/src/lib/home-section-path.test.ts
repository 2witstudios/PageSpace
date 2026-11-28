import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { homeSectionPath } from './home-section-path';

describe('homeSectionPath()', () => {
  test('an old link with no query', () => {
    assert({
      given: 'Home and the calendar section',
      should: 'land on Home’s calendar screen',
      actual: homeSectionPath('home1', 'calendar', {}),
      expected: '/home1/calendar/view',
    });
  });

  test('a section with a pane of its own', () => {
    assert({
      given: 'Home and the tasks and messages sections',
      should: 'land on the section’s pane, beside the chat',
      actual: [homeSectionPath('home1', 'tasks', {}), homeSectionPath('home1', 'messages', {})],
      expected: ['/home1/tasks', '/home1/messages'],
    });
  });

  test('an old link with a query', () => {
    assert({
      given: 'a bookmarked day view with a repeated filter',
      should: 'carry every parameter on to Home',
      actual: homeSectionPath('home1', 'calendar', { date: '2026-10-20', view: 'day', tag: ['a', 'b'], skip: undefined }),
      expected: '/home1/calendar/view?date=2026-10-20&view=day&tag=a&tag=b',
    });
  });
});
