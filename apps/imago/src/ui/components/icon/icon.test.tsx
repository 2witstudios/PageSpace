import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { Icon } from './icon';
import { renderIcon } from './icon.render';

describe('Icon', () => {
  test('renders through renderIcon', () => {
    const props = { name: 'bot', label: 'Agent', size: 20 } as const;
    assert({
      given: 'the same props',
      should: 'render exactly what renderIcon renders',
      actual: renderToString(h(Icon, props)),
      expected: renderToString(renderIcon(props)),
    });
  });
});
