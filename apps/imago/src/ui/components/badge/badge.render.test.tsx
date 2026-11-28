import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { badgeClass } from './badge-class';
import { renderBadge } from './badge.render';

describe('renderBadge()', () => {
  test('defaults', () => {
    assert({
      given: 'a badge with only a label',
      should: 'render a neutral span around the label',
      actual: renderToString(renderBadge({ children: 'Draft' })),
      expected: `<span class="${badgeClass('neutral')}">Draft</span>`,
    });
  });

  test('accent', () => {
    assert({
      given: 'the accent tone',
      should: 'render the accent span',
      actual: renderToString(renderBadge({ tone: 'accent', children: 3 })),
      expected: `<span class="${badgeClass('accent')}">3</span>`,
    });
  });
});
