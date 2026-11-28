// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import BillingPage from './page';
import { fetchWithAuth, post } from '@/retained/lib/auth/auth-fetch';

const state = vi.hoisted(() => ({ billingHidden: false }));

vi.mock('@/retained-adapters/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/retained-adapters/navigation')>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

vi.mock('@/retained/hooks/useBillingVisibility', () => ({
  useBillingVisibility: () => ({
    showBilling: !state.billingHidden,
    hideBilling: state.billingHidden,
    isReady: true,
  }),
}));

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
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

const invoice = (id: string, status: string) => ({
  id,
  number: id,
  status,
  amountDue: 1500,
  amountPaid: status === 'paid' ? 1500 : 0,
  currency: 'usd',
  created: '2026-10-03T12:00:00Z',
  periodStart: null,
  periodEnd: null,
  hostedInvoiceUrl: `https://stripe.example/${id}`,
  invoicePdf: `https://stripe.example/${id}.pdf`,
  description: 'Pro Plan',
});

type Fixtures = {
  upcoming: unknown;
  invoices: unknown[];
  hasMore: boolean;
};

let fixtures: Fixtures;

const respond = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

const serve = (url: string) => {
  if (url === '/api/subscriptions/status') {
    return respond({
      subscriptionTier: 'pro',
      subscription: {
        status: 'active',
        currentPeriodStart: '2026-10-03T12:00:00Z',
        currentPeriodEnd: '2026-11-03T12:00:00Z',
        cancelAtPeriodEnd: false,
      },
    });
  }
  if (url.startsWith('/api/stripe/invoices')) {
    return respond({ invoices: fixtures.invoices, hasMore: fixtures.hasMore });
  }
  if (url === '/api/stripe/upcoming-invoice') {
    return respond({ invoice: fixtures.upcoming });
  }
  if (url === '/api/stripe/billing-address') {
    return respond({ address: { line1: '1 Main St', line2: null, city: 'Austin', state: 'TX', postal_code: '73301', country: 'US' }, name: 'Jono' });
  }
  return respond({});
};

const renderBilling = async () => {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <BillingPage />
    </SWRConfig>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Billing' });
  await screen.findByRole('heading', { level: 2, name: 'Invoice history' });
};

beforeEach(() => {
  vi.clearAllMocks();
  state.billingHidden = false;
  fixtures = {
    upcoming: {
      amountDue: 1500,
      total: 1500,
      currency: 'usd',
      nextPaymentAttempt: '2026-11-03T12:00:00Z',
      lines: [{ description: 'Pro Plan · Nov 3 – Dec 3', amount: 1500 }],
    },
    invoices: [invoice('in_1', 'paid'), invoice('in_2', 'void')],
    hasMore: false,
  };
  fetchMock.mockImplementation(async (url: string) => serve(url));
  postMock.mockResolvedValue({ url: 'https://stripe.example/portal' } as never);
});

afterEach(() => {
  cleanup();
});

describe('BillingPage (/account/billing)', () => {
  test('renders the subscription, payment methods, upcoming invoice, history and address sections', async () => {
    await renderBilling();
    const headings = ['Subscription', 'Payment methods', 'Upcoming invoice', 'Invoice history', 'Billing address'];
    assert({
      given: 'a paid subscriber with an upcoming invoice',
      should: 'render each of the five billing sections as a heading',
      actual: headings.map((name) => screen.queryByRole('heading', { name }) !== null),
      expected: headings.map(() => true),
    });
  });

  test('shows each invoice with its status pill, a PDF and a View link', async () => {
    await renderBilling();
    assert({
      given: 'a paid invoice and a void invoice',
      should: 'show their status pills and a PDF and View action for each',
      actual: {
        paid: screen.getByText('paid').textContent,
        void: screen.getByText('void').textContent,
        pdf: screen.getAllByRole('button', { name: 'Download invoice PDF' }).length,
        view: screen.getAllByRole('button', { name: 'View invoice online' }).length,
      },
      expected: { paid: 'paid', void: 'void', pdf: 2, view: 2 },
    });
  });

  test('loads the next page of invoices from the last invoice id', async () => {
    fixtures.hasMore = true;
    await renderBilling();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => {
      assert({
        given: 'more invoices available after the first page',
        should: 'request the next page starting after the last invoice id',
        actual: fetchMock.mock.calls.some(([url]) => url === '/api/stripe/invoices?limit=10&starting_after=in_2'),
        expected: true,
      });
    });
  });

  test('says so when there is no upcoming invoice', async () => {
    fixtures.upcoming = null;
    await renderBilling();
    assert({
      given: 'no scheduled invoice from Stripe',
      should: 'show the empty upcoming invoice state',
      actual: screen.queryByText('No upcoming invoice') !== null,
      expected: true,
    });
  });

  test('opens the Stripe portal from Manage payment methods', async () => {
    await renderBilling();
    fireEvent.click(screen.getByRole('button', { name: /Manage payment methods/ }));
    await waitFor(() => {
      assert({
        given: 'the payment methods action',
        should: 'create a Stripe portal session through /api/stripe/portal',
        actual: postMock.mock.calls[0]?.[0],
        expected: '/api/stripe/portal',
      });
    });
  });

  test('renders nothing and fetches nothing when billing is disabled', async () => {
    state.billingHidden = true;
    const { container } = render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <BillingPage />
      </SWRConfig>,
    );
    assert({
      given: 'billing disabled for this deployment',
      should: 'render no billing content and make no /api/stripe requests',
      actual: { html: container.innerHTML, stripeCalls: fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/stripe')).length },
      expected: { html: '', stripeCalls: 0 },
    });
  });
});
