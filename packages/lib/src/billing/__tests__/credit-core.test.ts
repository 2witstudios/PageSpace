import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  markupCents,
  chargeMillicents,
  accruePending,
  accrueCharge,
  allocateSpend,
  evaluateGate,
  computeMonthlyRefill,
  applyTopup,
  classifyStripeEvent,
  computeBackfillActions,
} from '../credit-core';
import type { SubscriptionTier } from '../../services/subscription-utils';

const ALLOWANCE: Record<SubscriptionTier, number> = {
  free: 50,
  pro: 1500,
  founder: 5000,
  business: 10000,
};

describe('markupCents', () => {
  it('marks up real cost by 1.5x and returns whole cents', () => {
    // $1.00 real cost -> $1.50 -> 150 cents
    expect(markupCents(1, 15000)).toBe(150);
  });

  it('rounds sub-cent results to the nearest cent', () => {
    // $0.0033 * 1.5 = $0.00495 -> 0.495 cents -> rounds to 0
    expect(markupCents(0.0033, 15000)).toBe(0);
    // $0.01 * 1.5 = $0.015 -> 1.5 cents -> rounds to 2
    expect(markupCents(0.01, 15000)).toBe(2);
  });

  it('returns 0 for zero, negative, or non-finite cost', () => {
    expect(markupCents(0, 15000)).toBe(0);
    expect(markupCents(-5, 15000)).toBe(0);
    expect(markupCents(Number.NaN, 15000)).toBe(0);
  });

  it('honours a custom markup', () => {
    // 2x markup: $1.00 -> 200 cents
    expect(markupCents(1, 20000)).toBe(200);
  });
});

describe('chargeMillicents', () => {
  it('expresses the customer charge in millicents (1/1000 cent) so sub-cent costs survive', () => {
    // $1.00 real -> ×1.5 -> $1.50 -> 150 cents -> 150_000 millicents
    expect(chargeMillicents(1, 15000)).toBe(150_000);
    // $0.0033 real -> ×1.5 -> $0.00495 -> 0.495 cents -> 495 millicents (NOT rounded to 0)
    expect(chargeMillicents(0.0033, 15000)).toBe(495);
  });

  it('returns 0 for zero, negative, or non-finite cost', () => {
    expect(chargeMillicents(0, 15000)).toBe(0);
    expect(chargeMillicents(-5, 15000)).toBe(0);
    expect(chargeMillicents(Number.NaN, 15000)).toBe(0);
  });
});

describe('accruePending', () => {
  it('carries the sub-cent remainder instead of dropping it', () => {
    // 495 millicents alone -> 0 whole cents, 495 carried
    expect(accruePending(0, 495)).toEqual({ wholeCents: 0, newPending: 495 });
  });

  it('crosses a whole cent once accumulated fractions exceed 1000 millicents', () => {
    // 600 carried + 495 charge = 1095 -> 1 whole cent, 95 carried
    expect(accruePending(600, 495)).toEqual({ wholeCents: 1, newPending: 95 });
  });

  it('emits multiple whole cents and keeps newPending in [0, 1000)', () => {
    // 999 carried + 4321 charge = 5320 -> 5 whole cents, 320 carried
    const r = accruePending(999, 4321);
    expect(r).toEqual({ wholeCents: 5, newPending: 320 });
    expect(r.newPending).toBeGreaterThanOrEqual(0);
    expect(r.newPending).toBeLessThan(1000);
  });

  it('clamps negative inputs to zero', () => {
    expect(accruePending(-10, -10)).toEqual({ wholeCents: 0, newPending: 0 });
  });

  it('many sub-cent calls eventually bill a whole cent (remainder carried across calls)', () => {
    // Each $0.0033 call charges 495 millicents -> 0 whole cents alone. After 3
    // calls: 1485 millicents -> the 2nd whole cent crosses, fractions retained.
    let pending = 0;
    let billed = 0;
    for (let i = 0; i < 3; i++) {
      const r = accruePending(pending, chargeMillicents(0.0033, 15000));
      billed += r.wholeCents;
      pending = r.newPending;
    }
    // 3 × 495 = 1485 millicents -> 1 whole cent billed, 485 carried.
    expect(billed).toBe(1);
    expect(pending).toBe(485);
  });
});

describe('accrueCharge', () => {
  it('composes chargeMillicents into accruePending', () => {
    // $1.00 -> 150_000 millicents + 0 pending -> 150 whole cents, 0 carried
    expect(accrueCharge(0, 1, 15000)).toEqual({ wholeCents: 150, newPending: 0 });
  });
});

describe('allocateSpend', () => {
  it('draws entirely from the monthly bucket when it covers the spend', () => {
    const r = allocateSpend({ monthlyCents: 500, topupCents: 1000 }, 200);
    expect(r).toEqual({
      monthlyCents: 300,
      topupCents: 1000,
      spentMonthly: 200,
      spentTopup: 0,
      appliedCents: 200,
      shortfallCents: 0,
    });
  });

  it('spills into the top-up bucket only after monthly is exhausted', () => {
    const r = allocateSpend({ monthlyCents: 100, topupCents: 1000 }, 250);
    expect(r.spentMonthly).toBe(100);
    expect(r.spentTopup).toBe(150);
    expect(r.monthlyCents).toBe(0);
    expect(r.topupCents).toBe(850);
    expect(r.appliedCents).toBe(250);
    expect(r.shortfallCents).toBe(0);
  });

  it('reports a shortfall and the actually-applied amount when both buckets are insufficient', () => {
    const r = allocateSpend({ monthlyCents: 30, topupCents: 20 }, 100);
    expect(r.spentMonthly).toBe(30);
    expect(r.spentTopup).toBe(20);
    expect(r.monthlyCents).toBe(0);
    expect(r.topupCents).toBe(0);
    // 30 + 20 covered, 50 owed -> applied 50, shortfall 50 (sum back to the 100 charge)
    expect(r.appliedCents).toBe(50);
    expect(r.shortfallCents).toBe(50);
  });

  it('is a no-op for a zero spend', () => {
    const r = allocateSpend({ monthlyCents: 100, topupCents: 100 }, 0);
    expect(r.monthlyCents).toBe(100);
    expect(r.topupCents).toBe(100);
    expect(r.appliedCents).toBe(0);
    expect(r.shortfallCents).toBe(0);
  });
});

describe('evaluateGate', () => {
  it('allows unconditionally when billing is disabled (tenant/onprem)', () => {
    expect(evaluateGate({ billingEnabled: false, balance: null, reserveFloorCents: 0 }))
      .toEqual({ allowed: true, reason: 'unlimited' });
  });

  it('returns needs_init when no balance row exists', () => {
    expect(evaluateGate({ billingEnabled: true, balance: null, reserveFloorCents: 0 }))
      .toEqual({ allowed: false, reason: 'needs_init' });
  });

  it('allows when spendable exceeds the reserve floor', () => {
    expect(evaluateGate({ billingEnabled: true, balance: { monthlyCents: 0, topupCents: 10 }, reserveFloorCents: 0 }))
      .toEqual({ allowed: true, reason: 'ok' });
  });

  it('denies with out_of_credits at or below the reserve floor', () => {
    expect(evaluateGate({ billingEnabled: true, balance: { monthlyCents: 0, topupCents: 0 }, reserveFloorCents: 0 }))
      .toEqual({ allowed: false, reason: 'out_of_credits' });
    // exact-floor boundary: spendable == floor -> denied
    expect(evaluateGate({ billingEnabled: true, balance: { monthlyCents: 5, topupCents: 0 }, reserveFloorCents: 5 }).allowed)
      .toBe(false);
  });
});

describe('computeMonthlyRefill', () => {
  it('resets remaining to the full tier allowance', () => {
    expect(computeMonthlyRefill('pro', ALLOWANCE)).toEqual({
      monthlyRemainingCents: 1500,
      monthlyAllowanceCents: 1500,
    });
    expect(computeMonthlyRefill('business', ALLOWANCE).monthlyAllowanceCents).toBe(10000);
  });

  it('falls back to the free allowance for an unknown tier', () => {
    expect(computeMonthlyRefill('enterprise' as SubscriptionTier, ALLOWANCE))
      .toEqual({ monthlyRemainingCents: 50, monthlyAllowanceCents: 50 });
  });
});

describe('applyTopup', () => {
  it('adds the pack amount to the existing top-up balance', () => {
    expect(applyTopup(0, 1000)).toBe(1000);
    expect(applyTopup(1000, 2500)).toBe(3500);
  });

  it('throws on a negative pack amount', () => {
    expect(() => applyTopup(0, -100)).toThrow();
  });
});

describe('classifyStripeEvent', () => {
  it('maps invoice.paid to a monthly refill', () => {
    expect(classifyStripeEvent({ type: 'invoice.paid', data: { object: {} } }))
      .toEqual({ kind: 'monthly_refill' });
  });

  it('maps a credit-pack checkout to a top-up with the pack cents', () => {
    const action = classifyStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { mode: 'payment', metadata: { kind: 'credit_pack', packCents: '2500' } } },
    });
    expect(action).toEqual({ kind: 'topup', packCents: 2500 });
  });

  it('ignores a credit-pack checkout whose packCents is non-canonical (e.g. "2500usd")', () => {
    expect(classifyStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { mode: 'payment', metadata: { kind: 'credit_pack', packCents: '2500usd' } } },
    })).toEqual({ kind: 'ignore' });
  });

  it('ignores a credit-pack checkout with zero or missing packCents', () => {
    expect(classifyStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { mode: 'payment', metadata: { kind: 'credit_pack', packCents: '0' } } },
    })).toEqual({ kind: 'ignore' });
    expect(classifyStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { mode: 'payment', metadata: { kind: 'credit_pack' } } },
    })).toEqual({ kind: 'ignore' });
  });

  it('ignores a non-credit-pack checkout (e.g. subscription mode)', () => {
    expect(classifyStripeEvent({
      type: 'checkout.session.completed',
      data: { object: { mode: 'subscription', metadata: {} } },
    })).toEqual({ kind: 'ignore' });
  });

  it('maps subscription updates to a tier change', () => {
    expect(classifyStripeEvent({ type: 'customer.subscription.updated', data: { object: {} } }))
      .toEqual({ kind: 'tier_change' });
  });

  it('ignores unrelated events', () => {
    expect(classifyStripeEvent({ type: 'payment_intent.succeeded', data: { object: {} } }))
      .toEqual({ kind: 'ignore' });
  });
});

describe('computeBackfillActions', () => {
  it('plans a retry for each pending ledger row and an apply for each orphan usage row', () => {
    const actions = computeBackfillActions(
      [{ id: 'led_1' }, { id: 'led_2' }],
      [{ aiUsageLogId: 'aul_1', userId: 'u1', costDollars: 0.5 }],
    );
    expect(actions).toEqual([
      { kind: 'retry_pending', ledgerId: 'led_1' },
      { kind: 'retry_pending', ledgerId: 'led_2' },
      { kind: 'apply_orphan', aiUsageLogId: 'aul_1', userId: 'u1', costDollars: 0.5 },
    ]);
  });

  it('returns no actions when nothing is unsettled', () => {
    expect(computeBackfillActions([], [])).toEqual([]);
  });
});

describe('credit-core purity', () => {
  it('imports no db, stripe, env, or Date — it is a pure decision layer', () => {
    const src = readFileSync(fileURLToPath(new URL('../credit-core.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/from ['"]stripe['"]/);
    expect(src).not.toMatch(/from ['"][^'"]*\/db['"]/);
    expect(src).not.toMatch(/from ['"][^'"]*deployment-mode['"]/);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/Date\.now/);
    expect(src).not.toMatch(/new Date\b/);
  });
});
