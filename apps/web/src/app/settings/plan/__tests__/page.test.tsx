import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PlanPage from '../page';

/**
 * D-OW-17/D-OW-18, requested twice by point-guard (independent review round 2,
 * then again after a comment-only push was mistakenly reported as a fix): the
 * REAL settings/plan render test. Mocks /api/subscriptions/status to return a
 * server-derived planCredits figure that DIFFERS from PLANS.pro's own built-in
 * number, and asserts the rendered Pro card shows the server's figure. Revert
 * the `withCreditOverrides(...)` call in page.tsx to `getPersonalPlans(...)`
 * (dropping the patch) and this test goes red while every other assertion
 * about the page keeps passing — that is exactly the #2643 regression this
 * guards against, at the actual settings/plan page, not a synthetic call to
 * withCreditsCents in isolation (PlanCard.test.tsx).
 */

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  fetchWithAuth: vi.fn(),
  post: vi.fn(),
  getCachedCSRFToken: vi.fn(() => 'csrf-token'),
  channel: 'stripe' as 'stripe' | 'apple' | 'none',
  purchaseAppleProduct: vi.fn(),
}));

vi.mock('@/hooks/useBillingVisibility', () => ({
  useBillingVisibility: () => ({
    channel: mocks.channel,
    showBilling: mocks.channel === 'stripe',
    hideBilling: mocks.channel !== 'stripe',
    isReady: true,
    showPurchases: mocks.channel !== 'none',
  }),
}));

vi.mock('@/hooks/useAppleProducts', () => ({
  useAppleProducts: () => ({
    pro: {
      kind: 'subscription',
      productId: 'ai.pagespace.ios.pro.monthly',
      tier: 'pro',
      displayName: 'PageSpace Pro',
      description: '',
      displayPrice: '19,99 €',
      subscriptionPeriod: { unit: 'month', value: 1 },
    },
    creditPacks: [],
    products: [],
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('@/lib/iap/apple-store', () => ({
  purchaseAppleProduct: mocks.purchaseAppleProduct,
  restoreApplePurchases: vi.fn(),
  manageAppleSubscriptions: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mocks.fetchWithAuth,
  post: mocks.post,
  getCachedCSRFToken: mocks.getCachedCSRFToken,
}));

// BillingGuard's own visibility logic (useCapacitor/isBillingEnabled) is
// covered by its own suite; stubbing it to a passthrough keeps this test
// about the plan page's own credit-figure wiring, not platform detection.
vi.mock('@/components/billing/BillingGuard', () => ({
  BillingGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function mockStatusResponse(body: Record<string, unknown>) {
  mocks.fetchWithAuth.mockResolvedValue({
    ok: true,
    json: async () => body,
  });
}

describe('PlanPage (D-OW-17: the real settings/plan regression guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.channel = 'stripe';
    mocks.getCachedCSRFToken.mockReturnValue('csrf-token');
  });

  it('MON-2 (independent review on #2649, D-OW-17) shows the server-supplied planCredits figure on the Pro card, not the plan module\'s own built-in number', async () => {
    // 7,770¢ (777 credits) is deliberately NOT a figure PLANS.pro resolves to (900¢): a dropped
    // override would render the module's own number and this assertion fails,
    // never passing vacuously.
    mockStatusResponse({
      subscriptionTier: 'free',
      planCredits: { free: 500, pro: 7770, business: 77770 },
    });

    render(<PlanPage />);

    // Scoped to the plan-included-credits testid on the CARDS specifically —
    // the Feature Comparison table's "Credits" row renders the identical
    // string via creditsCellPhrase for the free tier ("50 credits to start"),
    // so an unscoped getByText('50 credits to start') matches two elements
    // and throws (caught in review: this test was red as first committed).
    // getPersonalPlans('free') orders plans ['free', 'pro'], and the card grid
    // maps that array in order, so index 0 is the Free card and index 1 is Pro.
    await waitFor(() => {
      const cards = screen.getAllByTestId('plan-included-credits');
      expect(cards).toHaveLength(2);
    });
    const [freeCard, proCard] = screen.getAllByTestId('plan-included-credits');
    expect(freeCard).toHaveTextContent('50 credits to start');
    // The card that actually matters for this regression: the server-supplied
    // override (777), not the plan module's own built-in number (90).
    expect(proCard).toHaveTextContent('777 credits included each month');
  });
});

describe('PlanPage on the Apple channel (iOS with StoreKit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.channel = 'apple';
  });

  it('sells Pro at StoreKit\'s localized price, with the disclosure and legal links, and no Stripe plan cards', async () => {
    mockStatusResponse({ subscriptionTier: 'free', billingProvider: null, appStore: null });
    render(<PlanPage />);

    await waitFor(() => expect(screen.getByTestId('apple-plan-panel')).toBeInTheDocument());
    expect(screen.getByTestId('apple-plan-price')).toHaveTextContent('19,99 €/month');
    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Restore Purchases' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage Subscription' })).not.toBeInTheDocument();
    expect(screen.getByTestId('apple-auto-renew-disclosure')).toHaveTextContent(/renews automatically each month/);
    // Apple's standard EULA: our /terms page states web prices and links to web checkout.
    expect(screen.getByRole('link', { name: 'Terms of Use' })).toHaveAttribute('href', 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/');
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
    // No web price, no Stripe upgrade CTA.
    expect(screen.queryByTestId('plan-price')).not.toBeInTheDocument();
    expect(screen.queryByText(/Upgrade to/)).not.toBeInTheDocument();
  });

  it('refetches the plan when an App Store purchase completes in the background (Ask to Buy approval)', async () => {
    mockStatusResponse({ subscriptionTier: 'free', billingProvider: null, appStore: null });
    render(<PlanPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Subscribe' })).toBeInTheDocument());

    mockStatusResponse({ subscriptionTier: 'pro', billingProvider: 'apple', appStore: { status: 'active' } });
    window.dispatchEvent(new Event('pagespace:apple-billing-changed'));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Manage Subscription' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Subscribe' })).not.toBeInTheDocument();
  });

  it('offers no Subscribe while the subscription status is unknown (it may already be paid on the web)', async () => {
    mocks.fetchWithAuth.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    render(<PlanPage />);

    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('apple-plan-panel')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Subscribe' })).not.toBeInTheDocument();
  });

  it('offers Manage Subscription to an App Store subscriber', async () => {
    mockStatusResponse({ subscriptionTier: 'pro', billingProvider: 'apple', appStore: { status: 'active' } });
    render(<PlanPage />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Manage Subscription' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Subscribe' })).not.toBeInTheDocument();
  });

  it('says a Stripe plan is managed on the web — no button, no link', async () => {
    mockStatusResponse({ subscriptionTier: 'pro', billingProvider: 'stripe', appStore: null });
    render(<PlanPage />);

    await waitFor(() => expect(screen.getByText('Your plan is managed on the web.')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Subscribe' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage Subscription' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore Purchases' })).not.toBeInTheDocument();
    expect(screen.queryByText(/https?:\/\//)).not.toBeInTheDocument();
  });

  it('buys Pro through In-App Purchase and never calls a Stripe route', async () => {
    mockStatusResponse({ subscriptionTier: 'free', billingProvider: null, appStore: null });
    mocks.purchaseAppleProduct.mockResolvedValue({ status: 'success', subscriptionTier: 'pro', kind: 'subscription' });
    render(<PlanPage />);

    const subscribe = await screen.findByRole('button', { name: 'Subscribe' });
    await userEvent.click(subscribe);

    await waitFor(() => expect(mocks.purchaseAppleProduct).toHaveBeenCalledWith('ai.pagespace.ios.pro.monthly'));
    await waitFor(() => expect(screen.getByText('Your subscription is active.')).toBeInTheDocument());
    expect(mocks.post).not.toHaveBeenCalledWith(expect.stringMatching(/^\/api\/stripe\//), expect.anything());
  });
});

describe('PlanPage on the web for an App Store subscriber', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.channel = 'stripe';
  });

  it('shows "Managed in the App Store" instead of Stripe plan controls', async () => {
    mockStatusResponse({ subscriptionTier: 'pro', billingProvider: 'apple', appStore: { status: 'active' } });
    render(<PlanPage />);

    await waitFor(() => expect(screen.getByTestId('managed-in-app-store')).toBeInTheDocument());
    expect(screen.getByTestId('managed-in-app-store')).toHaveTextContent(/Settings › Apple ID › Subscriptions/);
    expect(screen.queryByRole('button', { name: /Manage Billing|Downgrade to|Upgrade to/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('apple-plan-panel')).not.toBeInTheDocument();
  });
});
