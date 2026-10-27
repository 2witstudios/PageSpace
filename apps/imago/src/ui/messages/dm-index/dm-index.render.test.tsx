import { createElement as h, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';

// next/link is the seam that prefetches: here it shows what it was handed.
vi.mock('next/link', () => ({
  default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean; children: ReactNode }) =>
    h('a', { href, 'data-prefetch': String(prefetch), ...rest }, children),
}));

const { renderDmGround } = await import('./dm-index.render');

describe('renderDmGround()', () => {
  test('the heading, the description and the people', () => {
    const html = renderToString(
      h(
        'div',
        null,
        renderDmGround({
          people: {
            status: 'ready',
            people: [{ id: 'u1', name: 'Priya', username: 'priya', avatarUrl: null }],
          },
        }),
      ),
    );
    assert({
      given: 'the viewer can message one person',
      should: 'show Direct messages, its one-to-one line, and that person by name, with no source line',
      actual: [
        html.includes('>Direct messages<'),
        html.includes('Private, one-to-one. You can message your connections and anyone who shares a drive with you.'),
        html.includes('People you can message'),
        html.includes('>Priya<'),
        html.includes('Shares'),
      ],
      expected: [true, true, true, true, false],
    });
  });

  test('no one to message', () => {
    const html = renderToString(h('div', null, renderDmGround({ people: { status: 'empty' } })));
    assert({
      given: 'an empty messageable list',
      should: 'say no one can be messaged yet',
      actual: html.includes('No one to message yet.'),
      expected: true,
    });
  });
});
