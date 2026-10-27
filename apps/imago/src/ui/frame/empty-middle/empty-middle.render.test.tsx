// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { act } from 'react';
import { mount, unmountAll } from '../../test-support/dom';
import { renderEmptyMiddle } from './empty-middle.render';

afterEach(unmountAll);

const recents = [
  { id: 'plan', title: 'Q4 Launch Plan', type: 'DOCUMENT' as const, href: '/s/files/plan', age: 'now' },
  { id: 'pricing', title: 'Pricing Model', type: 'SHEET' as const, href: '/s/files/pricing', age: '1h' },
  { id: 'ops', title: 'launch-ops', type: 'CHANNEL' as const, href: '/s/files/ops', age: '2h' },
];

describe('renderEmptyMiddle() (IMC-1.7)', () => {
  test('the board’s copy and recents', () => {
    const root = mount(renderEmptyMiddle({ leading: null, recents, onAskImago: () => {} }));
    assert({
      given: 'three recents',
      should: 'show the region, its head, the line, the rows and Ask Imago',
      actual: [
        root.querySelector('section')?.getAttribute('aria-label'),
        root.querySelector('header')?.textContent,
        root.querySelector('p')?.textContent,
        [...root.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]),
        root.querySelector('button')?.textContent,
      ],
      expected: [
        'Nothing open',
        'Nothing open',
        'Pick a page from the sidebar, or ask Imago.',
        [['Q4 Launch Plannow', '/s/files/plan'], ['Pricing Model1h', '/s/files/pricing'], ['#launch-ops2h', '/s/files/ops']],
        'Ask Imago',
      ],
    });
  });

  test('Ask Imago', () => {
    const onAskImago = vi.fn();
    const root = mount(renderEmptyMiddle({ leading: null, recents: [], onAskImago }));
    act(() => root.querySelector('button')?.click());
    assert({
      given: 'no recents and Ask Imago clicked',
      should: 'omit the Recents group and ask for Imago',
      actual: [root.textContent?.includes('Recents'), onAskImago.mock.calls.length],
      expected: [false, 1],
    });
  });
});
