import { describe, it, expect } from 'vitest';
import { formatCreditCount } from '@pagespace/lib/billing/money-model';
import { orgPlanQuote } from '@pagespace/lib/billing/org-plan-quote';

// Included credits follow the money-model switch (MONEY_MODEL_V2_ACTIVE), never a pinned ratio.
const included = (seats: number) => formatCreditCount(orgPlanQuote(seats).includedCreditCents);

import { invoiceLine, planFigures, poolFigures, seatFigures } from '../org-billing';

const seats = { members: 12, pendingInvites: 2, held: 14, included: 5, purchasedExtra: 10, purchased: 15, autoAdd: true, hasSubscription: true, currentPeriodEnd: '2026-10-01T00:00:00Z' };

describe('planFigures', () => {
  it('UI-7 (partial) UI-12 (partial) MON-6 (partial): price, included credits and the seat price as separate facts', () => {
    expect(planFigures(seats)).toEqual({
      price: '$150.00',
      terms: '$50 a month with 5 seats · $10 per extra seat · renews Oct 1, 2026',
      breakdown: `$50 + 10 extra seats × $10 · ${included(15)} credits included each month · your personal plan is billed separately`,
    });
  });

  it('with no extra seats it is the base price, and no renewal before a subscription', () => {
    expect(planFigures({ ...seats, purchasedExtra: 0, purchased: 5, currentPeriodEnd: null })).toMatchObject({
      price: '$50.00',
      terms: '$50 a month with 5 seats · $10 per extra seat',
      breakdown: `$50 · ${included(5)} credits included each month · your personal plan is billed separately`,
    });
  });
});

describe('seatFigures', () => {
  it('SEAT-3 (partial): members in use, invites reserved, of the purchased seats', () => {
    expect(seatFigures(seats)).toEqual({ percent: 93, inUse: '12 in use · 2 reserved by invites', total: '15 seats · 5 included + 10 extra' });
  });

  it('never passes 100% even when more seats are held than bought', () => {
    expect(seatFigures({ ...seats, held: 20 }).percent).toBe(100);
  });
});

describe('poolFigures', () => {
  it('UI-7 (partial) UI-12 (partial): the pool split as credit counts, never dollars', () => {
    const figures = poolFigures({
      walletId: 'w', availableCents: 4_500, unallocatedCents: 4_308, periodEnd: '2026-10-01T00:00:00Z',
      seats: { memberCount: 12, allowanceCents: 150, allocatedCents: 1_800, spentCents: 1_152 },
      driveWallets: [
        { driveId: 'a', driveName: 'Product', walletId: 'wa', allocationCents: 1_200, spentCents: 1_008, status: 'active' },
        { driveId: 'b', driveName: 'Engineering', walletId: 'wb', allocationCents: 900, spentCents: 1_233, status: 'over' },
      ],
      drivesWithoutWallet: [],
    });
    expect(figures).toEqual({
      unallocated: { value: '4,308 credits', label: 'Unallocated · refills on Oct 1' },
      seats: { value: '1,800 credits', label: 'Allocated to seats · 12 × 150 credits a month · 1,152 credits spent' },
      drives: { value: '2,100 credits', label: 'Allocated to drive wallets · 2 drives · 2,241 credits spent' },
    });
    expect(JSON.stringify(figures)).not.toContain('$');
  });
});

describe('invoiceLine', () => {
  it('UI-7 (partial): an invoice shows its date, period and amount in dollars, and whether it is paid', () => {
    expect(invoiceLine({ id: 'in_1', number: 'NW-0003', status: 'paid', amountDue: 14_667, amountPaid: 14_667, currency: 'usd', created: '2026-09-01T00:00:00Z', periodStart: '2026-09-01T00:00:00Z', periodEnd: '2026-10-01T00:00:00Z', hostedInvoiceUrl: null, invoicePdf: 'https://pdf' }))
      .toEqual({ date: 'Sep 1, 2026', summary: 'NW-0003 · Sep 1 – Oct 1 · $146.67', status: 'Paid', tone: 'live' });
    expect(invoiceLine({ id: 'in_2', number: null, status: 'open', amountDue: 5_000, amountPaid: 0, currency: 'usd', created: '2026-10-01T00:00:00Z', periodStart: null, periodEnd: null, hostedInvoiceUrl: null, invoicePdf: null }))
      .toMatchObject({ summary: '$50.00', status: 'Open', tone: 'restricted' });
  });
});
