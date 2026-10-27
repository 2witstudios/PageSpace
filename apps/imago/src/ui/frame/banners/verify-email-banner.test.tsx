// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { fakeWeb } from '../../test-support/fake-web';
import { click, mount, unmountAll } from '../../test-support/dom';
import { RESEND_VERIFICATION, resetVerifyEmailSent, useVerifyEmail, useVerifyEmailBanner } from './verify-email-banner';
import { renderBannerSlot } from './banner-slot.render';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

function Slot() {
  return h('div', null, renderBannerSlot(useVerifyEmailBanner()));
}

const settle = (check: () => void): Promise<void> => act(() => vi.waitFor(check, { timeout: 1000, interval: 5 }));

const web = (verified: boolean, resend: () => Response | Promise<Response> = () => Response.json({ message: 'sent' })) =>
  fakeWeb({
    'GET /api/auth/me': () => Response.json({ id: 'u', name: 'Ada', email: 'ada@example.com', emailVerified: verified }),
    [`POST ${RESEND_VERIFICATION}`]: resend,
  });

const bannerOf = (container: HTMLElement) => container.querySelector('[data-banner="verifyEmail"]');

beforeEach(() => {
  toast.success.mockClear();
  toast.error.mockClear();
  resetVerifyEmailSent();
});

afterEach(() => {
  unmountAll();
});

describe('useVerifyEmailBanner()', () => {
  test('the warning with Resend and Account settings while unverified', async () => {
    const container = mount(
      <ImagoSWRProvider client={web(false).client}>
        <Slot />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (bannerOf(container) === null) throw new Error('not shown');
    });
    const banner = bannerOf(container);

    assert({
      given: 'an unverified email on /api/auth/me',
      should: 'show the verify banner with Resend Verification Email and Account settings',
      actual: [
        banner?.getAttribute('role'),
        banner?.textContent?.includes('Verify your email to unlock all features'),
        [...(banner?.querySelectorAll('button') ?? [])].map((button) => button.textContent),
        banner?.querySelector('a')?.getAttribute('href'),
      ],
      expected: ['status', true, ['Resend Verification Email'], '/account/profile'],
    });
  });

  test('nothing while verified', async () => {
    const fake = web(true);
    const container = mount(
      <ImagoSWRProvider client={fake.client}>
        <Slot />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (fake.count('GET /api/auth/me') === 0) throw new Error('not loaded');
    });

    assert({
      given: 'a verified email',
      should: 'show no banner',
      actual: bannerOf(container),
      expected: null,
    });
  });

  test('Resend posts once, swaps to the sent copy and toasts', async () => {
    const fake = web(false);
    const container = mount(
      <ImagoSWRProvider client={fake.client}>
        <Slot />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (bannerOf(container) === null) throw new Error('not shown');
    });
    click(bannerOf(container)?.querySelector('button') as HTMLButtonElement);
    await settle(() => {
      if (!bannerOf(container)?.textContent?.includes('Verification email sent!')) throw new Error('not sent');
    });

    assert({
      given: 'Resend Verification Email pressed',
      should: 'post to the resend route, show the sent copy with the address, drop Resend, and toast',
      actual: [
        fake.count(`POST ${RESEND_VERIFICATION}`),
        bannerOf(container)?.textContent?.includes('Verification email sent! Please check your inbox at ada@example.com'),
        [...(bannerOf(container)?.querySelectorAll('button') ?? [])].length,
        toast.success.mock.calls.length,
      ],
      expected: [1, true, 0, 1],
    });
  });

  test('a failed resend toasts and keeps Resend', async () => {
    const fake = web(false, () => Response.json({ error: 'nope' }, { status: 500 }));
    const container = mount(
      <ImagoSWRProvider client={fake.client}>
        <Slot />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (bannerOf(container) === null) throw new Error('not shown');
    });
    click(bannerOf(container)?.querySelector('button') as HTMLButtonElement);
    await settle(() => {
      if (toast.error.mock.calls.length === 0) throw new Error('no toast');
    });

    assert({
      given: 'the resend route failing',
      should: 'toast the failure and keep the Resend button',
      actual: [toast.error.mock.calls.length, bannerOf(container)?.textContent?.includes('Resend Verification Email')],
      expected: [1, true],
    });
  });

  test('a second Resend press while one is in flight sends nothing more', async () => {
    let release: (response: Response) => void = () => undefined;
    const fake = web(false, () => new Promise<Response>((resolve) => (release = resolve)));
    const container = mount(
      <ImagoSWRProvider client={fake.client}>
        <Slot />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (bannerOf(container) === null) throw new Error('not shown');
    });
    const resend = bannerOf(container)?.querySelector('button') as HTMLButtonElement;
    // The press handler runs before React disables the button, as a fast double click does.
    click(resend);
    resend.disabled = false;
    click(resend);
    await settle(() => {
      if (fake.count(`POST ${RESEND_VERIFICATION}`) === 0) throw new Error('not requested');
    });
    release(Response.json({ message: 'sent' }));
    await settle(() => {
      if (toast.success.mock.calls.length === 0) throw new Error('not sent');
    });

    assert({
      given: 'Resend pressed twice before the first send finished',
      should: 'post once',
      actual: fake.count(`POST ${RESEND_VERIFICATION}`),
      expected: 1,
    });
  });

  test('the sent copy omits the address when the profile has none', async () => {
    const fake = fakeWeb({
      'GET /api/auth/me': () => Response.json({ id: 'u', name: 'Ada', emailVerified: false }),
      [`POST ${RESEND_VERIFICATION}`]: () => Response.json({ message: 'sent' }),
    });
    const container = mount(
      <ImagoSWRProvider client={fake.client}>
        <Slot />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (bannerOf(container) === null) throw new Error('not shown');
    });
    click(bannerOf(container)?.querySelector('button') as HTMLButtonElement);
    await settle(() => {
      if (!bannerOf(container)?.textContent?.includes('Verification email sent!')) throw new Error('not sent');
    });

    assert({
      given: 'a profile without an email address',
      should: 'say the email was sent without naming an address',
      actual: bannerOf(container)?.textContent?.includes('Please check your inbox.') && !bannerOf(container)?.textContent?.includes(' at '),
      expected: true,
    });
  });

  test('resend called again while sending is ignored', async () => {
    let release: (response: Response) => void = () => undefined;
    const fake = web(false, () => new Promise<Response>((resolve) => (release = resolve)));
    let latest: ReturnType<typeof useVerifyEmail> | null = null;
    function Probe() {
      latest = useVerifyEmail();
      return null;
    }
    mount(
      <ImagoSWRProvider client={fake.client}>
        <Probe />
      </ImagoSWRProvider>,
    );
    await settle(() => {
      if (latest?.unverified !== true) throw new Error('profile not loaded');
    });
    act(() => void latest?.resend());
    await settle(() => {
      if (latest?.sending !== true) throw new Error('not sending');
    });
    await act(async () => {
      await latest?.resend();
    });
    release(Response.json({ message: 'sent' }));
    await settle(() => {
      if (latest?.sending !== false) throw new Error('still sending');
    });

    assert({ given: 'resend called during a send', should: 'post only once', actual: fake.count(`POST ${RESEND_VERIFICATION}`), expected: 1 });
  });
});
