import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { Button } from './button';
import { renderButton } from './button.render';

describe('Button', () => {
  test('renders through renderButton', () => {
    const props = { variant: 'secondary', children: 'Cancel' } as const;
    assert({
      given: 'the same props',
      should: 'render exactly what renderButton renders',
      actual: renderToString(h(Button, props)),
      expected: renderToString(renderButton(props)),
    });
  });
});
