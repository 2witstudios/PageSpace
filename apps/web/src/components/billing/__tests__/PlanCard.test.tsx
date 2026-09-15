import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PlanCard } from '../PlanCard';
import { PLANS } from '@/lib/subscription/plans';

describe('PlanCard (MON-6, SEAT-2, A-9)', () => {
  it('MON-6 shows price, included credits, and the top-up rate as three separate facts, credits as a count with no dollar sign', () => {
    render(<PlanCard plan={PLANS.pro} currentTier="free" />);

    expect(screen.getByTestId('plan-price').textContent).toBe('$15');
    const included = screen.getByTestId('plan-included-credits').textContent ?? '';
    expect(included).toMatch(/^\d+ credits included each month$/);
    expect(included).not.toContain('$');
    expect(screen.getByTestId('plan-topup-rate').textContent).toMatch(/^\$\d+ buys \d+ credits$/);
  });

  it('MON-6 the free card states its one-time starter grant as a count', () => {
    render(<PlanCard plan={PLANS.free} currentTier="free" />);
    expect(screen.getByTestId('plan-price').textContent).toBe('Free');
    expect(screen.getByTestId('plan-included-credits').textContent).toMatch(/^\d+ credits to start$/);
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
});
