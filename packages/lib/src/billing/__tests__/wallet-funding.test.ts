import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { centsFromCredits } from '../money-model';
import {
  orgPoolRefillGrant,
  orgPoolListPriceGrantCents,
  ORG_POOL_FUNDS_TRIALS_AND_GIFTS,
  refillPool,
  invoiceServicePeriodMs,
  planAllocationReset,
  orderFundingLegs,
  drawFundingLegs,
  planLegRefund,
  planDonation,
  type StoredFundingLeg,
  type DonationInput,
} from '../wallet-funding';

const c = (credits: number): number => Math.round(centsFromCredits(credits));
const BASE_CENTS = 5000; // Business list price, $50
const SEAT_CENTS = 1000; // one extra seat, $10
const base = { amount: BASE_CENTS };
const seats = (n: number) => ({ amount: SEAT_CENTS * n });

describe('wallet-funding: org pool refill', () => {
  it('MON-3 (partial) base + 3 extra seats paid × the Business ratio, ratio on: 8000 paid → 4800', () => {
    const grant = orgPoolRefillGrant({ lines: [base, seats(3)], hasSubscriptionParent: true }, true);
    expect(grant).toEqual({ paidCents: 8000, allowanceCents: 4800, basis: 'paid', reason: 'paid' });
  });

  it('MON-3 (partial) base + 3 extra seats with the ratio off grants the whole 8000 paid', () => {
    const grant = orgPoolRefillGrant({ lines: [base, seats(3)], hasSubscriptionParent: true }, false);
    expect(grant.allowanceCents).toBe(8000);
  });

  it('MON-3 (partial) more seats means a bigger pool with no second constant: 10 seats vs 3 seats', () => {
    const three = orgPoolRefillGrant({ lines: [base, seats(3)], hasSubscriptionParent: true }, true);
    const ten = orgPoolRefillGrant({ lines: [base, seats(10)], hasSubscriptionParent: true }, true);
    expect(ten.allowanceCents - three.allowanceCents).toBe(Math.floor((SEAT_CENTS * 7 * 6000) / 10_000));
  });

  it('a proration credit nets against the charge before the ratio', () => {
    const grant = orgPoolRefillGrant({ lines: [base, seats(3), { amount: -2000 }], hasSubscriptionParent: true }, true);
    expect(grant).toMatchObject({ paidCents: 6000, allowanceCents: 3600 });
  });

  it('an invoice with no subscription parent never refills the pool, whatever it paid', () => {
    const grant = orgPoolRefillGrant({ lines: [base, seats(3)], hasSubscriptionParent: false, gifted: true }, true);
    expect(grant).toEqual({ paidCents: 8000, allowanceCents: 0, basis: 'none', reason: 'not_a_subscription_invoice' });
  });

  it('D-OW-23 a trial org invoice (paid 0, subtotal 0) funds the pool at list price × ratio, extra seats included', () => {
    const grant = orgPoolRefillGrant(
      { lines: [{ amount: 0 }], hasSubscriptionParent: true, billingReason: 'subscription_create', subtotalCents: 0, extraSeats: 3 },
      true,
    );
    expect(ORG_POOL_FUNDS_TRIALS_AND_GIFTS).toBe(true);
    expect(grant).toEqual({ paidCents: 0, allowanceCents: 4800, basis: 'list', reason: 'trial' });
  });

  it('D-OW-23 a gifted org subscription is funded at list price × ratio through the one named function', () => {
    const grant = orgPoolRefillGrant(
      { lines: [{ amount: 0 }], hasSubscriptionParent: true, billingReason: 'subscription_cycle', subtotalCents: 5000, gifted: true },
      true,
    );
    expect(grant).toMatchObject({ allowanceCents: orgPoolListPriceGrantCents(0, true), basis: 'list', reason: 'gifted' });
    expect(orgPoolListPriceGrantCents(0, true)).toBe(3000);
  });

  it('a 100% coupon on a non-gifted org subscription (subtotal is the list price) grants nothing', () => {
    const grant = orgPoolRefillGrant(
      { lines: [{ amount: 0 }], hasSubscriptionParent: true, billingReason: 'subscription_cycle', subtotalCents: 5000 },
      true,
    );
    expect(grant).toMatchObject({ allowanceCents: 0, reason: 'zero_amount' });
  });

  it('refillPool rolls the pool over and nets its debt, like a personal renewal', () => {
    expect(refillPool({ monthlyRemainingCents: 1000, debtCents: 300 }, 4800)).toEqual({
      monthlyRemainingCents: 5500,
      monthlyAllowanceCents: 4800,
      debtCents: 0,
    });
    expect(refillPool(null, 4800).monthlyRemainingCents).toBe(4800);
  });

  it('the service period comes from the line with the latest end, not the invoice-level period', () => {
    const period = invoiceServicePeriodMs({
      lines: [{ period: { start: 100, end: 200 } }, { period: { start: 300, end: 400 } }],
      periodStart: 1,
      periodEnd: 2,
    });
    expect(period).toEqual({ startMs: 300_000, endMs: 400_000 });
    expect(invoiceServicePeriodMs({ lines: [], periodStart: 1, periodEnd: 2 })).toEqual({ startMs: 1000, endMs: 2000 });
  });
});

describe('wallet-funding: allocation reset (D-OW-12)', () => {
  const POOL_START = Date.UTC(2026, 8, 17); // the pool refilled on 17 Sep
  const POOL_END = Date.UTC(2026, 9, 17);
  const PERSONAL_START = Date.UTC(2026, 8, 3); // the person renews on the 3rd
  const PERSONAL_END = Date.UTC(2026, 9, 3);
  const NOW = Date.UTC(2026, 8, 20, 12);
  const wallet = (periodStartMs: number | null, spentCents = 700, debtCents = 0) => ({
    periodStartMs,
    allocationCents: 1000,
    spentCents,
    debtCents,
    paused: false,
  });

  it('WAL-3 (partial) an org drive allocation resets on the POOL refill date, not the calendar month', () => {
    const plan = planAllocationReset({
      wallet: wallet(Date.UTC(2026, 7, 17)),
      governing: { ownerType: 'org', periodStartMs: POOL_START, periodEndMs: POOL_END },
      nowMs: NOW,
    });
    expect(plan).toEqual({ due: true, periodStartMs: POOL_START, periodEndMs: POOL_END, spentCents: 0, debtCents: 0, status: 'active' });
  });

  it('WAL-3 (partial) a personal drive allocation resets on the PERSONAL renewal date — a second clock', () => {
    const plan = planAllocationReset({
      wallet: wallet(Date.UTC(2026, 7, 3)),
      governing: { ownerType: 'user', periodStartMs: PERSONAL_START, periodEndMs: PERSONAL_END },
      nowMs: NOW,
    });
    expect(plan).toMatchObject({ due: true, periodStartMs: PERSONAL_START, periodEndMs: PERSONAL_END });
  });

  it('a root never refilled falls back to the UTC calendar month (D20)', () => {
    const plan = planAllocationReset({
      wallet: wallet(Date.UTC(2026, 7, 1)),
      governing: { ownerType: 'org', periodStartMs: null, periodEndMs: null },
      nowMs: NOW,
    });
    expect(plan).toMatchObject({ due: true, periodStartMs: Date.UTC(2026, 8, 1), periodEndMs: Date.UTC(2026, 9, 1) });
  });

  it('WAL-3 (partial) a reset run twice in the same period grants once: the second run is not due', () => {
    const governing = { ownerType: 'org' as const, periodStartMs: POOL_START, periodEndMs: POOL_END };
    const first = planAllocationReset({ wallet: wallet(Date.UTC(2026, 7, 17)), governing, nowMs: NOW });
    expect(first.due).toBe(true);
    if (!first.due) return;
    const second = planAllocationReset({ wallet: wallet(first.periodStartMs, 400), governing, nowMs: NOW + 60_000 });
    expect(second).toEqual({ due: false });
  });

  it('WAL-6 (partial) a reset nets wallet debt against the new allocation, clears it, and lifts "over"', () => {
    const plan = planAllocationReset({
      wallet: wallet(Date.UTC(2026, 7, 17), 1000, 250),
      governing: { ownerType: 'org', periodStartMs: POOL_START, periodEndMs: POOL_END },
      nowMs: NOW,
    });
    expect(plan).toMatchObject({ due: true, spentCents: 250, debtCents: 0, status: 'active' });
  });

  it('a paused wallet stays paused through a reset', () => {
    const plan = planAllocationReset({
      wallet: { ...wallet(Date.UTC(2026, 7, 17)), paused: true },
      governing: { ownerType: 'org', periodStartMs: POOL_START, periodEndMs: POOL_END },
      nowMs: NOW,
    });
    expect(plan).toMatchObject({ due: true, status: 'paused' });
  });

  it('a wallet never reset is due at once', () => {
    const plan = planAllocationReset({
      wallet: wallet(null),
      governing: { ownerType: 'org', periodStartMs: POOL_START, periodEndMs: POOL_END },
      nowMs: NOW,
    });
    expect(plan.due).toBe(true);
  });
});

describe('wallet-funding: funding legs (D-OW-13)', () => {
  const T = Date.UTC(2026, 8, 1);
  const leg = (id: string, kind: StoredFundingLeg['funderKind'], remainingCents: number, createdAtMs: number, funderUserId: string | null = null): StoredFundingLeg => ({
    id,
    funderKind: kind,
    funderUserId,
    remainingCents,
    nonRefundable: kind === 'donation',
    createdAtMs,
  });

  it('WAL-3 (partial) legs draw FIFO by arrival then id, whoever funded them', () => {
    const ordered = orderFundingLegs([
      leg('b', 'donation', 1, T + 2),
      leg('z', 'owner', 1, T),
      leg('a', 'donation', 1, T + 2),
    ]);
    expect(ordered.map((l) => l.id)).toEqual(['z', 'a', 'b']);
  });

  it('WAL-4 (partial) two donors fund one drive wallet; spend drains the older leg first and each remaining is exact to the cent', () => {
    const legs = [
      leg('leg-marcus', 'donation', c(300), T + 1000, 'marcus'),
      leg('leg-ana', 'donation', c(500), T, 'ana'),
    ];
    const first = drawFundingLegs(legs, 537);
    expect(first.draws).toEqual([
      { legId: 'leg-ana', cents: 500 },
      { legId: 'leg-marcus', cents: 37 },
    ]);
    expect(first.legs).toEqual([
      { legId: 'leg-ana', funder: 'donation', donorUserId: 'ana', remainingCents: 0 },
      { legId: 'leg-marcus', funder: 'donation', donorUserId: 'marcus', remainingCents: 263 },
    ]);
    expect(first.shortfallCents).toBe(0);

    const second = drawFundingLegs(legs.map((l) => ({ ...l, remainingCents: l.id === 'leg-ana' ? 0 : 263 })), 300);
    expect(second.draws).toEqual([{ legId: 'leg-marcus', cents: 263 }]);
    expect(second.appliedCents).toBe(263);
    expect(second.shortfallCents).toBe(37);
  });

  it('D-OW-13 a refund attempt against a donation leg refuses, even with funds remaining', () => {
    expect(planLegRefund(leg('d', 'donation', 500, T, 'ana'), 100)).toEqual({ kind: 'refuse', legId: 'd', reason: 'donation_non_refundable' });
  });

  it('an owner leg refunds only what it still holds', () => {
    const owner = leg('o', 'owner', 500, T);
    expect(planLegRefund(owner, 200)).toEqual({ kind: 'refund', legId: 'o', cents: 200, remainingCents: 300 });
    expect(planLegRefund(owner, 501)).toMatchObject({ kind: 'refuse', reason: 'exceeds_remaining' });
    expect(planLegRefund({ ...owner, nonRefundable: true }, 1)).toMatchObject({ kind: 'refuse', reason: 'non_refundable' });
    expect(planLegRefund(owner, 1.5)).toMatchObject({ kind: 'refuse', reason: 'invalid_amount' });
  });
});

describe('wallet-funding: donations', () => {
  const input = (over: Partial<DonationInput> = {}): DonationInput => ({
    amountCents: 700,
    donorCanSeeDrive: true,
    donor: { walletId: 'w-ana', isPersonalRoot: true, balance: { monthlyCents: 500, topupCents: 1000, debtCents: 0 }, heldCents: 0 },
    target: { walletId: 'w-product', subjectType: 'drive', donationsEnabled: true, legsRemainingCents: 200, debtCents: 0 },
    ...over,
  });

  it('WAL-4 (partial) a donation draws the donor monthly-then-top-up and lands as a new non-refundable leg', () => {
    expect(planDonation(input())).toEqual({
      kind: 'donate',
      amountCents: 700,
      donor: { monthlyRemainingCents: 0, topupRemainingCents: 800, spentMonthly: 500, spentTopup: 200 },
      leg: { originalCents: 700, remainingCents: 700, nonRefundable: true },
      target: { topupRemainingCents: 900, debtCents: 0, paidDebtCents: 0 },
    });
  });

  it('a donation pays the drive wallet debt first; the leg keeps only what is left', () => {
    const plan = planDonation(input({ target: { ...input().target, debtCents: 300 } }));
    expect(plan).toMatchObject({ leg: { originalCents: 700, remainingCents: 400 }, target: { topupRemainingCents: 600, debtCents: 0, paidDebtCents: 300 } });
  });

  it.each([
    ['invalid_amount', { amountCents: 0 }],
    ['invalid_amount', { amountCents: 12.5 }],
    ['cannot_see_drive', { donorCanSeeDrive: false }],
    ['insufficient_funds', { amountCents: 1501 }],
  ] as const)('WAL-4 (partial) refuses %s', (reason, over) => {
    expect(planDonation(input(over))).toEqual({ kind: 'refuse', reason });
  });

  it('WAL-4 (partial) refuses when the drive lead turned donations off', () => {
    expect(planDonation(input({ target: { ...input().target, donationsEnabled: false } }))).toEqual({ kind: 'refuse', reason: 'donations_disabled' });
  });

  it('refuses a target that is not a drive wallet (a personal wallet or an agent page)', () => {
    expect(planDonation(input({ target: { ...input().target, subjectType: null } }))).toEqual({ kind: 'refuse', reason: 'not_a_drive_wallet' });
    expect(planDonation(input({ target: { ...input().target, subjectType: 'agent_page' } }))).toEqual({ kind: 'refuse', reason: 'not_a_drive_wallet' });
  });

  it('refuses a source that is not the donor personal wallet, and a wallet donating to itself', () => {
    expect(planDonation(input({ donor: { ...input().donor, isPersonalRoot: false } }))).toEqual({ kind: 'refuse', reason: 'not_personal_wallet' });
    expect(planDonation(input({ donor: { ...input().donor, walletId: 'w-product' } }))).toEqual({ kind: 'refuse', reason: 'same_wallet' });
  });

  it('counts the donor debt and in-flight holds against what they can give', () => {
    const donor = { ...input().donor, balance: { monthlyCents: 500, topupCents: 1000, debtCents: 400 }, heldCents: 401 };
    expect(planDonation(input({ donor }))).toEqual({ kind: 'refuse', reason: 'insufficient_funds' });
    expect(planDonation(input({ donor: { ...donor, heldCents: 400 } })).kind).toBe('donate');
  });
});

describe('wallet-funding purity', () => {
  it('imports no db, no Stripe, no env, and reads no clock', () => {
    const src = readFileSync(fileURLToPath(new URL('../wallet-funding.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/@pagespace\/db|stripe['"]|process\.env|Date\.now\(|new Date\(\)/);
  });
});
