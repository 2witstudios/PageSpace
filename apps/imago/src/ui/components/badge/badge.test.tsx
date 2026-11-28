import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { Badge } from './badge';
import { renderBadge } from './badge.render';

describe('Badge', () => {
  test('renders through renderBadge', () => {
    const props = { tone: 'accent', children: 'New' } as const;
    assert({
      given: 'the same props',
      should: 'render exactly what renderBadge renders',
      actual: renderToString(h(Badge, props)),
      expected: renderToString(renderBadge(props)),
    });
  });
});
