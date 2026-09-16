import { render, screen, waitFor } from '@testing-library/react';
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
    mocks.getCachedCSRFToken.mockReturnValue('csrf-token');
  });

  it('MON-2 (independent review on #2649, D-OW-17) shows the server-supplied planCredits figure on the Pro card, not the plan module\'s own built-in number', async () => {
    // 777 is deliberately NOT a figure PLANS.pro can resolve to in EITHER state of
    // MONEY_MODEL_V2_ACTIVE: 1,500 while it is false, 900 once the migration commit
    // flips it. It must never be 900 or 1,500 — either one equals the built-in
    // number in one of the two states, and in that state a dropped override would
    // render the same text and this guard would pass vacuously. If the
    // server-supplied override is dropped, the card shows the module's own number
    // instead and this assertion fails, before and after the flip.
    mockStatusResponse({
      subscriptionTier: 'free',
      planCredits: { free: 500, pro: 777, business: 7777 },
    });

    render(<PlanPage />);

    // Scoped to the plan-included-credits testid on the CARDS specifically —
    // the Feature Comparison table's "Credits" row renders the identical
    // string via creditsCellPhrase for the free tier ("500 credits to start"),
    // so an unscoped getByText('500 credits to start') matches two elements
    // and throws (caught in review: this test was red as first committed).
    // getPersonalPlans('free') orders plans ['free', 'pro'], and the card grid
    // maps that array in order, so index 0 is the Free card and index 1 is Pro.
    await waitFor(() => {
      const cards = screen.getAllByTestId('plan-included-credits');
      expect(cards).toHaveLength(2);
    });
    const [freeCard, proCard] = screen.getAllByTestId('plan-included-credits');
    expect(freeCard).toHaveTextContent('500 credits to start');
    // The card that actually matters for this regression: the server-supplied
    // override (777), not the plan module's own built-in number (1,500 today, 900
    // after the migration-day flip).
    expect(proCard).toHaveTextContent('777 credits included each month');
  });
});
