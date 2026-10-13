import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { renderBannerSlot } from './banner-slot.render';

describe('renderBannerSlot()', () => {
  test('nothing when no banner applies', () => {
    assert({
      given: 'no banner to show',
      should: 'render no strip at all',
      actual: renderBannerSlot(null),
      expected: null,
    });
  });

  test('the message, the tone and the inline actions in one status strip', () => {
    const html = renderToString(
      h(
        'div',
        null,
        renderBannerSlot({
          id: 'offline',
          priority: 90,
          tone: 'warning',
          message: 'You’re offline.',
          actions: h('button', { type: 'button' }, 'Try again'),
        }),
      ),
    );
    assert({
      given: 'a warning banner with one action',
      should: 'mark the strip as a status with its tone, the message and the action',
      actual: [
        html.includes('role="status"'),
        html.includes('data-banner="offline"'),
        html.includes('data-tone="warning"'),
        html.includes('You’re offline.'),
        html.includes('>Try again<'),
      ],
      expected: [true, true, true, true, true],
    });
  });

  test('a banner with no actions renders only its message', () => {
    const html = renderToString(
      h('div', null, renderBannerSlot({ id: 'conflict', priority: 80, tone: 'danger', message: 'Edit conflict.' })),
    );
    assert({
      given: 'a banner without actions',
      should: 'render the message and no action container',
      actual: [html.includes('Edit conflict.'), html.includes('<button')],
      expected: [true, false]
    });
  });
});
