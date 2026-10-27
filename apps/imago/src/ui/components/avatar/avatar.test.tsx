import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { Avatar } from './avatar';
import { renderAvatar } from './avatar.render';

describe('Avatar', () => {
  test('renders through renderAvatar', () => {
    const props = { name: 'Maya Singh', presence: 'away', size: 'lg' } as const;
    assert({
      given: 'the same props',
      should: 'render exactly what renderAvatar renders',
      actual: renderToString(h(Avatar, props)),
      expected: renderToString(renderAvatar(props)),
    });
  });
});
