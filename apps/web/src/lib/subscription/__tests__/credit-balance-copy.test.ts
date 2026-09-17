import { describe, it, expect } from 'vitest';
import { creditBalanceCopy } from '../credits';

const PURCHASE_CTA = /\b(buy|purchase|upgrade|top.?up|add credits)\b/i;

describe('creditBalanceCopy', () => {
  for (const isFree of [true, false]) {
    const who = isFree ? 'a free user' : 'a paid user';

    it(`given ${who} where billing is hidden (iOS), should give no instruction to buy, top up or upgrade`, () => {
      const copy = creditBalanceCopy({ isFree, showBilling: false });
      for (const line of Object.values(copy)) expect(line).not.toMatch(PURCHASE_CTA);
    });
  }

  it('given a free user on the web, should still say how to top up or upgrade', () => {
    const copy = creditBalanceCopy({ isFree: true, showBilling: true });
    expect(copy.description).toMatch(/top-up/i);
    expect(copy.inDebt).toMatch(/add credits/i);
  });

  it('given a paid user on the web, should still mention clearing overage with a top-up', () => {
    expect(creditBalanceCopy({ isFree: false, showBilling: true }).overage).toMatch(/top-up/i);
  });
});
