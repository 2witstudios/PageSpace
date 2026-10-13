// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// The plan page waits on several mocked requests; under a full coverage run 1s was not always enough.
configure({ asyncUtilTimeout: 5000 });
import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';
import PlanPage from './page';
import { fetchWithAuth, post } from '@/retained/lib/auth/auth-fetch';

const state = vi.hoisted(() => ({
  tier: 'pro' as 'free' | 'pro',
  billingHidden: false,
  query: '',
}));

const pushMock = vi.hoisted(() => vi.fn());
const replaceMock = vi.hoisted(() => vi.fn());

vi.mock('@/retained-adapters/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/retained-adapters/navigation')>()),
  useRouter: () => ({ push: pushMock, replace: replaceMock, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(state.query),
}));

vi.mock('@/retained/hooks/useBillingVisibility', () => ({
  useBillingVisibility: () => ({
    showBilling: !state.billingHidden,
    hideBilling: state.billingHidden,
    isReady: true,
  }),
}));

vi.mock('@/retained/hooks/useCreditBalance', () => ({
  useCreditBalance: () => ({
    balance: {
      billingEnabled: true,
      monthly: { remaining: 900, allowance: 1500, periodEnd: '2026-11-03T12:00:00Z' },
      topup: { remaining: 0 },
      debt: 0,
      spendable: 900,
      reserved: 0,
      subscriptionTier: state.tier,
    },
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  post: vi.fn(),
  getCachedCSRFToken: vi.fn(),
}));

vi.mock('@/retained-adapters/theme', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.mock('@/retained/components/billing/EmbeddedCheckoutForm', () => ({
  EmbeddedCheckoutForm: () => null,
}));

vi.mock('@/retained/components/billing/StripeProvider', () => ({
  StripeProvider: ({ children }: { children: ReactNode }) => children,
}));

// Radix measures its popups and switches with ResizeObserver, which jsdom does not provide.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

const fetchMock = vi.mocked(fetchWithAuth);
const postMock = vi.mocked(post);

const respondWithTier = (tier: 'free' | 'pro') => {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/subscriptions/status') {
      return { ok: true, json: async () => ({ subscriptionTier: tier }) } as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
};

const renderPlan = async () => {
  const view = render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PlanPage />
    </SWRConfig>,
  );
  // The "Plan" heading renders inside the loading state, so waiting on it left every
  // synchronous query below racing the plan data under a full coverage run; the lede
  // only exists once the data has loaded.
  await screen.findByText(/^You're on /);
  return view;
};

beforeEach(() => {
  vi.clearAllMocks();
  state.tier = 'pro';
  state.billingHidden = false;
  state.query = '';
  respondWithTier('pro');
});

afterEach(() => {
  cleanup();
});

describe('PlanPage (/account/plan)', () => {
  test('ledes the current plan with its whole-credit allowance and renewal date', async () => {
    await renderPlan();
    assert({
      given: 'a Pro subscriber with a 15 credit monthly allowance renewing Nov 3',
      should: 'lede the page with the tier, the included credits and the renewal date',
      actual: screen.getByText(/^You're on Pro/).textContent,
      expected: "You're on Pro · 15 credits included each month · renews Nov 3",
    });
  });

  test('renders the Free and Pro columns, tagging the current plan, and no Business column', async () => {
    await renderPlan();
    const columns = screen.getByText('Current Plan').closest('.overflow-hidden') as HTMLElement;
    const headings = Array.from(columns.querySelectorAll('.text-\\[15px\\]')).map((node) => node.textContent);
    assert({
      given: 'a Pro subscriber on orgs-off billing',
      should: 'render the Free and Pro tier columns with Current Plan on Pro and no Business column',
      actual: {
        headings,
        current: screen.getByText('Current Plan').closest('div')?.textContent,
        business: screen.queryByText(/Business/),
      },
      expected: {
        headings: ['Free', 'Pro'],
        current: 'ProCurrent Plan',
        business: null,
      },
    });
  });

  test('renders the feature comparison with whole-credit rows for Free and Pro', async () => {
    await renderPlan();
    const table = screen.getByRole('table');
    assert({
      given: 'the plan page',
      should: 'list credits, AI models, top-ups, storage and max file size for Free and Pro',
      actual: {
        rows: within(table).getAllByRole('row').map((row) => row.textContent),
      },
      expected: {
        rows: [
          'FeatureFreePro',
          'Credits5 credits to start15 credits/mo',
          'AI modelsStandardStandard + Pro',
          'Buy more credits10 credits per $1010 credits per $10',
          'Storage500MB2GB',
          'Max File Size50MB250MB',
        ],
      },
    });
  });

  test('applies a valid promo code through the validate endpoint', async () => {
    postMock.mockResolvedValue({
      valid: true,
      promotionCodeId: 'promo_1',
      coupon: { id: 'c1', name: 'Launch', percentOff: 20, amountOff: null, currency: null, duration: 'once', durationInMonths: null },
      discount: { originalAmount: 1500, discountedAmount: 1200, savings: 300, savingsFormatted: '$3' },
    });
    await renderPlan();
    const promo = screen.getByRole('group', { name: 'Promo code' });
    const input = within(promo).getByPlaceholderText('Enter promo code');
    fireEvent.change(input, { target: { value: 'launch' } });
    fireEvent.click(within(promo).getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      assert({
        given: 'a valid promo code typed into the header field',
        should: 'validate it through /api/stripe/validate-promo-code',
        actual: postMock.mock.calls[0]?.[0],
        expected: '/api/stripe/validate-promo-code',
      });
    });
  });

  test('shows the promo error for an invalid code', async () => {
    postMock.mockResolvedValue({ valid: false, error: 'Code expired' });
    await renderPlan();
    const promo = screen.getByRole('group', { name: 'Promo code' });
    fireEvent.change(within(promo).getByPlaceholderText('Enter promo code'), { target: { value: 'OLD' } });
    fireEvent.click(within(promo).getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      assert({
        given: 'a promo code the server rejects',
        should: 'show the server error next to the field',
        actual: screen.queryByText('Code expired') !== null,
        expected: true,
      });
    });
  });

  test('offers the downgrade to Free from a Pro plan, and no upgrade', async () => {
    await renderPlan();
    assert({
      given: 'a Pro subscriber',
      should: 'offer Downgrade to Free Plan and Manage Billing, not Upgrade to Pro',
      actual: {
        downgrade: screen.queryByRole('button', { name: 'Downgrade to Free Plan' }) !== null,
        manage: screen.queryByRole('button', { name: 'Manage Billing' }) !== null,
        upgrade: screen.queryByRole('button', { name: 'Upgrade to Pro' }) !== null,
      },
      expected: { downgrade: true, manage: true, upgrade: false },
    });
  });

  test('offers Upgrade to Pro, and no downgrade, from the free plan', async () => {
    state.tier = 'free';
    respondWithTier('free');
    await renderPlan();
    assert({
      given: 'a free subscriber',
      should: 'offer Upgrade to Pro and no Downgrade to Free Plan button',
      actual: {
        upgrade: screen.queryByRole('button', { name: 'Upgrade to Pro' }) !== null,
        downgrade: screen.queryByRole('button', { name: 'Downgrade to Free Plan' }) !== null,
      },
      expected: { upgrade: true, downgrade: false },
    });
  });

  test('confirms when a plan change was canceled at Stripe', async () => {
    state.query = 'canceled=true';
    await renderPlan();
    assert({
      given: 'a return from a canceled plan change',
      should: 'show the canceled alert',
      actual: screen.queryByText(/Subscription change was canceled/) !== null,
      expected: true,
    });
  });

  test('applies a header promo to the Pro subscription when checkout starts', async () => {
    state.tier = 'free';
    respondWithTier('free');
    postMock.mockImplementation(async (url: string) => {
      if (url === '/api/stripe/validate-promo-code') {
        return {
          valid: true,
          promotionCodeId: 'promo_1',
          coupon: { id: 'c1', name: 'Launch', percentOff: 20, amountOff: null, currency: null, duration: 'once', durationInMonths: null },
          discount: { originalAmount: 1500, discountedAmount: 1200, savings: 300, savingsFormatted: '$3' },
        } as never;
      }
      if (url === '/api/stripe/create-subscription') return { clientSecret: 'cs_1', subscriptionId: 'sub_1' } as never;
      if (url === '/api/stripe/apply-promo') return { success: true, subscriptionId: 'sub_2', clientSecret: 'cs_2' } as never;
      return {} as never;
    });
    await renderPlan();
    const promo = screen.getByRole('group', { name: 'Promo code' });
    fireEvent.change(within(promo).getByPlaceholderText('Enter promo code'), { target: { value: 'launch' } });
    fireEvent.click(within(promo).getByRole('button', { name: 'Apply' }));
    await within(promo).findByText('LAUNCH');
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to Pro' }));
    await waitFor(() => {
      assert({
        given: 'a validated header promo and a free subscriber starting Pro checkout',
        should: 'apply the promo to the new subscription through /api/stripe/apply-promo',
        actual: postMock.mock.calls.find(([url]) => url === '/api/stripe/apply-promo')?.[1],
        expected: { subscriptionId: 'sub_1', promotionCodeId: 'promo_1' },
      });
    });
  });

  test('does not render the route when billing is disabled', async () => {
    state.billingHidden = true;
    const { container } = render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <PlanPage />
      </SWRConfig>,
    );
    assert({
      given: 'billing disabled for this deployment',
      should: 'render nothing and redirect away from the plan route',
      actual: { html: container.innerHTML, replaced: replaceMock.mock.calls.length > 0 },
      expected: { html: '', replaced: true },
    });
  });
});
