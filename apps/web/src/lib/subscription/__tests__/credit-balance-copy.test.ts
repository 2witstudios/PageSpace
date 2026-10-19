import { describe, it, expect } from 'vitest';
import { creditBalanceCopy } from '../credits';

const PURCHASE_CTA = /\b(buy|purchase|upgrade|top.?up|add credits)\b/i;

describe('creditBalanceCopy', () => {
  for (const isFree of [true, false]) {
    const who = isFree ? 'a free user' : 'a paid user';

    it(`given ${who} where nothing may be sold (billing channel 'none'), should give no instruction to buy, top up or upgrade`, () => {
      const copy = creditBalanceCopy({ isFree, canPurchase: false });
      for (const line of Object.values(copy)) expect(line).not.toMatch(PURCHASE_CTA);
    });
  }

  it('given a free user where a store may sell (web, or iOS with StoreKit), should still say how to top up or upgrade', () => {
    const copy = creditBalanceCopy({ isFree: true, canPurchase: true });
    expect(copy.description).toMatch(/top-up/i);
    expect(copy.inDebt).toMatch(/add credits/i);
  });

  it('given a paid user where a store may sell, should still mention clearing overage with a top-up', () => {
    expect(creditBalanceCopy({ isFree: false, canPurchase: true }).overage).toMatch(/top-up/i);
  });
});
