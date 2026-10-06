import { describe, it, expect } from 'vitest';
import { TIERS, TIER_PLAN_LIMITS } from '../subscription-tiers';
import { planFacts, includedCreditsPhrase, topUpRatePhrase } from '../credit-copy';
import {
  allowanceCentsForPaidCents,
  centsFromDollars,
  formatCreditCount,
  formatDollars,
  tierListPriceCents,
} from '../money-model';
import { orgPlanQuote } from '../org-plan-quote';

/** A "$" with only a figure (or nothing) between it and the word "credits", either side. */
const DOLLAR_BESIDE_CREDITS = /\$[\s\d,.]*credits\b|\bcredits[\s:]*\$/i;

describe('planFacts: the three plan-card facts, one source for the marketing page and the in-app PlanCard', () => {
  it('MON-6 (partial) every tier states price, included credits, and the top-up rate as three separate facts', () => {
    for (const tier of TIERS) {
      const facts = planFacts(tier);
      expect(facts.price, tier).toBe(formatDollars(tierListPriceCents(tier)));
      expect(facts.includedCredits, tier).toBe(includedCreditsPhrase(tier));
      expect(facts.topUpRate, tier).toBe(topUpRatePhrase());
      expect(facts.price).not.toBe(facts.includedCredits);
      expect(facts.includedCredits).not.toBe(facts.topUpRate);
    }
    expect(planFacts('free').period).toBeNull();
    expect(planFacts('pro').period).toBe('/month');
    expect(planFacts('business').period).toBe('/month');
  });

  it('UI-12 (partial) no fact puts a dollar sign beside a credit amount; dollars appear only on prices', () => {
    for (const tier of TIERS) {
      const facts = planFacts(tier);
      const strings = [facts.price, facts.includedCredits, facts.topUpRate, ...Object.values(facts.org ?? {}).filter((v): v is string => typeof v === 'string')];
      for (const s of strings) expect(s, `${tier}: ${s}`).not.toMatch(DOLLAR_BESIDE_CREDITS);
      expect(facts.includedCredits, tier).not.toContain('$');
    }
  });

  it('UI-12 (partial) the dollar-beside-credits pattern catches a planted dollar figure', () => {
    expect('$1,500 credits included each month').toMatch(DOLLAR_BESIDE_CREDITS);
    expect('$ credits').toMatch(DOLLAR_BESIDE_CREDITS);
    expect('credits: $15').toMatch(DOLLAR_BESIDE_CREDITS);
    expect('1,000 credits per $10').not.toMatch(DOLLAR_BESIDE_CREDITS);
  });

  it('SEAT-2 (partial) Business is the org plan: price, included seats, and the extra-seat price per month, all from the tier table', () => {
    const limits = TIER_PLAN_LIMITS.business;
    const org = planFacts('business').org;
    expect(org).not.toBeNull();
    expect(org?.includedSeats).toBe(limits.includedSeats);
    expect(org?.extraSeatPriceCents).toBe(centsFromDollars(limits.extraSeatUsd));
    expect(org?.seatTerms).toBe(
      `per organization · ${limits.includedSeats} seats included · ${formatDollars(centsFromDollars(limits.extraSeatUsd))} per extra seat a month`,
    );
    // Today's table: $50 a month, 5 seats, $10 per extra seat.
    expect(planFacts('business').price).toBe('$50');
    expect(org?.seatTerms).toBe('per organization · 5 seats included · $10 per extra seat a month');
  });

  it('A-11 (partial) an extra seat adds the ratio of its price as credits, exactly what the org plan quote grants', () => {
    const org = planFacts('business').org;
    const seatCents = centsFromDollars(TIER_PLAN_LIMITS.business.extraSeatUsd);
    expect(org?.extraSeatCredits).toBe(`+${formatCreditCount(allowanceCentsForPaidCents(seatCents, 'business'))} credits a month per extra seat`);
    const base = TIER_PLAN_LIMITS.business.includedSeats;
    expect(orgPlanQuote(base + 1).includedCreditCents - orgPlanQuote(base).includedCreditCents).toBe(
      allowanceCentsForPaidCents(seatCents, 'business'),
    );
  });

  it('A-11 (partial) with the ratio active Pro includes 900, Business 3,000, and an extra seat adds 600 credits', () => {
    const seatCents = centsFromDollars(TIER_PLAN_LIMITS.business.extraSeatUsd);
    expect(planFacts('business', true).org?.extraSeatCredits).toBe(
      `+${formatCreditCount(allowanceCentsForPaidCents(seatCents, 'business', true))} credits a month per extra seat`,
    );
    expect(planFacts('business', true).org?.extraSeatCredits).toBe('+600 credits a month per extra seat');
    expect(planFacts('pro', true).includedCredits).toBe('900 credits included each month');
    expect(planFacts('business', true).includedCredits).toBe('3,000 credits included each month');
    expect(planFacts('free', true).includedCredits).toBe('500 credits to start');
  });

  it('A-7 (partial) the org plan states no trial and that a card is required at checkout; personal plans carry no org facts', () => {
    expect(planFacts('business').org?.checkout).toBe('No trial · card required at checkout');
    expect(planFacts('free').org).toBeNull();
    expect(planFacts('pro').org).toBeNull();
    for (const tier of TIERS) expect(JSON.stringify(planFacts(tier)).toLowerCase()).not.toMatch(/free trial|\d+-day trial|founder/);
  });
});
