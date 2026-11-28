import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { NOTIFICATION_COUNT, notificationCount } from './notification-count';

describe('notificationCount() (IMC-1.4)', () => {
  test('the unread count', () => {
    assert({
      given: "apps/web's countOnly body",
      should: 'read the unread count',
      actual: notificationCount({ count: 3 }),
      expected: 3,
    });
  });

  test('anything that is not a count', () => {
    assert({
      given: 'nothing loaded, an error body, a negative or fractional count',
      should: 'show no badge rather than a wrong number',
      actual: [undefined, { error: 'x' }, { count: -1 }, { count: 1.5 }, null].map(notificationCount),
      expected: [0, 0, 0, 0, 0],
    });
  });

  test('the route', () => {
    assert({
      given: 'the bell',
      should: "ask apps/web's notifications route for the count alone",
      actual: NOTIFICATION_COUNT,
      expected: '/api/notifications?countOnly=true',
    });
  });
});
