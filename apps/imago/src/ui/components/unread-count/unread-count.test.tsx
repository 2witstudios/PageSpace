import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { UnreadCount } from './unread-count';
import { renderUnreadCount } from './unread-count.render';

describe('UnreadCount', () => {
  test('renders through renderUnreadCount', () => {
    assert({
      given: 'the same props, with and without unread',
      should: 'render exactly what renderUnreadCount renders',
      actual: [3, 0].map((count) => renderToString(h(UnreadCount, { count }))),
      expected: [3, 0].map((count) =>
        renderToString(renderUnreadCount({ count })),
      ),
    });
  });
});
