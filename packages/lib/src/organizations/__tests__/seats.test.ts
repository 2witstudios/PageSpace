/**
 * The pure seat decisions (Spec SEAT-3, SEAT-4, SEAT-5): what a seat count is, whether an
 * invite may take the next seat and at what Stripe quantity, and when a freed seat is
 * handed back. No IO here; seat-service.integration.test.ts proves the same rules against
 * a real Postgres and a recording Stripe.
 */
import { describe, it, expect } from 'vitest';
import { orgExtraSeatQuantity } from '../../billing/org-subscription-core';
import { TIER_PLAN_LIMITS } from '../../billing/subscription-tiers';
import {
  SEAT_RELEASE_LEAD_MS,
  decideSeatAdmission,
  decideSeatRelease,
  seatQuantity,
  seatRefusalMessage,
} from '../seats';

const INCLUDED = TIER_PLAN_LIMITS.business.includedSeats;
const HOUR = 3_600_000;
const NOW = new Date('2026-09-30T12:00:00.000Z');

describe('seatQuantity', () => {
  it('SEAT-3 (partial) a seat is an accepted member or a pending invite, nothing else', () => {
    expect(seatQuantity({ members: 4, pendingInvites: 2, included: INCLUDED })).toEqual({ held: 6, extra: 1 });
    expect(seatQuantity({ members: 1, pendingInvites: 0, included: INCLUDED })).toEqual({ held: 1, extra: 0 });
  });

  it('SEAT-3 (partial) agrees with the D1 quantity function at every count', () => {
    for (let held = 0; held <= 20; held += 1) {
      expect(seatQuantity({ members: held, pendingInvites: 0, included: INCLUDED }).extra).toBe(orgExtraSeatQuantity(held));
      expect(seatQuantity({ members: 0, pendingInvites: held, included: INCLUDED }).extra).toBe(orgExtraSeatQuantity(held));
    }
  });

  it('SEAT-3 (partial) refuses counts that are not non-negative integers', () => {
    expect(() => seatQuantity({ members: -1, pendingInvites: 0, included: 5 })).toThrow(RangeError);
    expect(() => seatQuantity({ members: 1.5, pendingInvites: 0, included: 5 })).toThrow(RangeError);
    expect(() => seatQuantity({ members: 1, pendingInvites: Number.NaN, included: 5 })).toThrow(RangeError);
    expect(() => seatQuantity({ members: 1, pendingInvites: 0, included: -1 })).toThrow(RangeError);
  });
});

describe('decideSeatAdmission', () => {
  // Mid-period: the period ends in ten days and only its start boundary has been reconciled.
  const midPeriod = { end: new Date(NOW.getTime() + 10 * 24 * HOUR), reconciledThrough: new Date(NOW.getTime() - 20 * 24 * HOUR) };
  const base = { held: 4, included: INCLUDED, purchasedExtra: 0, autoAdd: false, billingEnabled: true, period: midPeriod, now: NOW, giftedExtraSeats: null, credential: 'session' as const };

  it('SEAT-4 (partial) a seat inside the included five needs no Stripe change, auto-add on or off', () => {
    expect(decideSeatAdmission({ ...base, held: 4 })).toEqual({ action: 'admit' });
    expect(decideSeatAdmission({ ...base, held: 4, autoAdd: true })).toEqual({ action: 'admit' });
  });

  it('SEAT-4 (partial) the sixth seat with auto-add ON raises the quantity to one', () => {
    expect(decideSeatAdmission({ ...base, held: 5, autoAdd: true })).toEqual({ action: 'raise', toExtra: 1, proration: 'create_prorations' });
  });

  it('SEAT-4 (partial) the sixth seat with auto-add OFF is refused and names the purchased count', () => {
    expect(decideSeatAdmission({ ...base, held: 5, autoAdd: false })).toEqual({ action: 'refuse', reason: 'auto_add_off', purchased: 5, held: 5 });
  });

  it('SEAT-5 (partial) a seat already paid for (a removed member\'s) is reused: no raise, no refusal, even with auto-add off', () => {
    // 6 seats bought, 5 held now: the sixth is paid for.
    expect(decideSeatAdmission({ ...base, held: 5, purchasedExtra: 1, autoAdd: false })).toEqual({ action: 'admit' });
    expect(decideSeatAdmission({ ...base, held: 5, purchasedExtra: 1, autoAdd: true })).toEqual({ action: 'admit' });
    // ...but the seventh is not.
    expect(decideSeatAdmission({ ...base, held: 6, purchasedExtra: 1, autoAdd: true })).toEqual({ action: 'raise', toExtra: 2, proration: 'create_prorations' });
    expect(decideSeatAdmission({ ...base, held: 6, purchasedExtra: 1, autoAdd: false })).toMatchObject({ action: 'refuse', purchased: 6 });
  });

  it('SEAT-5 (partial) a re-add after the pre-boundary release (the period end already reconciled, still inside the period) raises with NO proration: re-adding within the period never charges', () => {
    const released = { end: new Date(NOW.getTime() + HOUR / 2), reconciledThrough: new Date(NOW.getTime() + HOUR / 2) };
    expect(decideSeatAdmission({ ...base, held: 5, autoAdd: true, period: released })).toEqual({ action: 'raise', toExtra: 1, proration: 'none' });
    // Before the release ran for this boundary the raise is a new seat: prorated (SEAT-4).
    const unreleased = { end: released.end, reconciledThrough: midPeriod.reconciledThrough };
    expect(decideSeatAdmission({ ...base, held: 5, autoAdd: true, period: unreleased })).toEqual({ action: 'raise', toExtra: 1, proration: 'create_prorations' });
    // Once the boundary has passed the release belongs to the PAST period: a raise is prorated again.
    expect(decideSeatAdmission({ ...base, held: 5, autoAdd: true, period: released, now: new Date(released.end.getTime() + 1) })).toMatchObject({ proration: 'create_prorations' });
    // No live subscription (no period) prices nothing here: provisioning bills the real count.
    expect(decideSeatAdmission({ ...base, held: 5, autoAdd: true, period: null })).toEqual({ action: 'raise', toExtra: 1, proration: 'create_prorations' });
  });

  it('SEAT-4 (partial) an org with no seat-billing (onprem, tenant) is never limited', () => {
    expect(decideSeatAdmission({ ...base, held: 500, billingEnabled: false })).toEqual({ action: 'admit' });
  });

  it('X-1 (partial) [D-OW-26] a delegated key never raises the seat quantity: a seat past the purchased count is refused by name, auto-add or not', () => {
    const key = { ...base, credential: 'mcp' as const };
    expect(decideSeatAdmission({ ...key, held: 5, autoAdd: true })).toEqual({ action: 'refuse', reason: 'delegated_raise', purchased: 5, held: 5 });
    expect(decideSeatAdmission({ ...key, held: 5, autoAdd: false })).toMatchObject({ action: 'refuse', reason: 'auto_add_off' });
  });

  it('X-1 (partial) [D-OW-26] within the purchased seats a delegated key is admitted like a session', () => {
    const key = { ...base, credential: 'mcp' as const };
    expect(decideSeatAdmission({ ...key, held: 4 })).toEqual({ action: 'admit' });
    expect(decideSeatAdmission({ ...key, held: 5, purchasedExtra: 1, autoAdd: true })).toEqual({ action: 'admit' });
    expect(decideSeatAdmission({ ...key, held: 500, billingEnabled: false })).toEqual({ action: 'admit' });
  });
});

describe('decideSeatAdmission for a gifted org (D-OW-54)', () => {
  const midPeriod = { end: new Date(NOW.getTime() + 10 * 24 * HOUR), reconciledThrough: null };
  const gifted = { included: INCLUDED, purchasedExtra: 2, billingEnabled: true, period: midPeriod, now: NOW, giftedExtraSeats: 2, credential: 'session' as const };

  it('SEAT-8 (partial) seats up to the gifted count are admitted', () => {
    expect(decideSeatAdmission({ ...gifted, held: 6, autoAdd: true })).toEqual({ action: 'admit' });
  });

  it('SEAT-8 (partial) past the gifted count the invite is refused even with auto-add on: a gift is never raised', () => {
    for (const autoAdd of [true, false]) {
      expect(decideSeatAdmission({ ...gifted, held: 7, autoAdd })).toEqual({ action: 'refuse', reason: 'gifted_seats_full', purchased: 7, held: 7 });
    }
  });

  it('SEAT-8 (partial) the cap is the gifted count, not a Stripe quantity that drifted above it', () => {
    expect(decideSeatAdmission({ ...gifted, purchasedExtra: 9, held: 7, autoAdd: true })).toMatchObject({ action: 'refuse', reason: 'gifted_seats_full', purchased: 7 });
  });
});

describe('decideSeatRelease', () => {
  // The period started 25 days ago and its start boundary was reconciled (the last release ran).
  const periodStart = new Date(NOW.getTime() - 25 * 24 * HOUR);
  const base = { held: 5, included: INCLUDED, purchasedExtra: 2, cancelAtPeriodEnd: false, currentPeriodStart: periodStart, reconciledThrough: periodStart, giftedExtraSeats: null };
  const inWindow = new Date(NOW.getTime() + SEAT_RELEASE_LEAD_MS / 2);

  it('SEAT-8 (partial) D-OW-54 a gifted org keeps the seat item at the gifted quantity at every boundary: nothing is released below it or raised above it', () => {
    expect(decideSeatRelease({ ...base, held: 2, giftedExtraSeats: 2, currentPeriodEnd: inWindow, now: NOW })).toEqual({ action: 'keep', reason: 'nothing_unused', boundary: inWindow });
    expect(decideSeatRelease({ ...base, held: 12, giftedExtraSeats: 2, currentPeriodEnd: inWindow, now: NOW })).toEqual({ action: 'keep', reason: 'nothing_unused', boundary: inWindow });
    // A quantity changed outside the app is brought back to the gift, never kept.
    expect(decideSeatRelease({ ...base, purchasedExtra: 9, giftedExtraSeats: 2, currentPeriodEnd: inWindow, now: NOW })).toEqual({ action: 'release', toExtra: 2, proration: 'none', boundary: inWindow });
  });

  it('SEAT-5 (partial) mid-period nothing is released, however many seats are unused', () => {
    const farEnd = new Date(NOW.getTime() + 10 * 24 * HOUR);
    expect(decideSeatRelease({ ...base, currentPeriodEnd: farEnd, now: NOW })).toEqual({ action: 'keep', reason: 'mid_period' });
  });

  it('SEAT-5 (partial) inside the lead window before the renewal, unused seats are handed back down to what is held, with no proration, and the boundary is recorded', () => {
    expect(decideSeatRelease({ ...base, currentPeriodEnd: inWindow, now: NOW })).toEqual({ action: 'release', toExtra: 0, proration: 'none', boundary: inWindow });
    expect(decideSeatRelease({ ...base, held: 6, currentPeriodEnd: inWindow, now: NOW })).toEqual({ action: 'release', toExtra: 1, proration: 'none', boundary: inWindow });
  });

  it('SEAT-5 (partial) never lowers below the seats held: exactly what is held is left alone, and the boundary is still recorded', () => {
    expect(decideSeatRelease({ ...base, held: 7, currentPeriodEnd: inWindow, now: NOW })).toEqual({ action: 'keep', reason: 'nothing_unused', boundary: inWindow });
  });

  it('SEAT-5 (partial) a Stripe quantity BELOW the seats held is restored at the boundary (prorated), never left as a free seat', () => {
    expect(decideSeatRelease({ ...base, held: 9, currentPeriodEnd: inWindow, now: NOW })).toEqual({ action: 'restore', toExtra: 4, proration: 'create_prorations', boundary: inWindow });
  });

  it('SEAT-5 (partial) review 3+4 P2-8: a period end already passed and never reconciled (stale row) is caught up WITH prorations — Stripe already billed the renewal, so the org is credited, not billed a full extra period', () => {
    const passed = new Date(NOW.getTime() - HOUR);
    expect(decideSeatRelease({ ...base, currentPeriodEnd: passed, now: NOW })).toEqual({ action: 'release', toExtra: 0, proration: 'create_prorations', boundary: passed });
    // Already reconciled through that end: nothing more to do.
    expect(decideSeatRelease({ ...base, reconciledThrough: passed, currentPeriodEnd: passed, now: NOW })).toEqual({ action: 'keep', reason: 'mid_period' });
  });

  it('SEAT-5 (partial) review 3+4 P2-8: a MISSED release window (the new period began, its start boundary never reconciled) is caught up on the next run, prorated, and only once', () => {
    const newStart = new Date(NOW.getTime() - 2 * HOUR);
    const newEnd = new Date(NOW.getTime() + 28 * 24 * HOUR);
    const missed = { ...base, currentPeriodStart: newStart, currentPeriodEnd: newEnd, reconciledThrough: periodStart };
    expect(decideSeatRelease({ ...missed, now: NOW })).toEqual({ action: 'release', toExtra: 0, proration: 'create_prorations', boundary: newStart });
    expect(decideSeatRelease({ ...missed, held: 9, now: NOW })).toEqual({ action: 'restore', toExtra: 4, proration: 'create_prorations', boundary: newStart });
    expect(decideSeatRelease({ ...missed, held: 7, now: NOW })).toEqual({ action: 'keep', reason: 'nothing_unused', boundary: newStart });
    // Once recorded, the same period is mid-period again: a seat freed in it waits for its end (SEAT-5).
    expect(decideSeatRelease({ ...missed, reconciledThrough: newStart, now: NOW })).toEqual({ action: 'keep', reason: 'mid_period' });
  });

  it('SEAT-5 (partial) a subscription never reconciled before records a baseline at its period start and changes nothing in Stripe', () => {
    const farEnd = new Date(NOW.getTime() + 10 * 24 * HOUR);
    expect(decideSeatRelease({ ...base, reconciledThrough: null, currentPeriodEnd: farEnd, now: NOW })).toEqual({ action: 'keep', reason: 'baseline', boundary: periodStart });
    expect(decideSeatRelease({ ...base, reconciledThrough: null, currentPeriodStart: null, currentPeriodEnd: farEnd, now: NOW })).toEqual({ action: 'keep', reason: 'mid_period' });
  });

  it('SEAT-5 (partial) a subscription ending at period end, or with no known period, releases nothing', () => {
    expect(decideSeatRelease({ ...base, cancelAtPeriodEnd: true, currentPeriodEnd: inWindow, now: NOW })).toEqual({ action: 'keep', reason: 'ending' });
    expect(decideSeatRelease({ ...base, currentPeriodEnd: null, now: NOW })).toEqual({ action: 'keep', reason: 'no_period' });
  });
});


describe('seatRefusalMessage for a gifted org', () => {
  it('SEAT-8 (partial) says the gift fixes the seats, how to free one, and shows a Member no count', () => {
    const asOwner = seatRefusalMessage({ purchased: 7, held: 7, actorRole: 'OWNER', reason: 'gifted_seats_full' });
    expect(asOwner).toContain('7 seats');
    expect(asOwner).toMatch(/gift/i);
    expect(asOwner).toMatch(/revoke|remove/i);
    expect(asOwner).not.toMatch(/automatic seat/i);
    const asMember = seatRefusalMessage({ purchased: 7, held: 7, actorRole: 'MEMBER', reason: 'gifted_seats_full' });
    expect(asMember).not.toMatch(/\d/);
    expect(asMember).toMatch(/owner/i);
  });
});

describe('seatRefusalMessage', () => {
  it('SEAT-4 (partial) tells the person what happened and what to do, with no price or credit figure', () => {
    const asAdmin = seatRefusalMessage({ purchased: 5, held: 5, actorRole: 'ADMIN' });
    expect(asAdmin).toContain('5 seats');
    expect(asAdmin).toMatch(/owner/i);
    const asOwner = seatRefusalMessage({ purchased: 5, held: 5, actorRole: 'OWNER' });
    expect(asOwner).toMatch(/automatic seat/i);
    expect(asOwner).toMatch(/revoke|remove/i);
    expect(`${asAdmin} ${asOwner}`).not.toMatch(/\$|credit/i);
  });

  it('SEAT-6 (partial) a Member is told no seat count: seat count is Owner/Admin only, and the message stays clear', () => {
    const asMember = seatRefusalMessage({ purchased: 7, held: 7, actorRole: 'MEMBER' });
    expect(asMember).not.toMatch(/\d/);
    expect(asMember).toMatch(/seat/i);
    expect(asMember).toMatch(/owner|admin/i);
  });
});
