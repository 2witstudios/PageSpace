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
  evaluateDailyCap,
  reservationCents,
  estimateChatHoldCents,
  holdExpiresAt,
  computeMonthlyRefill,
  applyPaymentToDebt,
  validateTopupAmountCents,
  classifyStripeEvent,
  computeBackfillActions,
  computeCostDrift,
  computeBalanceDrift,
  isNegativeMargin,
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

  it('subtracts outstanding holds and this call\'s reservation from spendable', () => {
    // 100 spendable, 25 floor. Two 25¢ holds already reserved + a 25¢ reservation
    // for this call => effective spendable 100 - 50 - 25 = 25 == floor => denied.
    expect(evaluateGate({
      billingEnabled: true,
      balance: { monthlyCents: 100, topupCents: 0 },
      reserveFloorCents: 25,
      reservedCents: 50,
      estCostCents: 25,
    }).allowed).toBe(false);
    // Drop one outstanding hold (reserved 25): 100 - 25 - 25 = 50 > 25 => allowed.
    expect(evaluateGate({
      billingEnabled: true,
      balance: { monthlyCents: 100, topupCents: 0 },
      reserveFloorCents: 25,
      reservedCents: 25,
      estCostCents: 25,
    })).toEqual({ allowed: true, reason: 'ok' });
  });

  it('denies with too_many_in_flight when the in-flight count has reached the cap', () => {
    // Cap reached even though the user has ample credit — the concurrency limiter
    // fires first and is a distinct reason from out_of_credits.
    expect(evaluateGate({
      billingEnabled: true,
      balance: { monthlyCents: 10_000, topupCents: 0 },
      reserveFloorCents: 25,
      inFlightCount: 2,
      maxInFlight: 2,
    })).toEqual({ allowed: false, reason: 'too_many_in_flight' });
  });

  it('allows under the in-flight cap', () => {
    expect(evaluateGate({
      billingEnabled: true,
      balance: { monthlyCents: 10_000, topupCents: 0 },
      reserveFloorCents: 25,
      inFlightCount: 1,
      maxInFlight: 2,
    }).reason).toBe('ok');
  });

  it('subtracts outstanding debt from spendable (must be net-positive to spend)', () => {
    // 100 monthly, 0 floor, but 100 owed -> net 0 -> denied.
    expect(evaluateGate({
      billingEnabled: true,
      balance: { monthlyCents: 100, topupCents: 0, debtCents: 100 },
      reserveFloorCents: 0,
    })).toEqual({ allowed: false, reason: 'out_of_credits' });
    // Debt smaller than the buckets -> still net-positive above floor -> allowed.
    expect(evaluateGate({
      billingEnabled: true,
      balance: { monthlyCents: 100, topupCents: 50, debtCents: 100 },
      reserveFloorCents: 25,
    })).toEqual({ allowed: true, reason: 'ok' });
  });

  it('treats debt that drags net to/under the floor as out_of_credits', () => {
    // monthly 30 + topup 0 - debt 5 = 25 == floor -> denied.
    expect(evaluateGate({
      billingEnabled: true,
      balance: { monthlyCents: 30, topupCents: 0, debtCents: 5 },
      reserveFloorCents: 25,
    }).allowed).toBe(false);
  });

  it('treats a missing/negative debtCents as zero debt', () => {
    expect(evaluateGate({
      billingEnabled: true,
      balance: { monthlyCents: 10, topupCents: 0 },
      reserveFloorCents: 0,
    }).reason).toBe('ok');
    expect(evaluateGate({
      billingEnabled: true,
      balance: { monthlyCents: 10, topupCents: 0, debtCents: -999 },
      reserveFloorCents: 0,
    }).reason).toBe('ok');
  });

  it('applies no in-flight cap when maxInFlight is null/undefined (paid tiers)', () => {
    expect(evaluateGate({
      billingEnabled: true,
      balance: { monthlyCents: 10_000, topupCents: 0 },
      reserveFloorCents: 25,
      inFlightCount: 99,
      maxInFlight: null,
    }).allowed).toBe(true);
  });

  it('checks the in-flight cap BEFORE credits (a capped user with credit still 429s, not 402)', () => {
    expect(evaluateGate({
      billingEnabled: true,
      balance: { monthlyCents: 0, topupCents: 0 },
      reserveFloorCents: 25,
      inFlightCount: 5,
      maxInFlight: 2,
    }).reason).toBe('too_many_in_flight');
  });
});

describe('reservationCents', () => {
  it('rounds a positive estimate to whole cents', () => {
    expect(reservationCents(25)).toBe(25);
    expect(reservationCents(24.6)).toBe(25);
  });

  it('clamps a non-positive or non-finite estimate to 0 (hold still counts in-flight)', () => {
    expect(reservationCents(0)).toBe(0);
    expect(reservationCents(-5)).toBe(0);
    expect(reservationCents(Number.NaN)).toBe(0);
  });
});

describe('evaluateDailyCap', () => {
  it('always allows when the cap is disabled (null), regardless of spend', () => {
    expect(evaluateDailyCap({ dailyChargedCents: 1_000_000, estCostCents: 25, capCents: null }))
      .toEqual({ allowed: true, reason: 'ok' });
  });

  it('allows when day spend + this call stays under the cap', () => {
    expect(evaluateDailyCap({ dailyChargedCents: 100, estCostCents: 25, capCents: 500 }))
      .toEqual({ allowed: true, reason: 'ok' });
  });

  it('allows exactly at the cap (spent + est === cap)', () => {
    expect(evaluateDailyCap({ dailyChargedCents: 475, estCostCents: 25, capCents: 500 }).allowed)
      .toBe(true);
  });

  it('denies when day spend + this call would exceed the cap', () => {
    expect(evaluateDailyCap({ dailyChargedCents: 480, estCostCents: 25, capCents: 500 }))
      .toEqual({ allowed: false, reason: 'daily_cap_exceeded' });
  });

  it('denies when prior spend alone is already over the cap', () => {
    expect(evaluateDailyCap({ dailyChargedCents: 600, estCostCents: 0, capCents: 500 }).allowed)
      .toBe(false);
  });

  it('clamps negative inputs to 0 before comparing', () => {
    expect(evaluateDailyCap({ dailyChargedCents: -100, estCostCents: -5, capCents: 500 }))
      .toEqual({ allowed: true, reason: 'ok' });
  });
});

describe('estimateChatHoldCents', () => {
  // markupBps 15000 = 1.5×. floor 2¢, ceiling 25¢ throughout.
  it('applies the markup to the real-cost estimate and rounds to whole cents', () => {
    // $0.10 real × 1.5 = $0.15 = 15¢, within [2, 25].
    expect(estimateChatHoldCents(0.10, 15000, 2, 25)).toBe(15);
  });

  it('clamps up to the floor when the marked-up estimate is below it', () => {
    // A sub-cent call ($0.0005 × 1.5 ≈ 0.075¢ → rounds to 0) must still reserve the floor.
    expect(estimateChatHoldCents(0.0005, 15000, 2, 25)).toBe(2);
    expect(estimateChatHoldCents(0, 15000, 2, 25)).toBe(2);
  });

  it('clamps down to the ceiling when the marked-up estimate exceeds it', () => {
    // $0.50 real × 1.5 = 75¢ → capped at the legacy 25¢ ceiling.
    expect(estimateChatHoldCents(0.50, 15000, 2, 25)).toBe(25);
  });

  it('treats a non-finite or negative estimate as zero cost (floor applies)', () => {
    expect(estimateChatHoldCents(Number.NaN, 15000, 2, 25)).toBe(2);
    expect(estimateChatHoldCents(-1, 15000, 2, 25)).toBe(2);
  });

  it('keeps floor <= ceiling even if misconfigured (ceiling below floor coerces up)', () => {
    expect(estimateChatHoldCents(1, 15000, 10, 5)).toBe(10);
  });
});

describe('holdExpiresAt', () => {
  it('returns now + ttl in epoch ms', () => {
    expect(holdExpiresAt(1_000_000, 900_000)).toBe(1_900_000);
  });

  it('treats a negative ttl as 0 (never expires before it is created)', () => {
    expect(holdExpiresAt(1_000_000, -5)).toBe(1_000_000);
  });
});

describe('computeMonthlyRefill', () => {
  it('resets remaining to the full tier allowance and forgives debt (debtCents: 0)', () => {
    expect(computeMonthlyRefill('pro', ALLOWANCE)).toEqual({
      monthlyRemainingCents: 1500,
      monthlyAllowanceCents: 1500,
      debtCents: 0,
    });
    expect(computeMonthlyRefill('business', ALLOWANCE).monthlyAllowanceCents).toBe(10000);
    // The renewal always wipes debt — last period's overage never carries forward.
    expect(computeMonthlyRefill('business', ALLOWANCE).debtCents).toBe(0);
  });

  it('falls back to the free allowance for an unknown tier (debt still forgiven)', () => {
    expect(computeMonthlyRefill('enterprise' as SubscriptionTier, ALLOWANCE))
      .toEqual({ monthlyRemainingCents: 50, monthlyAllowanceCents: 50, debtCents: 0 });
  });
});

describe('applyPaymentToDebt', () => {
  it('puts the whole payment toward debt when payment < debt (nothing to top-up)', () => {
    expect(applyPaymentToDebt(1000, 0, 400)).toEqual({
      debtCents: 600,
      topupCents: 0,
      paidDebt: 400,
    });
  });

  it('clears the debt exactly when payment == debt', () => {
    expect(applyPaymentToDebt(500, 200, 500)).toEqual({
      debtCents: 0,
      topupCents: 200,
      paidDebt: 500,
    });
  });

  it('clears debt then credits the remainder to top-up when payment > debt', () => {
    // owe 500, pay 2500 -> debt 0, 2000 added to the existing 100 top-up.
    expect(applyPaymentToDebt(500, 100, 2500)).toEqual({
      debtCents: 0,
      topupCents: 2100,
      paidDebt: 500,
    });
  });

  it('credits the whole payment to top-up when there is no debt', () => {
    expect(applyPaymentToDebt(0, 1000, 2500)).toEqual({
      debtCents: 0,
      topupCents: 3500,
      paidDebt: 0,
    });
  });

  it('throws on a negative or non-finite payment', () => {
    expect(() => applyPaymentToDebt(0, 0, -100)).toThrow();
    expect(() => applyPaymentToDebt(0, 0, Number.NaN)).toThrow();
  });
});

describe('validateTopupAmountCents', () => {
  const MIN = 500;
  const MAX = 20000;

  it('accepts an in-range integer and returns it normalized', () => {
    expect(validateTopupAmountCents(1234, MIN, MAX)).toBe(1234);
  });

  it('accepts the exact bounds', () => {
    expect(validateTopupAmountCents(MIN, MIN, MAX)).toBe(MIN);
    expect(validateTopupAmountCents(MAX, MIN, MAX)).toBe(MAX);
  });

  it('rejects amounts below the min or above the max', () => {
    expect(validateTopupAmountCents(MIN - 1, MIN, MAX)).toBeNull();
    expect(validateTopupAmountCents(MAX + 1, MIN, MAX)).toBeNull();
  });

  it('rejects non-integer, non-finite, or negative amounts', () => {
    expect(validateTopupAmountCents(1000.5, MIN, MAX)).toBeNull();
    expect(validateTopupAmountCents(Number.NaN, MIN, MAX)).toBeNull();
    expect(validateTopupAmountCents(Number.POSITIVE_INFINITY, MIN, MAX)).toBeNull();
    expect(validateTopupAmountCents(-1000, MIN, MAX)).toBeNull();
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

describe('credit-core debt invariants (property-based, seeded)', () => {
  // Dependency-free generative testing: a deterministic PRNG drives thousands of
  // random operation sequences so a regression reproduces from the seed. The single
  // invariant under test is the one the DB CHECK also guards: a balance's debt and
  // buckets can NEVER go negative, no matter the order of spend/pay/refill.
  const mulberry32 = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const ALLOW: Record<SubscriptionTier, number> = { free: 500, pro: 1500, founder: 5000, business: 10000 };
  const TIERS: SubscriptionTier[] = ['free', 'pro', 'founder', 'business'];

  it('debt and buckets stay >= 0 across 5000 random spend/pay/refill sequences', () => {
    const rand = mulberry32(0xc0ffee);
    let monthly = 0;
    let topup = 0;
    let debt = 0;

    for (let i = 0; i < 5000; i++) {
      const op = Math.floor(rand() * 3);
      if (op === 0) {
        // SPEND: draw monthly-first; the uncovered remainder accrues as debt.
        const amount = Math.floor(rand() * 4000);
        const spent = allocateSpend({ monthlyCents: monthly, topupCents: topup }, amount);
        monthly = spent.monthlyCents;
        topup = spent.topupCents;
        debt += spent.shortfallCents;
      } else if (op === 1) {
        // PAY: a purchase clears debt first, remainder to top-up.
        const payment = Math.floor(rand() * 6000);
        const before = debt + topup;
        const paid = applyPaymentToDebt(debt, topup, payment);
        debt = paid.debtCents;
        topup = paid.topupCents;
        // Conservation: a payment grows (debt + topup) by exactly the amount paid
        // (debt shrinks, top-up grows, dollar-for-dollar — nothing vanishes).
        expect(debt + topup).toBe(before + payment);
      } else {
        // REFILL (renewal): full allowance restored, debt forgiven.
        const refill = computeMonthlyRefill(TIERS[Math.floor(rand() * TIERS.length)], ALLOW);
        monthly = refill.monthlyRemainingCents;
        debt = refill.debtCents;
      }

      // The invariant the DB CHECK also enforces — true after EVERY operation.
      expect(debt).toBeGreaterThanOrEqual(0);
      expect(monthly).toBeGreaterThanOrEqual(0);
      expect(topup).toBeGreaterThanOrEqual(0);
    }
  });

  it('validateTopupAmountCents accepts a value iff it is an integer within [min,max]', () => {
    const rand = mulberry32(0x1234);
    const MIN = 500;
    const MAX = 20000;
    for (let i = 0; i < 2000; i++) {
      const cents = Math.floor(rand() * 30000) - 1000; // range spans below 0, in-band, and above max
      const result = validateTopupAmountCents(cents, MIN, MAX);
      if (cents >= MIN && cents <= MAX) {
        expect(result).toBe(cents);
      } else {
        expect(result).toBeNull();
      }
      // A fractional amount is always rejected, in or out of band.
      expect(validateTopupAmountCents(cents + 0.5, MIN, MAX)).toBeNull();
    }
  });
});

describe('computeCostDrift', () => {
  // markupBps 15000 = 1.5×. tolerance: 1¢ absolute floor, 500 bps (5%) relative band.
  const TOL = { toleranceCents: 1, toleranceBps: 500 };

  it('does not correct a zero / within-tolerance drift', () => {
    expect(computeCostDrift({ billedRealCostCents: 100, authoritativeRealCostDollars: 1.0, ...TOL }, 15000).shouldCorrect)
      .toBe(false);
    // delta 3¢ on a 100¢ bill: under the 5% (5¢) band.
    expect(computeCostDrift({ billedRealCostCents: 100, authoritativeRealCostDollars: 1.03, ...TOL }, 15000).shouldCorrect)
      .toBe(false);
  });

  it('corrects when drift exceeds the relative band (undercharge → positive delta + debit)', () => {
    const r = computeCostDrift({ billedRealCostCents: 100, authoritativeRealCostDollars: 1.10, ...TOL }, 15000);
    expect(r.shouldCorrect).toBe(true);
    expect(r.deltaRealCostCents).toBe(10);
    // markup applied to the 10¢ delta: 0.10 × 1.5 × 100_000 = 15_000 millicents.
    expect(r.deltaChargeMillicents).toBe(15_000);
  });

  it('corrects when drift exceeds the absolute floor even on a tiny bill', () => {
    // billed 2¢ → relative band rounds to 0¢, so the 1¢ absolute floor governs.
    const r = computeCostDrift({ billedRealCostCents: 2, authoritativeRealCostDollars: 0.05, ...TOL }, 15000);
    expect(r.shouldCorrect).toBe(true);
    expect(r.deltaRealCostCents).toBe(3);
  });

  it('produces a negative (refund) delta when we overcharged', () => {
    const r = computeCostDrift({ billedRealCostCents: 100, authoritativeRealCostDollars: 0.80, ...TOL }, 15000);
    expect(r.shouldCorrect).toBe(true);
    expect(r.deltaRealCostCents).toBe(-20);
    // refund charge: −(0.20 × 1.5 × 100_000) = −30_000 millicents.
    expect(r.deltaChargeMillicents).toBe(-30_000);
  });
});

describe('computeBalanceDrift', () => {
  it('does not flag when materialized buckets match the ledger-implied amount', () => {
    // grants 1000 − usage 300 + adjustments 0 = 700 expected; materialized 700.
    const r = computeBalanceDrift(
      { grantCents: 1000, appliedUsageCents: 300, adjustmentCents: 0, materializedSpendableCents: 700, debtCents: 0 },
      10,
    );
    expect(r).toEqual({ expectedSpendableCents: 700, driftCents: 0, flagged: false });
  });

  it('does not flag a divergence within tolerance', () => {
    const r = computeBalanceDrift(
      { grantCents: 1000, appliedUsageCents: 300, adjustmentCents: 0, materializedSpendableCents: 705, debtCents: 0 },
      10,
    );
    expect(r.driftCents).toBe(5);
    expect(r.flagged).toBe(false);
  });

  it('flags a divergence beyond tolerance (either sign)', () => {
    expect(computeBalanceDrift(
      { grantCents: 1000, appliedUsageCents: 300, adjustmentCents: 0, materializedSpendableCents: 800, debtCents: 0 },
      10,
    ).flagged).toBe(true);
    expect(computeBalanceDrift(
      { grantCents: 1000, appliedUsageCents: 300, adjustmentCents: 0, materializedSpendableCents: 600, debtCents: 0 },
      10,
    ).flagged).toBe(true);
  });

  it('folds applied adjustments into the expected amount', () => {
    // grants 1000 − usage 300 + adjustments −15 (a reconcile debit) = 685 expected.
    const r = computeBalanceDrift(
      { grantCents: 1000, appliedUsageCents: 300, adjustmentCents: -15, materializedSpendableCents: 685, debtCents: 0 },
      10,
    );
    expect(r.expectedSpendableCents).toBe(685);
    expect(r.flagged).toBe(false);
  });
});

describe('isNegativeMargin', () => {
  it('is not flagged when there is no real cost (margin undefined)', () => {
    expect(isNegativeMargin(0, 0, 0)).toBe(false);
    expect(isNegativeMargin(0, 100, 0)).toBe(false);
  });

  it('flags when charged is below real cost (floor 0)', () => {
    expect(isNegativeMargin(100, 90, 0)).toBe(true);
    expect(isNegativeMargin(100, 100, 0)).toBe(false); // exactly covers → ok
    expect(isNegativeMargin(100, 150, 0)).toBe(false);
  });

  it('requires headroom above the floor when one is set', () => {
    // floor 5000 bps = require charged >= real × 1.5.
    expect(isNegativeMargin(100, 140, 5000)).toBe(true);
    expect(isNegativeMargin(100, 150, 5000)).toBe(false);
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
