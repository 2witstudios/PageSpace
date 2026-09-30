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
  const base = { held: 4, included: INCLUDED, purchasedExtra: 0, autoAdd: false, billingEnabled: true };

  it('SEAT-4 (partial) a seat inside the included five needs no Stripe change, auto-add on or off', () => {
    expect(decideSeatAdmission({ ...base, held: 4 })).toEqual({ action: 'admit' });
    expect(decideSeatAdmission({ ...base, held: 4, autoAdd: true })).toEqual({ action: 'admit' });
  });

  it('SEAT-4 (partial) the sixth seat with auto-add ON raises the quantity to one', () => {
    expect(decideSeatAdmission({ ...base, held: 5, autoAdd: true })).toEqual({ action: 'raise', toExtra: 1 });
  });

  it('SEAT-4 (partial) the sixth seat with auto-add OFF is refused and names the purchased count', () => {
    expect(decideSeatAdmission({ ...base, held: 5, autoAdd: false })).toEqual({ action: 'refuse', reason: 'auto_add_off', purchased: 5, held: 5 });
  });

  it('SEAT-5 (partial) a seat already paid for (a removed member\'s) is reused: no raise, no refusal, even with auto-add off', () => {
    // 6 seats bought, 5 held now: the sixth is paid for.
    expect(decideSeatAdmission({ ...base, held: 5, purchasedExtra: 1, autoAdd: false })).toEqual({ action: 'admit' });
    expect(decideSeatAdmission({ ...base, held: 5, purchasedExtra: 1, autoAdd: true })).toEqual({ action: 'admit' });
    // ...but the seventh is not.
    expect(decideSeatAdmission({ ...base, held: 6, purchasedExtra: 1, autoAdd: true })).toEqual({ action: 'raise', toExtra: 2 });
    expect(decideSeatAdmission({ ...base, held: 6, purchasedExtra: 1, autoAdd: false })).toMatchObject({ action: 'refuse', purchased: 6 });
  });

  it('SEAT-4 (partial) an org with no seat-billing (onprem, tenant) is never limited', () => {
    expect(decideSeatAdmission({ ...base, held: 500, billingEnabled: false })).toEqual({ action: 'admit' });
  });
});

describe('decideSeatRelease', () => {
  const base = { held: 5, included: INCLUDED, purchasedExtra: 2, cancelAtPeriodEnd: false };
  const inWindow = new Date(NOW.getTime() + SEAT_RELEASE_LEAD_MS / 2);

  it('SEAT-5 (partial) mid-period nothing is released, however many seats are unused', () => {
    const farEnd = new Date(NOW.getTime() + 10 * 24 * HOUR);
    expect(decideSeatRelease({ ...base, currentPeriodEnd: farEnd, now: NOW })).toEqual({ action: 'keep', reason: 'mid_period' });
  });

  it('SEAT-5 (partial) inside the lead window before the renewal, unused seats are handed back down to what is held', () => {
    expect(decideSeatRelease({ ...base, currentPeriodEnd: inWindow, now: NOW })).toEqual({ action: 'release', toExtra: 0 });
    expect(decideSeatRelease({ ...base, held: 6, currentPeriodEnd: inWindow, now: NOW })).toEqual({ action: 'release', toExtra: 1 });
  });

  it('SEAT-5 (partial) never lowers below the seats held, and never raises', () => {
    expect(decideSeatRelease({ ...base, held: 7, currentPeriodEnd: inWindow, now: NOW })).toEqual({ action: 'keep', reason: 'nothing_unused' });
    expect(decideSeatRelease({ ...base, held: 9, currentPeriodEnd: inWindow, now: NOW })).toEqual({ action: 'keep', reason: 'nothing_unused' });
  });

  it('SEAT-5 (partial) a period end already passed (stale row) still releases, for the period that follows', () => {
    expect(decideSeatRelease({ ...base, currentPeriodEnd: new Date(NOW.getTime() - HOUR), now: NOW })).toEqual({ action: 'release', toExtra: 0 });
  });

  it('SEAT-5 (partial) a subscription ending at period end, or with no known period, releases nothing', () => {
    expect(decideSeatRelease({ ...base, cancelAtPeriodEnd: true, currentPeriodEnd: inWindow, now: NOW })).toEqual({ action: 'keep', reason: 'ending' });
    expect(decideSeatRelease({ ...base, currentPeriodEnd: null, now: NOW })).toEqual({ action: 'keep', reason: 'no_period' });
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
});
