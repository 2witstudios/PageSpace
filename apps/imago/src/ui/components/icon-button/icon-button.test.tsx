import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { IconButton } from './icon-button';
import { renderIconButton } from './icon-button.render';

describe('IconButton', () => {
  test('renders through renderIconButton', () => {
    const props = { name: 'plus', label: 'New page', tone: 'reveal' } as const;
    assert({
      given: 'the same props',
      should: 'render exactly what renderIconButton renders',
      actual: renderToString(h(IconButton, props)),
      expected: renderToString(renderIconButton(props)),
    });
  });
});
