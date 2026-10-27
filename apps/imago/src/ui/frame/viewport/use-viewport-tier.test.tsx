// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll } from '../../test-support/dom';
import { usePhone, useViewportTier } from './use-viewport-tier';

type Listener = () => void;
const listeners = new Set<Listener>();
let width = 1400;

const install = () => {
  window.matchMedia = ((query: string) => {
    const max = Number(/max-width: ([\d.]+)px/.exec(query)?.[1]);
    return {
      get matches() {
        return width <= max;
      },
      media: query,
      addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
};

function Probe() {
  return h('p', null, `${useViewportTier()} ${usePhone()}`);
}

afterEach(() => {
  unmountAll();
  // @ts-expect-error jsdom has no matchMedia by default
  delete window.matchMedia;
  listeners.clear();
  width = 1400;
});

describe('useViewportTier()', () => {
  test('without matchMedia the tier is desktop', () => {
    const view = mount(h(Probe));
    assert({ given: 'no matchMedia', should: 'be desktop and not a phone', actual: view.textContent, expected: 'desktop false' });
  });

  test('it follows the window across a boundary', () => {
    install();
    const view = mount(h(Probe));
    const before = view.textContent;
    width = 390;
    act(() => listeners.forEach((listener) => listener()));
    const after = view.textContent;
    unmountAll();
    assert({
      given: 'a window resized from 1400 to 390',
      should: 'move from desktop to phone and release its listeners',
      actual: [before, after, listeners.size],
      expected: ['desktop false', 'phone true', 0],
    });
  });
});
