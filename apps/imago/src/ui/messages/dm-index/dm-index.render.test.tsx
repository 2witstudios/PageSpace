import { createElement as h, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';

// next/link is the seam that prefetches: here it shows what it was handed.
vi.mock('next/link', () => ({
  default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean; children: ReactNode }) =>
    h('a', { href, 'data-prefetch': String(prefetch), ...rest }, children),
}));

const { renderDmGround, renderDmIndexPane } = await import('./dm-index.render');
type PaneProps = Parameters<typeof renderDmIndexPane>[0];

const dana = {
  id: 'm1',
  name: 'Dana',
  username: 'dana',
  avatarUrl: null,
  when: '9:15',
  preview: 'Status page draft is in the doc',
  unreadCount: 2,
  selected: false,
};
const sam = { ...dana, id: 'm2', name: 'Sam', username: 'sam', when: 'Yesterday', preview: 'sounds good', unreadCount: 0 };

const pane = (overrides: Partial<PaneProps> = {}): string =>
  renderToString(
    h(
      'div',
      null,
      renderDmIndexPane({
        variant: 'list',
        close: h('button', { 'aria-label': 'Close sidebar' }),
        state: { status: 'ready', rows: [dana, sam] },
        query: '',
        onQueryChange: () => undefined,
        ...overrides,
      }),
    ),
  );

describe('renderDmIndexPane()', () => {
  test('the pane, its filter and its rows', () => {
    const html = pane();
    assert({
      given: 'two conversations with an empty filter',
      should: 'draw a 300px pane named Direct messages with a Filter conversations input and each row',
      actual: [
        html.includes('aria-label="Direct messages"'),
        html.includes('w-list-pane'),
        html.includes('aria-label="Filter conversations"'),
        html.includes('@dana'),
        html.includes('@sam'),
        html.includes('Status page draft is in the doc'),
        html.includes('9:15'),
        html.includes('aria-label="Dana, 2 unread"'),
        html.includes('href="/dm/m1"'),
      ],
      expected: [true, true, true, true, true, true, true, true, true],
    });
  });

  test('the filter value and the close control', () => {
    const html = pane({ query: 'da' });
    assert({
      given: 'a filter the viewer typed',
      should: 'show it in the input and draw the close control from the shell',
      actual: [html.includes('value="da"'), html.includes('aria-label="Close sidebar"')],
      expected: [true, true],
    });
  });

  test('a selected row draws no unread count', () => {
    const html = pane({ state: { status: 'ready', rows: [{ ...dana, selected: true }] } });
    assert({
      given: 'the open conversation with unread messages',
      should: 'mark it as the current page and leave its unread count out',
      actual: [html.includes('aria-current="page"'), html.includes('aria-hidden="true">2</span>')],
      expected: [true, false],
    });
  });

  test('the states', () => {
    const html = (state: PaneProps['state'], query = '') => pane({ state, query });
    assert({
      given: 'loading, failed, no conversations, and no match for the filter',
      should: 'say so in the pane, with Try again where a retry exists',
      actual: [
        html({ status: 'loading' }).includes('Loading direct messages…'),
        html({ status: 'error', retry: () => undefined }).includes('Try again'),
        html({ status: 'ready', rows: [] }).includes('No direct messages yet.'),
        html({ status: 'ready', rows: [] }, 'zzz').includes('No conversations match this filter.'),
      ],
      expected: [true, true, true, true],
    });
  });
});

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
