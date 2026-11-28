// @vitest-environment jsdom
/**
 * IMG-1.7a: the imago image bakes classic's NEXT_PUBLIC_COOKIE_DOMAIN, so a
 * switch must write the `theme` cookie with that Domain when it is set at
 * build time, and stay host-only when it is not.
 */
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ThemeProvider } from './theme-provider';
import { ThemeSwitcher } from '@/ui/components/theme-switcher/theme-switcher';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement;

/**
 * Mounts the real provider and switcher, clicks Dark, and returns every
 * cookie string the page handed to `document.cookie`. jsdom's jar drops a
 * Domain that does not match localhost, so the writes are read off the
 * setter rather than back out of `document.cookie`.
 */
const cookiesWrittenOnSwitch = (): string[] => {
  const setter = vi.spyOn(Document.prototype, 'cookie', 'set');
  document.documentElement.dataset.theme = 'system';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      h(ThemeProvider, { initialPreference: 'system', children: h(ThemeSwitcher) }),
    );
  });
  setter.mockClear();
  const dark = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Dark',
  );
  if (!dark) throw new Error('no Dark radio');
  act(() => dark.click());
  return setter.mock.calls.map(([cookie]) => String(cookie));
};

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('theme cookie Domain from the build', () => {
  test('a build with NEXT_PUBLIC_COOKIE_DOMAIN shares the cookie across the domain', () => {
    vi.stubEnv('NEXT_PUBLIC_COOKIE_DOMAIN', '.pagespace.ai');

    assert({
      given: 'NEXT_PUBLIC_COOKIE_DOMAIN=.pagespace.ai, as docker-images.yml bakes it',
      should: "write the theme cookie with classic's Domain",
      actual: cookiesWrittenOnSwitch(),
      expected: [
        'theme=dark; path=/; max-age=31536000; SameSite=Lax; domain=.pagespace.ai',
      ],
    });
  });

  test('a build without NEXT_PUBLIC_COOKIE_DOMAIN stays host-only', () => {
    vi.stubEnv('NEXT_PUBLIC_COOKIE_DOMAIN', undefined);

    assert({
      given: 'no NEXT_PUBLIC_COOKIE_DOMAIN (the Dockerfile ARG default)',
      should: 'write a host-only theme cookie with no Domain attribute',
      actual: cookiesWrittenOnSwitch(),
      expected: ['theme=dark; path=/; max-age=31536000; SameSite=Lax'],
    });
  });

  test('an empty NEXT_PUBLIC_COOKIE_DOMAIN stays host-only', () => {
    // The Dockerfile's ARG default is "", which Next inlines as an empty string.
    vi.stubEnv('NEXT_PUBLIC_COOKIE_DOMAIN', '');

    assert({
      given: 'NEXT_PUBLIC_COOKIE_DOMAIN="" (the Dockerfile ARG default)',
      should: 'write a host-only theme cookie with no Domain attribute',
      actual: cookiesWrittenOnSwitch(),
      expected: ['theme=dark; path=/; max-age=31536000; SameSite=Lax'],
    });
  });
});
