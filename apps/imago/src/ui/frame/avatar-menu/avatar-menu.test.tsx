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

const CREDITS_BODY = {
  billingEnabled: true,
  subscriptionTier: 'pro',
  monthly: { remaining: 612, allowance: 900, periodEnd: '2026-11-03T12:00:00.000Z' },
  topup: { remaining: 0 },
  debt: 0,
  spendable: 612,
  reserved: 0,
};

const web = (verified: boolean) =>
  fakeWeb({
    [`GET ${ME}`]: () => Response.json({ id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com', image: '/api/avatar/user-1.png', emailVerified: verified }),
    'GET /api/credits': () => Response.json(CREDITS_BODY),
  });

const rowsOf = (container: HTMLElement) =>
  [...container.querySelectorAll('ul[aria-label="Account"] > li')].map((item) => item.textContent?.replace(/\s+/g, ' ').trim());

beforeEach(() => {
  signOut.mockClear();
});

afterEach(() => {
  unmountAll();
});

describe('AvatarMenu', () => {
  test('the signed-in user, the credits card and the rows', async () => {
    const fake = web(true);
    const container = mount(
      <ImagoSWRProvider client={fake.client}>
        <AvatarMenu />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (!container.textContent?.includes('Ada Lovelace') || !container.textContent?.includes('/ 900 credits')) throw new Error('not loaded');
    });

    assert({
      given: 'the profile from /api/auth/me and the balance from /api/credits',
      should: 'load each once, draw the avatar from its same-origin picture, and list the account rows',
      actual: [
        fake.count(`GET ${ME}`),
        fake.count('GET /api/credits'),
        container.querySelector('summary img')?.getAttribute('src'),
        container.textContent?.includes('ada@example.com'),
        rowsOf(container).at(-1),
        container.querySelectorAll('a[href="/account/profile"]').length,
      ],
      expected: [1, 1, '/api/avatar/user-1.png', true, 'Log out', 1],
    });
  });

  test('a verified account has no Verify Email row', async () => {
    const container = mount(
      <ImagoSWRProvider client={web(true).client}>
        <AvatarMenu />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (!container.textContent?.includes('Ada Lovelace')) throw new Error('not loaded');
    });

    assert({
      given: 'a verified email',
      should: 'leave out the Verify Email row',
      actual: rowsOf(container).some((row) => row?.startsWith('Verify Email')),
      expected: false,
    });
  });

  test('Log out', () => {
    const container = mount(<AvatarMenu />);
    const button = [...container.querySelectorAll('button')].find((element) => element.textContent === 'Log out');
    act(() => button?.click());
    act(() => button?.click());

    assert({
      given: 'Log out pressed twice',
      should: 'start sign-out once, through the browser’s fetch and navigation, and disable the button',
      actual: [signOut.mock.calls.length, typeof signOut.mock.calls[0]?.[0]?.fetch, typeof signOut.mock.calls[0]?.[0]?.navigate, button?.disabled],
      expected: [1, 'function', 'function', true],
    });
  });
});

describe('profileFrom()', () => {
  test('what /api/auth/me says', () => {
    assert({
      given: 'a name, an email and a same-origin picture; an off-site picture; a blank name; and an error body',
      should: 'keep only a non-empty name, the email, a same-origin path and the verified flag',
      actual: [
        profileFrom({ name: 'Ada', email: 'ada@x.io', image: '/a.png', emailVerified: false }),
        profileFrom({ name: 'Ada', image: 'https://evil.example/a.png' }),
        profileFrom({ name: ' ', image: '//evil.example/a.png' }),
        profileFrom(undefined),
      ],
      expected: [
        { name: 'Ada', email: 'ada@x.io', image: '/a.png', emailVerified: false },
        { name: 'Ada', email: null, image: null, emailVerified: null },
        { name: null, email: null, image: null, emailVerified: null },
        { name: null, email: null, image: null, emailVerified: null },
      ],
    });
  });
});
