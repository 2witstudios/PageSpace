// @vitest-environment jsdom
import { act, createElement as h, useState } from 'react';
import { renderToString } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { TextSizeProvider, useTextSize } from './text-size-provider';
import { TextSizeSwitcher } from '@/ui/components/text-size-switcher/text-size-switcher';
import type { TextSize } from './text-size-preference';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  return h('p', null, useTextSize().size);
}

/** Local state that a reload would lose. */
function Counter() {
  const [count, setCount] = useState(0);
  return h('output', { onClick: () => setCount(count + 1) }, String(count));
}

let root: Root | undefined;
let container: HTMLDivElement;

/** Mounts the provider as the root layout does: <html data-text-size> first. */
const mount = (initialSize: TextSize) => {
  document.documentElement.dataset.textSize = initialSize;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(h(TextSizeProvider, { initialSize, children: [h(TextSizeSwitcher, { key: 's' }), h(Counter, { key: 'c' })] }));
  });
};

const button = (label: string): HTMLButtonElement => {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="Text size: ${label}"]`);
  if (!found) throw new Error(`no ${label} button`);
  return found;
};

const pressed = () =>
  [...container.querySelectorAll('[aria-pressed="true"]')].map((node) => node.getAttribute('aria-label'));

beforeEach(() => {
  document.cookie = 'imago-text-size=; path=/; max-age=0';
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
});

describe('TextSizeProvider on the server', () => {
  test('serves the request size to the first render', () => {
    const probed = (initialSize: TextSize) =>
      /<p>([^<]*)<\/p>/.exec(renderToString(h(TextSizeProvider, { initialSize, children: h(Probe) })))?.[1];

    assert({
      given: 'providers seeded with different sizes',
      should: 'render each consumer with its own request size',
      actual: [probed('small'), probed('default'), probed('larger')],
      expected: ['small', 'default', 'larger'],
    });
  });

  test('rejects a consumer outside the provider', () => {
    expect(() => renderToString(h(Probe))).toThrow('useTextSize must be used inside TextSizeProvider');
  });
});

describe('TextSizeProvider in the browser', () => {
  test('a choice writes the cookie and applies in place', () => {
    mount('default');
    act(() => container.querySelector('output')?.click());
    act(() => button('Large').click());

    assert({
      given: 'a click on Large in a page served at the default size',
      should: 'write the cookie, set data-text-size, press Large, and keep page state (no reload)',
      actual: {
        cookie: document.cookie,
        dataTextSize: document.documentElement.dataset.textSize,
        pressed: pressed(),
        counter: container.querySelector('output')?.textContent,
      },
      expected: {
        cookie: 'imago-text-size=large',
        dataTextSize: 'large',
        pressed: ['Text size: Large'],
        counter: '1',
      },
    });
  });

  test('a tab shown again catches up with a choice made in another tab', () => {
    mount('default');
    document.cookie = 'imago-text-size=larger; path=/; max-age=31536000; SameSite=Lax';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    assert({
      given: 'the cookie switched to larger while this tab was hidden',
      should: 'apply larger and press it',
      actual: { dataTextSize: document.documentElement.dataset.textSize, pressed: pressed() },
      expected: { dataTextSize: 'larger', pressed: ['Text size: Larger'] },
    });
  });

  test('a page restored from the back/forward cache catches up', () => {
    mount('large');
    document.cookie = 'imago-text-size=small; path=/; max-age=31536000; SameSite=Lax';
    act(() => {
      window.dispatchEvent(new Event('pageshow'));
    });

    assert({
      given: 'the cookie switched to small while this page sat in the bfcache',
      should: 'apply small and press it on pageshow',
      actual: { dataTextSize: document.documentElement.dataset.textSize, pressed: pressed() },
      expected: { dataTextSize: 'small', pressed: ['Text size: Small'] },
    });
  });

  test('an unmounted provider stops listening', () => {
    mount('large');
    act(() => root?.unmount());
    root = undefined;
    document.cookie = 'imago-text-size=small; path=/; max-age=31536000; SameSite=Lax';
    window.dispatchEvent(new Event('pageshow'));
    document.dispatchEvent(new Event('visibilitychange'));

    assert({
      given: 'a cookie change after the provider unmounted',
      should: 'leave data-text-size alone',
      actual: document.documentElement.dataset.textSize,
      expected: 'large',
    });
  });
});
