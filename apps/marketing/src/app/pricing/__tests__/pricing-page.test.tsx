/**
 * The marketing pricing page against the money model as committed (MON-6, SEAT-2, UI-12).
 * pricing-page.harness.test.tsx renders the same page with the constants changed.
 */
import { describe, expect, it, vi } from 'vitest';
import { TIERS } from '@pagespace/lib/billing/subscription-tiers';
import { planFacts } from '@pagespace/lib/billing/credit-copy';
import { DOLLAR_BESIDE_CREDITS, renderCards } from './pricing-cards';

// Site chrome (search, theme, auth buttons) is irrelevant to plan copy and needs a browser.
vi.mock('@/components/SiteNavbar', () => ({ SiteNavbar: () => null }));
vi.mock('@/components/SiteFooter', () => ({ SiteFooter: () => null }));

async function renderPricing() {
  const { default: PricingPage } = await import('../page');
  return renderCards(<PricingPage />);
}

describe('marketing pricing page on the money model', () => {
  it('UI-12 (partial) the rendered pricing page never puts a "$" beside the word credits', async () => {
    const { text } = await renderPricing();
    expect(text).toMatch(/credits/);
    expect(text).not.toMatch(DOLLAR_BESIDE_CREDITS);
  });

  it('MON-6 (partial) three tiers, each card stating price, included credits, and the top-up rate as separate facts from planFacts', async () => {
    const { cards } = await renderPricing();
    expect(Object.keys(cards)).toEqual([...TIERS]);
    for (const tier of TIERS) {
      const facts = planFacts(tier);
      expect(cards[tier]['plan-price'], tier).toBe(facts.price);
      expect(cards[tier]['plan-included-credits'], tier).toBe(facts.includedCredits);
      expect(cards[tier]['plan-topup-rate'], tier).toBe(facts.topUpRate);
      expect(cards[tier]['plan-period'], tier).toBe(facts.period ?? undefined);
    }
  });

  it('MON-6 (partial) every number displayed in a card fact is the money-model number', async () => {
    const { cards } = await renderPricing();
    const numbers = (s: string) => s.match(/\d[\d,.]*/g) ?? [];
    for (const tier of TIERS) {
      const facts = planFacts(tier);
      const expected: Record<string, string | undefined> = {
        'plan-price': facts.price,
        'plan-included-credits': facts.includedCredits,
        'plan-topup-rate': facts.topUpRate,
        'plan-seats': facts.org?.seatTerms,
        'plan-seat-credits': facts.org?.extraSeatCredits,
      };
      for (const [id, want] of Object.entries(expected)) {
        const shown = cards[tier][id as keyof (typeof cards)[string]];
        expect(numbers(shown ?? ''), `${tier} ${id}`).toEqual(numbers(want ?? ''));
      }
    }
  });

  it('SEAT-2 (partial) Business is the org plan: $50 a month, 5 seats included, $10 per extra seat a month', async () => {
    const { cards } = await renderPricing();
    const business = cards.business;
    const org = planFacts('business').org;
    expect(business['plan-price']).toBe('$50');
    expect(business['plan-period']).toBe('/month');
    expect(business['plan-seats']).toBe(org?.seatTerms);
    expect(business['plan-seats']).toBe('per organization · 5 seats included · $10 per extra seat a month');
    expect(business['plan-seat-credits']).toBe(org?.extraSeatCredits);
    expect(cards.free['plan-seats']).toBeUndefined();
    expect(cards.pro['plan-seats']).toBeUndefined();
  });

  it('no org trial (Spec A-7, D-OW-30) and no Founder tier: the org card says a card is required at checkout', async () => {
    const { text, cards } = await renderPricing();
    expect(cards.business['plan-checkout']).toBe(planFacts('business').org?.checkout);
    expect(cards.business['plan-checkout']).toBe('No trial · card required at checkout');
    expect(text).not.toMatch(/free trial|\d+-day trial|start (a|your) trial/i);
    expect(text).not.toMatch(/founder/i);
  });
});
