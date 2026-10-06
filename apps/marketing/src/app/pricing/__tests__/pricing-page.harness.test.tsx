/**
 * The pricing page FOLLOWS the money model: change the constants in the harness and every
 * figure on the page changes with them. A number typed into the page would stay put.
 *
 * Changed here: list prices (Pro $20, Business $80), the org seat terms (4 seats, $12 per
 * extra seat), the top-up pack (2,000 credits), and the ratio (active, D-OW-17). credit-copy
 * calls tierAllowanceCents/allowanceCentsForPaidCents without `active`, and mocking the
 * exported constant would not reach those defaults, so the calls are routed to the real
 * functions with `active = true` passed explicitly (as in credit-copy.flag-on.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { DOLLAR_BESIDE_CREDITS, renderCards } from './pricing-cards';

vi.mock('@/components/SiteNavbar', () => ({ SiteNavbar: () => null }));
vi.mock('@/components/SiteFooter', () => ({ SiteFooter: () => null }));

vi.mock('@pagespace/lib/billing/subscription-tiers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/billing/subscription-tiers')>();
  return {
    ...actual,
    TIER_PLAN_LIMITS: {
      ...actual.TIER_PLAN_LIMITS,
      pro: { ...actual.TIER_PLAN_LIMITS.pro, priceMonthlyUsd: 20 },
      business: { ...actual.TIER_PLAN_LIMITS.business, priceMonthlyUsd: 80, includedSeats: 4, extraSeatUsd: 12 },
    },
  };
});

vi.mock('@pagespace/lib/billing/money-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/billing/money-model')>();
  return {
    ...actual,
    CREDIT_PACKS: { pack_20: { id: 'pack_20', credits: 2000, label: '2,000 credits' } },
    tierAllowanceCents: (tier: string) => actual.tierAllowanceCents(tier, true),
    allowanceCentsForPaidCents: (paidCents: number, tier: Parameters<typeof actual.allowanceCentsForPaidCents>[1]) =>
      actual.allowanceCentsForPaidCents(paidCents, tier, true),
  };
});

describe('the pricing page follows the money model when its constants change', () => {
  it('MON-6 (partial) every card figure moves with the changed prices, seat terms, pack, and ratio', async () => {
    const { default: PricingPage } = await import('../page');
    const { cards, text } = renderCards(<PricingPage />);

    expect(cards.pro['plan-price']).toBe('$20');
    expect(cards.pro['plan-included-credits']).toBe('1,200 credits included each month');
    expect(cards.business['plan-price']).toBe('$80');
    expect(cards.business['plan-included-credits']).toBe('4,800 credits included each month');
    expect(cards.business['plan-seats']).toBe('per organization · 4 seats included · $12 per extra seat a month');
    expect(cards.business['plan-seat-credits']).toBe('+720 credits a month per extra seat');
    expect(cards.free['plan-price']).toBe('$0');
    expect(cards.free['plan-included-credits']).toBe('500 credits to start');
    for (const tier of ['free', 'pro', 'business']) {
      expect(cards[tier]['plan-topup-rate'], tier).toBe('2,000 credits per $20');
    }

    // The committed figures are gone from the cards: nothing was typed in by hand.
    expect(cards.pro['plan-price']).not.toBe('$15');
    expect(cards.business['plan-price']).not.toBe('$50');
    expect(text).not.toMatch(/5 seats included|\$10 per extra seat|1,500 credits|1,000 credits per \$10/);
    expect(text).not.toMatch(DOLLAR_BESIDE_CREDITS);
  });
});
