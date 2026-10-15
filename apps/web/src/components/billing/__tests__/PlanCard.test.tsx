import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PlanCard } from '../PlanCard';
import { PLANS, withCreditsCents } from '@/lib/subscription/plans';
import { planFacts } from '@pagespace/lib/billing/credit-copy';

describe('PlanCard', () => {
  it('MON-6 shows price, included credits, and the top-up rate as three separate facts, credits as a count with no dollar sign', () => {
    render(<PlanCard plan={PLANS.pro} currentTier="free" />);

    expect(screen.getByTestId('plan-price').textContent).toBe('$15');
    const included = screen.getByTestId('plan-included-credits').textContent ?? '';
    expect(included).toMatch(/^[0-9,]+ credits included each month$/);
    expect(included).not.toContain('$');
    expect(screen.getByTestId('plan-topup-rate').textContent).toMatch(/^[0-9,]+ credits per \$[0-9]+$/);
  });

  it('MON-6 the free card states its one-time starter grant as a count', () => {
    render(<PlanCard plan={PLANS.free} currentTier="free" />);
    expect(screen.getByTestId('plan-price').textContent).toBe('Free');
    expect(screen.getByTestId('plan-included-credits').textContent).toMatch(/^[0-9,]+ credits to start$/);
  });

  it('SEAT-2 (partial) the Business card states the org terms from planFacts: $50 a month, 5 seats included, $10 per extra seat a month', () => {
    render(<PlanCard plan={PLANS.business} currentTier="pro" />);
    const org = planFacts('business').org;
    expect(screen.getByTestId('plan-price').textContent).toBe(planFacts('business').price);
    expect(screen.getByTestId('plan-price').textContent).toBe('$50');
    expect(screen.getByTestId('plan-seats').textContent).toBe(org?.seatTerms);
    expect(screen.getByTestId('plan-seats').textContent).toBe('per organization · 5 seats included · $10 per extra seat a month');
    expect(screen.getByTestId('plan-seat-credits').textContent).toBe(org?.extraSeatCredits);
    expect(screen.getByTestId('plan-seat-credits').textContent).not.toContain('$');
  });

  it('the Business card states no trial (Spec A-7, D-OW-30) and a card at checkout; personal cards carry no org facts', () => {
    render(<PlanCard plan={PLANS.business} currentTier="pro" />);
    expect(screen.getByTestId('plan-checkout').textContent).toBe('No trial · card required at checkout');
    render(<PlanCard plan={PLANS.pro} currentTier="free" />);
    expect(screen.getAllByTestId('plan-seats')).toHaveLength(1);
  });

  it('MON-6 (partial) the in-app card states the same price and top-up facts as the marketing page, from the same source', () => {
    for (const tier of ['pro', 'business'] as const) {
      const { unmount } = render(<PlanCard plan={PLANS[tier]} currentTier="free" />);
      expect(screen.getByTestId('plan-price').textContent, tier).toBe(planFacts(tier).price);
      expect(screen.getByTestId('plan-topup-rate').textContent, tier).toBe(planFacts(tier).topUpRate);
      expect(screen.getByTestId('plan-included-credits').textContent, tier).toBe(planFacts(tier).includedCredits);
      unmount();
    }
  });

  it('A-9 Business always states its organization price and seat terms', () => {
    render(<PlanCard plan={PLANS.business} currentTier="business" isCurrentPlan />);
    expect(screen.getByTestId('plan-price').textContent).toBe('$50');
    expect(screen.getByTestId('plan-seats')).toBeTruthy();
    expect(screen.getByText('Current Plan')).toBeTruthy();
  });

  it('MON-2 (independent review on #2649) a withCreditsCents-patched plan actually reaches the rendered card, not just the plain object', () => {
    // DOCUMENTATION, not a settings/plan regression guard (independent review,
    // round 2): this renders PlanCard directly from a patched plan object built
    // by calling withCreditsCents here in the test — it never loads
    // settings/plan/page.tsx, so it cannot detect that page dropping the call.
    // withCreditsCents itself is proven in isolation in plans.test.ts. What this
    // test DOES prove: PlanCard's DOM actually reflects a patched plan's numbers
    // rather than some cached/memoized copy of the original. 777 is not a figure
    // PLANS.pro resolves to, so a dropped patch cannot pass vacuously.
    const patched = withCreditsCents(PLANS.pro, 7770);
    render(<PlanCard plan={patched} currentTier="free" />);
    expect(screen.getByTestId('plan-included-credits').textContent).toBe('777 credits included each month');
    // And an untouched plan is provably unaffected by the same call.
    render(<PlanCard plan={PLANS.free} currentTier="free" />);
    expect(screen.getAllByTestId('plan-included-credits')[1].textContent).toMatch(/^[0-9,]+ credits to start$/);
  });
});
