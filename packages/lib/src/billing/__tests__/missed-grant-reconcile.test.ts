import { describe, it, expect } from 'vitest';
import { planMissedGrantReconcile } from '../missed-grant-reconcile';
import { allowanceCentsForPaidCents } from '../money-model';

describe('planMissedGrantReconcile (pure core)', () => {
  it('MON-2 missed grant: a row whose re-resolved tier now has a ratio grants amount_paid × ratio', () => {
    const plan = planMissedGrantReconcile({ id: 'led_1', userId: 'u1', paidCents: 1500 }, 'pro');
    expect(plan).toEqual({
      id: 'led_1',
      userId: 'u1',
      tier: 'pro',
      allowanceCents: allowanceCentsForPaidCents(1500, 'pro'),
      action: 'grant',
    });
  });

  it('MON-2 missed grant: a row whose re-resolved tier STILL has no ratio (free) stays missing', () => {
    const plan = planMissedGrantReconcile({ id: 'led_2', userId: 'u2', paidCents: 1500 }, 'free');
    expect(plan).toMatchObject({ action: 'still_missing', allowanceCents: 0, tier: 'free' });
  });

  it('MON-2 missed grant: an unknown/legacy tier string coerces to free and stays missing', () => {
    const plan = planMissedGrantReconcile({ id: 'led_3', userId: 'u3', paidCents: 1500 }, 'unknown-legacy-tier');
    expect(plan).toMatchObject({ action: 'still_missing', tier: 'free' });
  });

  it('MON-2 missed grant: paidCents 0 (should not normally occur) grants nothing and stays missing', () => {
    const plan = planMissedGrantReconcile({ id: 'led_4', userId: 'u4', paidCents: 0 }, 'business');
    expect(plan).toMatchObject({ action: 'still_missing', allowanceCents: 0 });
  });

  it('MON-2 missed grant: derives from the SAME allowanceCentsForPaidCents every other grant path uses', () => {
    const plan = planMissedGrantReconcile({ id: 'led_5', userId: 'u5', paidCents: 5000 }, 'business');
    expect(plan.allowanceCents).toBe(allowanceCentsForPaidCents(5000, 'business'));
  });
});
