// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { fakeWeb } from '../../test-support/fake-web';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { mount, unmountAll } from '../../test-support/dom';

// The network path of sign-out (web's logout, then sign-in) is proven in
// lib/auth/sign-out.test.ts; here the menu has only to start it.
const signOut = vi.hoisted(() =>
  vi.fn(async (_io: { fetch: unknown; navigate: unknown }) => {}),
);
vi.mock('@/lib/auth/sign-out', () => ({ signOut }));
// The switcher itself is proven in its own suites, against the theme provider.
vi.mock('@/ui/components/theme-switcher/theme-switcher', () => ({
  ThemeSwitcher: () => h('div', { role: 'radiogroup', 'aria-label': 'Theme' }),
}));

const { AvatarMenu, ME, profileFrom } = await import('./avatar-menu');

const settle = (check: () => void): Promise<void> => act(() => vi.waitFor(check, { timeout: 1000, interval: 5 }));

beforeEach(() => {
  signOut.mockClear();
});

afterEach(() => {
  unmountAll();
});

describe('AvatarMenu', () => {
  test('the signed-in user and the actions', async () => {
    const web = fakeWeb({ [`GET ${ME}`]: () => Response.json({ id: 'user-1', name: 'Ada Lovelace', image: '/api/avatar/user-1.png' }) });
    const container = mount(
      <ImagoSWRProvider client={web.client}>
        <AvatarMenu />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (!container.textContent?.includes('Ada Lovelace')) throw new Error('profile not loaded');
    });
    const account = container.querySelector<HTMLAnchorElement>('a[href="/account"]');
    const navigated = vi.fn((event: Event) => event.preventDefault());
    account?.addEventListener('click', navigated);

    assert({
      given: 'the profile from /api/auth/me',
      should: 'load it once and draw the avatar from its same-origin picture, with Account, the theme, Classic and Sign out in the menu',
      actual: [
        web.count(`GET ${ME}`),
        container.querySelector('summary img')?.getAttribute('src'),
        [...container.querySelectorAll('ul[aria-label="Account"] a, ul[aria-label="Account"] [role="radiogroup"], ul[aria-label="Account"] button')].map(
          (element) => element.getAttribute('href') ?? element.getAttribute('aria-label') ?? element.textContent,
        ),
      ],
      expected: [1, '/api/avatar/user-1.png', ['/account', 'Theme', '/dashboard', 'Sign out']],
    });
  });

  test('sign out', () => {
    const container = mount(<AvatarMenu />);
    const button = [...container.querySelectorAll('button')].find((element) => element.textContent === 'Sign out');
    act(() => button?.click());
    act(() => button?.click());

    assert({
      given: 'Sign out pressed twice',
      should: 'start sign-out once, through the browser’s fetch and navigation, and disable the button',
      actual: [signOut.mock.calls.length, typeof signOut.mock.calls[0]?.[0]?.fetch, typeof signOut.mock.calls[0]?.[0]?.navigate, button?.disabled],
      expected: [1, 'function', 'function', true],
    });
  });
});

describe('profileFrom()', () => {
  test('what /api/auth/me says', () => {
    assert({
      given: 'a name and a same-origin picture, an off-site or protocol-relative picture, and an error body',
      should: 'keep only a non-empty name and a same-origin path',
      actual: [
        profileFrom({ name: 'Ada', image: '/a.png' }),
        profileFrom({ name: 'Ada', image: 'https://evil.example/a.png' }),
        profileFrom({ name: ' ', image: '//evil.example/a.png' }),
        profileFrom(undefined),
      ],
      expected: [
        { name: 'Ada', image: '/a.png' },
        { name: 'Ada', image: null },
        { name: null, image: null },
        { name: null, image: null },
      ],
    });
  });
});
