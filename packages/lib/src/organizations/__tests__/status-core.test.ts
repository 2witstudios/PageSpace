import { describe, it, expect } from 'vitest';
import {
  decideOrgMayLoosen,
  ORG_LAPSED_REFUSAL,
  ORG_LAPSED_MESSAGE,
  deriveOrgStatus,
  orgBillingNotice,
  orgLapseTransition,
  orgLegStatus,
  orgStatusAllows,
  type OrgSubscriptionState,
} from '../status-core';

function sub(status: string, over: Partial<OrgSubscriptionState> = {}): OrgSubscriptionState {
  return { status, collectionMethod: 'charge_automatically', hasVerifiedFunding: true, ...over };
}

describe('deriveOrgStatus', () => {
  it('SEAT-9 (partial) billing disabled (onprem, tenant) is always active, with or without a subscription row', () => {
    expect(deriveOrgStatus({ billingEnabled: false, subscription: null })).toEqual({ status: 'active', reason: null });
    expect(deriveOrgStatus({ billingEnabled: false, subscription: sub('canceled') })).toEqual({ status: 'active', reason: null });
  });

  it('SEAT-9 (partial) SEAT-8 (partial) D-OW-30 an org with no subscription row is lapsed from the moment it exists: there is no creation trial and no free org tier', () => {
    // Created just now and not yet paid (or Stripe was unreachable): nothing to spend until a payment lands.
    expect(deriveOrgStatus({ billingEnabled: true, subscription: null })).toEqual({ status: 'lapsed', reason: 'no_subscription' });
  });

  it('SEAT-9 (partial) SEAT-8 (partial) D-OW-30 a new org whose first invoice is not paid yet (incomplete) is lapsed until the card is confirmed', () => {
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('incomplete') })).toEqual({ status: 'lapsed', reason: 'incomplete' });
  });

  it('SEAT-9 (partial) a subscription row decides alone: a new org whose trial Stripe already canceled is lapsed', () => {
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('canceled') })).toEqual({ status: 'lapsed', reason: 'canceled' });
  });

  it('SEAT-9 (partial) a failed payment lapses immediately while active remains usable', () => {
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('active') }).status).toBe('active');
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('past_due') })).toEqual({ status: 'lapsed', reason: 'payment_failed' });
  });

  it('SEAT-8 (partial) SEAT-9 (partial) a Stripe-side trial never grants organization capability', () => {
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('trialing') })).toEqual({ status: 'lapsed', reason: 'trial_unsupported' });
  });

  it('SEAT-9 (partial) D-OW-44: a subscription not charged automatically (send_invoice) never grants capability, whatever its status', () => {
    for (const status of ['active', 'past_due', 'trialing', 'unpaid']) {
      expect(deriveOrgStatus({ billingEnabled: true, subscription: sub(status, { collectionMethod: 'send_invoice' }) })).toEqual({ status: 'lapsed', reason: 'manual_collection' });
    }
    expect(deriveOrgStatus({ billingEnabled: false, subscription: sub('active', { collectionMethod: 'send_invoice' }) })).toEqual({ status: 'active', reason: null });
  });

  it('SEAT-9 (partial) canceled, unpaid, incomplete_expired, paused and incomplete are lapsed with their reason', () => {
    const cases: Array<[string, string]> = [
      ['canceled', 'canceled'],
      ['incomplete_expired', 'canceled'],
      ['unpaid', 'unpaid'],
      ['paused', 'unpaid'],
      ['incomplete', 'incomplete'],
    ];
    for (const [status, reason] of cases) {
      expect(deriveOrgStatus({ billingEnabled: true, subscription: sub(status) })).toEqual({ status: 'lapsed', reason });
    }
  });

  it('SEAT-9 (partial) an active Stripe subscription without verified funding remains lapsed', () => {
    const unpaid = { ...sub('active'), hasVerifiedFunding: false };
    expect(deriveOrgStatus({ billingEnabled: true, subscription: unpaid })).toEqual({ status: 'lapsed', reason: 'never_funded' });
  });

  it('SEAT-9 (partial) an unrecognised Stripe status fails closed to lapsed', () => {
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('something_new') })).toEqual({ status: 'lapsed', reason: 'unknown_status' });
  });
});

describe('orgStatusAllows', () => {
  it('SEAT-9 (partial) only a lapsed org is refused, with the lapse refusal message and a stable code', () => {
    expect(orgStatusAllows({ status: 'active', reason: null })).toEqual({ ok: true });
    expect(orgStatusAllows({ status: 'lapsed', reason: 'canceled' })).toEqual({ ok: false, code: 'org_lapsed', status: 402, message: ORG_LAPSED_MESSAGE });
  });

  it('SEAT-9 (partial) the refusal message says drives stay readable and nothing is deleted', () => {
    expect(ORG_LAPSED_MESSAGE).toMatch(/readable/);
    expect(ORG_LAPSED_MESSAGE).toMatch(/nothing (has been|is) deleted/i);
    expect(ORG_LAPSED_MESSAGE).not.toMatch(/\$/);
  });
  it('SEAT-9 (partial): the refusal says loosening is paused and restricting still works (D-OW-33)', () => {
    expect(ORG_LAPSED_MESSAGE).toMatch(/loosening/i);
    expect(ORG_LAPSED_MESSAGE).toMatch(/restricting access still works/i);
    expect(ORG_LAPSED_MESSAGE).not.toMatch(/policy changes/i);
  });
});

describe('orgLapseTransition', () => {
  it('SEAT-9 (partial) entering and leaving lapse are explicit transitions; staying put is none', () => {
    expect(orgLapseTransition('active', 'lapsed')).toBe('entered_lapse');
    expect(orgLapseTransition('lapsed', 'active')).toBe('left_lapse');
    expect(orgLapseTransition('lapsed', 'lapsed')).toBeNull();
    expect(orgLapseTransition(null, 'lapsed')).toBe('entered_lapse');
    expect(orgLapseTransition(null, 'active')).toBeNull();
  });
});

describe('orgBillingNotice', () => {
  it('SEAT-9 (partial) a lapsed org: Owner and Admins get the reactivate banner, members a read-only notice', () => {
    const lapsed = { status: 'lapsed' as const, reason: 'unpaid' as const };
    expect(orgBillingNotice({ result: lapsed, role: 'OWNER' })).toEqual({ kind: 'reactivate', reason: 'unpaid', canManageBilling: true });
    expect(orgBillingNotice({ result: lapsed, role: 'ADMIN' })).toEqual({ kind: 'reactivate', reason: 'unpaid', canManageBilling: true });
    expect(orgBillingNotice({ result: lapsed, role: 'MEMBER' })).toEqual({ kind: 'read_only', canManageBilling: false });
  });

  it('SEAT-6 (partial) SEAT-9 (partial) failed-payment details reach managers while members see only read-only', () => {
    const result = deriveOrgStatus({ billingEnabled: true, subscription: sub('past_due') });
    for (const role of ['OWNER', 'ADMIN'] as const) {
      expect(orgBillingNotice({ result, role })).toEqual({ kind: 'reactivate', reason: 'payment_failed', canManageBilling: true });
    }
    expect(orgBillingNotice({ result, role: 'MEMBER' })).toEqual({ kind: 'read_only', canManageBilling: false });
    expect(orgBillingNotice({ result: { status: 'active', reason: null }, role: 'OWNER' })).toBeNull();
  });

});

describe('orgLegStatus', () => {
  it('SEAT-9 (partial) SPEND-6 (partial) while the org is lapsed every org wallet leg reads as paused, whatever it stores; otherwise as stored', () => {
    for (const stored of ['active', 'paused', 'over'] as const) {
      expect(orgLegStatus(stored, true)).toBe('paused');
      expect(orgLegStatus(stored, false)).toBe(stored);
    }
  });
});

describe('decideOrgMayLoosen — the one [D-OW-33] guard every loosening write asks', () => {
  it('SEAT-9 (partial) a lapsed org is refused a change that loosens access, with the lapse refusal; restricting, or any change while paid, goes through', () => {
    expect(decideOrgMayLoosen({ orgLapsed: true, loosens: true })).toEqual(ORG_LAPSED_REFUSAL);
    expect(decideOrgMayLoosen({ orgLapsed: true, loosens: false })).toBeNull();
    expect(decideOrgMayLoosen({ orgLapsed: false, loosens: true })).toBeNull();
    expect(decideOrgMayLoosen({ orgLapsed: false, loosens: false })).toBeNull();
  });
});
