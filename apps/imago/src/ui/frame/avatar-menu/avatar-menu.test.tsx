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
vi.mock('@/ui/components/text-size-switcher/text-size-switcher', () => ({
  TextSizeSwitcher: () => h('div', { role: 'group', 'aria-label': 'Text size' }),
}));
// The live balance (retained useCreditBalance): /api/credits through fetchWithAuth, then the
// realtime socket's credits:updated pushes. A stand-in socket lets a test push a new balance.
const live = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const socket = {
    on: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, (handlers.get(event) ?? new Set()).add(handler));
    },
    off: (event: string, handler: (payload: unknown) => void) => {
      handlers.get(event)?.delete(handler);
    },
  };
  const store = { socket, connect: async () => {} };
  return {
    store,
    emit: (event: string, payload: unknown) => handlers.get(event)?.forEach((handler) => handler(payload)),
    fetchWithAuth: vi.fn(async (_url: string) => Response.json({})),
  };
});
vi.mock('@/retained/stores/useSocketStore', () => ({
  useSocketStore: (select: (store: typeof live.store) => unknown) => select(live.store),
}));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({ fetchWithAuth: live.fetchWithAuth }));

const { AvatarMenu, ME, profileFrom } = await import('./avatar-menu');

const settle = (check: () => void): Promise<void> => act(() => vi.waitFor(check, { timeout: 1000, interval: 5 }));

const CREDITS_BODY = {
  billingEnabled: true,
  subscriptionTier: 'pro',
  // Cents of credit value, as /api/credits sends them: 6,120 cents is 612 credits.
  monthly: { remaining: 6120, allowance: 9000, periodEnd: '2026-11-03T12:00:00.000Z' },
  topup: { remaining: 0 },
  debt: 0,
  spendable: 6120,
  reserved: 0,
};

const web = (verified: boolean) =>
  fakeWeb({
    [`GET ${ME}`]: () => Response.json({ id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com', image: '/api/avatar/user-1.png', emailVerified: verified }),
  });

const rowsOf = (container: HTMLElement) =>
  [...container.querySelectorAll('ul[aria-label="Account"] > li')].map((item) => item.textContent?.replace(/\s+/g, ' ').trim());

beforeEach(() => {
  signOut.mockClear();
  live.fetchWithAuth.mockReset();
  live.fetchWithAuth.mockImplementation(async (url: string) => (url === '/api/credits' ? Response.json(CREDITS_BODY) : new Response('{}', { status: 404 })));
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
      if (!container.textContent?.includes('Ada Lovelace') || !container.textContent?.includes('612 credits')) throw new Error('not loaded');
    });

    assert({
      given: 'the profile from /api/auth/me and the balance from /api/credits',
      should: 'load each once, draw the avatar from its same-origin picture, show the total and the next grant, and list the account rows',
      actual: [
        fake.count(`GET ${ME}`),
        live.fetchWithAuth.mock.calls.filter(([url]) => url === '/api/credits').length,
        container.querySelector('summary img')?.getAttribute('src'),
        container.textContent?.includes('ada@example.com'),
        container.textContent?.includes('612 credits900 more on Nov 3'),
        rowsOf(container).at(-1),
        container.querySelectorAll('a[href="/account/profile"]').length,
      ],
      expected: [1, 1, '/api/avatar/user-1.png', true, true, 'Log out', 1],
    });
  });

  test('Verify Email resends the verification mail and closes the menu', async () => {
    const fake = fakeWeb({
      [`GET ${ME}`]: () => Response.json({ id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.com', emailVerified: false }),
      'POST /api/auth/resend-verification': () => Response.json({ message: 'sent' }),
    });
    const container = mount(
      <ImagoSWRProvider client={fake.client}>
        <AvatarMenu />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (!rowsOf(container).some((row) => row?.startsWith('Verify Email'))) throw new Error('no row');
    });
    const verify = [...container.querySelectorAll('ul[aria-label="Account"] button')].find((button) => button.textContent?.startsWith('Verify Email'));
    act(() => (verify as HTMLButtonElement).click());
    await settle(() => {
      if (fake.count('POST /api/auth/resend-verification') === 0) throw new Error('not resent');
    });
    assert({
      given: 'Verify Email pressed',
      should: 'post the resend once and close the menu',
      actual: [fake.count('POST /api/auth/resend-verification'), container.querySelector('details')?.hasAttribute('open')],
      expected: [1, false],
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

  test('a credits:updated push updates the card', async () => {
    const container = mount(
      <ImagoSWRProvider client={web(true).client}>
        <AvatarMenu />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (!container.textContent?.includes('612 credits')) throw new Error('not loaded');
    });
    // A turn settles: the server pushes the authoritative balance (no subscriptionTier).
    act(() => {
      live.emit('credits:updated', {
        billingEnabled: true,
        monthly: { remaining: 5980, allowance: 9000, periodEnd: '2026-11-03T12:00:00.000Z' },
        topup: { remaining: 0 },
        debt: 0,
        spendable: 5980,
        reserved: 0,
      });
    });
    await settle(() => {
      if (!container.textContent?.includes('598 credits')) throw new Error('not updated');
    });
    const card = container.querySelector('[data-credits-card]')?.textContent?.replace(/\s+/g, ' ').trim();

    assert({
      given: 'a credits:updated push after a turn',
      should: 'show the pushed total on the card, keep the plan, and not refetch the balance',
      actual: [card, live.fetchWithAuth.mock.calls.filter(([url]) => url === '/api/credits').length],
      expected: ['CreditsPro598 credits900 more on Nov 3Buy credits', 1],
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
