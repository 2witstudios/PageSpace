import { describe, it, expect } from 'vitest';
import { orgExtraSeatQuantity, orgListPriceCents, orgPlanQuote } from '../org-plan-quote';
import { orgExtraSeatQuantity as viaSubscriptionCore } from '../org-subscription-core';
import { orgPoolListPriceGrantCents } from '../wallet-funding';
import { allowanceCentsForPaidCents } from '../money-model';
import { TIER_PLAN_LIMITS } from '../subscription-tiers';

describe('orgPlanQuote', () => {
  it('UI-6 (partial): 13 seats on Business is $50 + 8 extra seats × $10 = $130 a month', () => {
    const quote = orgPlanQuote(13, true);
    expect(quote).toMatchObject({
      seats: 13,
      includedSeats: 5,
      extraSeats: 8,
      basePriceCents: 5_000,
      extraSeatPriceCents: 1_000,
      extraSeatsCents: 8_000,
      totalCents: 13_000,
    });
  });

  it('UI-6 (partial): the included credits are the money-model ratio of the price (7,800 credits for $130 at 60%)', () => {
    expect(orgPlanQuote(13, true).includedCreditCents).toBe(7_800);
    expect(orgPlanQuote(15, true).includedCreditCents).toBe(9_000);
  });

  it('follows the money-model switch rather than a hard-coded ratio', () => {
    for (const active of [true, false]) {
      const quote = orgPlanQuote(9, active);
      expect(quote.includedCreditCents).toBe(allowanceCentsForPaidCents(quote.totalCents, 'business', active));
    }
  });

  it('never quotes fewer than the included seats: 1 seat still pays the $50 base', () => {
    expect(orgPlanQuote(1, true)).toMatchObject({ seats: 1, extraSeats: 0, extraSeatsCents: 0, totalCents: 5_000 });
    expect(orgPlanQuote(0, true).totalCents).toBe(5_000);
  });

  it('reads the base price, included seats and seat price from the tier table', () => {
    const business = TIER_PLAN_LIMITS.business;
    const quote = orgPlanQuote(business.includedSeats + 2, true);
    expect(quote.basePriceCents).toBe(business.priceMonthlyUsd * 100);
    expect(quote.extraSeatPriceCents).toBe(business.extraSeatUsd * 100);
    expect(quote.includedSeats).toBe(business.includedSeats);
  });

  it('refuses a seat count that is not a non-negative integer', () => {
    for (const bad of [-1, 1.5, Number.NaN]) expect(() => orgPlanQuote(bad)).toThrow(RangeError);
  });
});

describe('one source for the org list price and the extra-seat quantity', () => {
  it('org-subscription-core re-exports the same orgExtraSeatQuantity', () => {
    expect(viaSubscriptionCore).toBe(orgExtraSeatQuantity);
  });

  it('a gifted pool is the ratio of the same list price the quote shows', () => {
    for (const extra of [0, 1, 10]) {
      expect(orgPoolListPriceGrantCents(extra, true)).toBe(allowanceCentsForPaidCents(orgListPriceCents(extra), 'business', true));
      expect(orgPlanQuote(5 + extra, true).includedCreditCents).toBe(orgPoolListPriceGrantCents(extra, true));
    }
  });
});
