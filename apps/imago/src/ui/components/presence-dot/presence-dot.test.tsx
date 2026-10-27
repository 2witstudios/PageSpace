import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { PresenceDot } from './presence-dot';
import { renderPresenceDot } from './presence-dot.render';

describe('PresenceDot', () => {
  test('renders through renderPresenceDot', () => {
    const props = { presence: 'away' } as const;
    assert({
      given: 'the same props',
      should: 'render exactly what renderPresenceDot renders',
      actual: renderToString(h(PresenceDot, props)),
      expected: renderToString(renderPresenceDot(props)),
    });
  });
});
