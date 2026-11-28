import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { unreadCountClass } from './unread-count-class';
import { renderUnreadCount } from './unread-count.render';

describe('renderUnreadCount()', () => {
  test('a count', () => {
    assert({
      given: 'seven unread',
      should:
        'draw the figure in the accent pill, hidden from assistive technology (its control carries the count)',
      actual: renderToString(renderUnreadCount({ count: 7 })),
      expected: `<span class="${unreadCountClass}" aria-hidden="true">7</span>`,
    });
  });

  test('placement from the caller', () => {
    assert({
      given: 'a count and a placement class',
      should: 'append the placement after the pill classes',
      actual: renderToString(renderUnreadCount({ count: 12, className: 'ml-auto' })),
      expected: `<span class="${unreadCountClass} ml-auto" aria-hidden="true">12</span>`,
    });
  });

  test('hidden at zero', () => {
    assert({
      given: 'zero, a negative or a non-number count',
      should: 'render nothing',
      actual: [0, -3, Number.NaN].map((count) =>
        renderToString(renderUnreadCount({ count })),
      ),
      expected: ['', '', ''],
    });
  });
});
