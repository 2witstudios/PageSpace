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
    // 900 is deliberately NOT what PLANS.pro's own built-in figure resolves to
    // today (1,500 under the current MONEY_MODEL_V2_ACTIVE=false default) — if
    // the server-supplied override were dropped, the card would show the
    // module's own number instead and this assertion would fail.
    mockStatusResponse({
      subscriptionTier: 'free',
      planCredits: { free: 500, pro: 900, business: 5000 },
    });

    render(<PlanPage />);

    await waitFor(() => {
      expect(screen.getByText('900 credits included each month')).toBeInTheDocument();
    });
    // The free tier's own card is unaffected by the pro override.
    expect(screen.getByText('500 credits to start')).toBeInTheDocument();
  });
});
