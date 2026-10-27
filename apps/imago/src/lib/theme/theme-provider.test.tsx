// @vitest-environment jsdom
import { act, createElement as h, useState } from 'react';
import { renderToString } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ThemeProvider, useThemePreference } from './theme-provider';
import { ThemeSwitcher } from '@/ui/components/theme-switcher/theme-switcher';
import type { ThemePreference } from './theme-preference';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  const { preference } = useThemePreference();
  return h('p', null, preference);
}

/** Local state that a reload would lose. */
function Counter() {
  const [count, setCount] = useState(0);
  return h('output', { onClick: () => setCount(count + 1) }, String(count));
}

const clearThemeCookie = () => {
  document.cookie = 'theme=; path=/; max-age=0';
};

let root: Root | undefined;
let container: HTMLDivElement;

/** Mounts the provider as the root layout does: <html data-theme> first. */
const mount = (initialPreference: ThemePreference) => {
  document.documentElement.dataset.theme = initialPreference;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      h(ThemeProvider, {
        initialPreference,
        children: [h(ThemeSwitcher, { key: 's' }), h(Counter, { key: 'c' })],
      }),
    );
  });
};

const radio = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === label,
  );
  if (!found) throw new Error(`no ${label} radio`);
  return found;
};

const checked = () =>
  [...container.querySelectorAll('[aria-checked="true"]')].map(
    (node) => node.textContent,
  );

beforeEach(() => {
  clearThemeCookie();
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  vi.unstubAllGlobals();
});

describe('ThemeProvider on the server', () => {
  test('serves the request preference to the first render', () => {
    const probed = (initialPreference: ThemePreference) =>
      /<p>([^<]*)<\/p>/.exec(
        renderToString(h(ThemeProvider, { initialPreference, children: h(Probe) })),
      )?.[1];

    assert({
      given: 'providers seeded with different preferences',
      should: 'render each consumer with its own request preference',
      actual: [probed('light'), probed('dark'), probed('system')],
      expected: ['light', 'dark', 'system'],
    });
  });

  test('rejects a consumer outside the provider', () => {
    expect(() => renderToString(h(Probe))).toThrow(
      'useThemePreference must be used inside ThemeProvider',
    );
  });
});

describe('ThemeProvider in the browser', () => {
  test('a switch writes the shared cookie and applies in place', () => {
    mount('system');
    act(() => container.querySelector('output')?.click());
    act(() => radio('Dark').click());

    assert({
      given: 'a click on Dark in a page served with system',
      should:
        "write classic's theme cookie and next-themes storage, set data-theme, check Dark, and keep page state (no reload)",
      actual: {
        cookie: document.cookie,
        storage: localStorage.getItem('theme'),
        dataTheme: document.documentElement.dataset.theme,
        checked: checked(),
        counter: container.querySelector('output')?.textContent,
      },
      expected: {
        cookie: 'theme=dark',
        storage: 'dark',
        dataTheme: 'dark',
        checked: ['Dark'],
        counter: '1',
      },
    });
  });

  test('every choice reaches the cookie and the document', () => {
    mount('dark');
    const seen = (['Light', 'System', 'Dark'] as const).map((label) => {
      act(() => radio(label).click());
      return [document.cookie, document.documentElement.dataset.theme];
    });

    assert({
      given: 'Light, System then Dark',
      should: 'write each one to the cookie and data-theme',
      actual: seen,
      expected: [
        ['theme=light', 'light'],
        ['theme=system', 'system'],
        ['theme=dark', 'dark'],
      ],
    });
  });

  test('a tab shown again catches up with a switch made in classic', () => {
    mount('light');
    // Classic's syncThemeToCookie, from another tab.
    document.cookie = 'theme=dark; path=/; max-age=31536000; SameSite=Lax';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    assert({
      given: 'the cookie switched to dark while this tab was hidden',
      should: 'apply dark and check it, without writing anything back',
      actual: {
        dataTheme: document.documentElement.dataset.theme,
        checked: checked(),
        storage: localStorage.getItem('theme'),
      },
      expected: { dataTheme: 'dark', checked: ['Dark'], storage: null },
    });
  });

  test('a page restored from the back/forward cache catches up', () => {
    mount('dark');
    document.cookie = 'theme=light; path=/; max-age=31536000; SameSite=Lax';
    act(() => {
      window.dispatchEvent(new Event('pageshow'));
    });

    assert({
      given: 'the cookie switched to light while this page sat in the bfcache',
      should: 'apply light and check it on pageshow',
      actual: {
        dataTheme: document.documentElement.dataset.theme,
        checked: checked(),
      },
      expected: { dataTheme: 'light', checked: ['Light'] },
    });
  });

  test('an unmounted provider stops listening', () => {
    mount('dark');
    act(() => root?.unmount());
    root = undefined;
    document.cookie = 'theme=light; path=/; max-age=31536000; SameSite=Lax';
    window.dispatchEvent(new Event('pageshow'));
    document.dispatchEvent(new Event('visibilitychange'));

    assert({
      given: 'a cookie change after the provider unmounted',
      should: 'leave data-theme alone on pageshow and visibilitychange',
      actual: document.documentElement.dataset.theme,
      expected: 'dark',
    });
  });

  test('a view transition snapshots the switcher already switched', () => {
    const insideTransition: (string | null)[][] = [];
    // jsdom has no view transitions: stand one in that runs the update and
    // records what the switcher shows when it returns.
    Object.defineProperty(document, 'startViewTransition', {
      configurable: true,
      value: (update: () => void) => {
        update();
        insideTransition.push(checked());
      },
    });
    try {
      mount('system');
      act(() => radio('Light').click());
    } finally {
      Reflect.deleteProperty(document, 'startViewTransition');
    }

    assert({
      given: 'a browser with view transitions and a click on Light',
      should:
        'commit the checked radio inside the transition update (flushSync), so the new snapshot shows it',
      actual: insideTransition,
      expected: [['Light']],
    });
  });
});

