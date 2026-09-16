import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PlanCard } from '../PlanCard';
import { PLANS, withCreditsCents } from '@/lib/subscription/plans';

describe('PlanCard (MON-6, SEAT-2, A-9)', () => {
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

  it('SEAT-2 the Business card states the org terms: $50 a month, 5 seats included, $10 per extra seat', () => {
    render(<PlanCard plan={PLANS.business} currentTier="pro" />);
    expect(screen.getByTestId('plan-price').textContent).toBe('$50');
    expect(screen.getByTestId('plan-seats').textContent).toBe('per organization · 5 seats included · $10 per extra seat');
  });

  it('A-9 a grandfathered Business subscriber sees their current plan at their current price, not the $50 list price', () => {
    render(<PlanCard plan={PLANS.business} currentTier="business" isCurrentPlan grandfathered />);
    expect(screen.getByTestId('plan-price').textContent).toBe('Your current price');
    expect(screen.queryByTestId('plan-seats')).toBeNull();
    expect(screen.getByText('Current Plan')).toBeTruthy();
  });

  it('A-9 the grandfathered flag changes nothing on a card that is not the current org plan', () => {
    render(<PlanCard plan={PLANS.pro} currentTier="business" grandfathered />);
    expect(screen.getByTestId('plan-price').textContent).toBe('$15');
  });

  it('MON-2 (independent review on #2649) a withCreditsCents-patched plan actually reaches the rendered card, not just the plain object', () => {
    // DOCUMENTATION, not a settings/plan regression guard (independent review,
    // round 2): this renders PlanCard directly from a patched plan object built
    // by calling withCreditsCents here in the test — it never loads
    // settings/plan/page.tsx, so it cannot detect that page dropping the call.
    // withCreditsCents itself is proven in isolation in plans.test.ts. What this
    // test DOES prove: PlanCard's DOM actually reflects a patched plan's numbers
    // rather than some cached/memoized copy of the original. Under D-OW-17 the
    // scenario the original #2643 thread reported — the client bundle and the
    // server disagreeing on the included-credit figure — is no longer possible
    // for ANY plan object: MONEY_MODEL_V2_ACTIVE is a compile-time constant
    // embedded identically in every process, so there is no divergent number
    // left for a dropped override to expose. withCreditsCents/withCreditOverrides
    // remain correct and still exercised here, but are no longer load-bearing
    // for that specific defect.
    const patched = withCreditsCents(PLANS.pro, 900);
    render(<PlanCard plan={patched} currentTier="free" />);
    expect(screen.getByTestId('plan-included-credits').textContent).toBe('900 credits included each month');
    // And an untouched plan is provably unaffected by the same call.
    render(<PlanCard plan={PLANS.free} currentTier="free" />);
    expect(screen.getAllByTestId('plan-included-credits')[1].textContent).toMatch(/^[0-9,]+ credits to start$/);
  });
});
