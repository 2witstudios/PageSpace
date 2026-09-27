import { describe, it, expect } from 'vitest';
import {
  ORG_LAPSED_MESSAGE,
  ORG_TRIAL_GRACE_MS,
  deriveOrgStatus,
  orgBillingNotice,
  orgLapseTransition,
  orgStatusAllows,
  type OrgSubscriptionState,
} from '../status-core';

const NOW = new Date('2026-09-27T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function sub(status: string, over: Partial<OrgSubscriptionState> = {}): OrgSubscriptionState {
  return {
    status,
    trialEnd: null,
    currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY),
    cancelAtPeriodEnd: false,
    ...over,
  };
}

describe('deriveOrgStatus', () => {
  it('SEAT-9 (partial) billing disabled (onprem, tenant) is always active, with or without a subscription row', () => {
    expect(deriveOrgStatus({ billingEnabled: false, subscription: null, now: NOW })).toEqual({ status: 'active', reason: null });
    expect(deriveOrgStatus({ billingEnabled: false, subscription: sub('canceled'), now: NOW })).toEqual({ status: 'active', reason: null });
  });

  it('SEAT-9 (partial) an org with no subscription is lapsed: there is no free org tier', () => {
    expect(deriveOrgStatus({ billingEnabled: true, subscription: null, now: NOW })).toEqual({ status: 'lapsed', reason: 'no_subscription' });
  });

  it('SEAT-9 (partial) active and past_due keep the org working; past_due is Stripe still retrying', () => {
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('active'), now: NOW }).status).toBe('active');
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('past_due'), now: NOW }).status).toBe('past_due');
  });

  it('SEAT-9 (partial) a trial is trialing until its end plus the grace window, then lapsed as trial_expired', () => {
    const trialEnd = new Date(NOW.getTime() - ORG_TRIAL_GRACE_MS + 1);
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('trialing', { trialEnd }), now: NOW }).status).toBe('trialing');
    const expired = new Date(NOW.getTime() - ORG_TRIAL_GRACE_MS);
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('trialing', { trialEnd: expired }), now: NOW })).toEqual({
      status: 'lapsed',
      reason: 'trial_expired',
    });
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('trialing', { trialEnd: null }), now: NOW }).status).toBe('trialing');
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
      expect(deriveOrgStatus({ billingEnabled: true, subscription: sub(status), now: NOW })).toEqual({ status: 'lapsed', reason });
    }
  });

  it('SEAT-9 (partial) a canceled trial (no card at trial end) is lapsed as trial_expired', () => {
    const trialEnd = new Date(NOW.getTime() - DAY);
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('canceled', { trialEnd }), now: NOW })).toEqual({
      status: 'lapsed',
      reason: 'trial_expired',
    });
  });

  it('SEAT-9 (partial) an unrecognised Stripe status fails closed to lapsed', () => {
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('something_new'), now: NOW })).toEqual({ status: 'lapsed', reason: 'unknown_status' });
  });
});

describe('orgStatusAllows', () => {
  it('SEAT-9 (partial) only a lapsed org is refused, with the SEAT-9 message and a stable code', () => {
    expect(orgStatusAllows({ status: 'active', reason: null })).toEqual({ ok: true });
    expect(orgStatusAllows({ status: 'trialing', reason: null })).toEqual({ ok: true });
    expect(orgStatusAllows({ status: 'past_due', reason: null })).toEqual({ ok: true });
    expect(orgStatusAllows({ status: 'lapsed', reason: 'canceled' })).toEqual({ ok: false, code: 'org_lapsed', message: ORG_LAPSED_MESSAGE });
  });

  it('SEAT-9 (partial) the refusal message says drives stay readable and nothing is deleted', () => {
    expect(ORG_LAPSED_MESSAGE).toMatch(/readable/);
    expect(ORG_LAPSED_MESSAGE).toMatch(/nothing (has been|is) deleted/i);
    expect(ORG_LAPSED_MESSAGE).not.toMatch(/\$/);
  });
});

describe('orgLapseTransition', () => {
  it('SEAT-9 (partial) entering and leaving lapse are explicit transitions; staying put is none', () => {
    expect(orgLapseTransition('active', 'lapsed')).toBe('entered_lapse');
    expect(orgLapseTransition('trialing', 'lapsed')).toBe('entered_lapse');
    expect(orgLapseTransition('past_due', 'lapsed')).toBe('entered_lapse');
    expect(orgLapseTransition('lapsed', 'active')).toBe('left_lapse');
    expect(orgLapseTransition('lapsed', 'trialing')).toBe('left_lapse');
    expect(orgLapseTransition('lapsed', 'lapsed')).toBeNull();
    expect(orgLapseTransition('active', 'past_due')).toBeNull();
    expect(orgLapseTransition(null, 'lapsed')).toBe('entered_lapse');
    expect(orgLapseTransition(null, 'active')).toBeNull();
  });
});

describe('orgBillingNotice', () => {
  const trialEnd = new Date(NOW.getTime() + 3 * DAY);

  it('SEAT-9 (partial) a lapsed org: Owner and Admins get the reactivate banner, members a read-only notice', () => {
    const lapsed = { status: 'lapsed' as const, reason: 'unpaid' as const };
    expect(orgBillingNotice({ result: lapsed, role: 'OWNER', trialEnd: null })).toEqual({ kind: 'reactivate', reason: 'unpaid', canManageBilling: true });
    expect(orgBillingNotice({ result: lapsed, role: 'ADMIN', trialEnd: null })).toEqual({ kind: 'reactivate', reason: 'unpaid', canManageBilling: true });
    expect(orgBillingNotice({ result: lapsed, role: 'MEMBER', trialEnd: null })).toEqual({ kind: 'read_only', canManageBilling: false });
  });

  it('SEAT-6 (partial) plan details (reason, trial end, payment failure) reach Owner and Admins only; a member sees nothing while the org works', () => {
    expect(orgBillingNotice({ result: { status: 'past_due', reason: null }, role: 'ADMIN', trialEnd: null })).toEqual({
      kind: 'payment_failed',
      canManageBilling: true,
    });
    expect(orgBillingNotice({ result: { status: 'past_due', reason: null }, role: 'MEMBER', trialEnd: null })).toBeNull();
    expect(orgBillingNotice({ result: { status: 'trialing', reason: null }, role: 'OWNER', trialEnd })).toEqual({
      kind: 'trial',
      trialEnd: trialEnd.toISOString(),
      canManageBilling: true,
    });
    expect(orgBillingNotice({ result: { status: 'trialing', reason: null }, role: 'MEMBER', trialEnd })).toBeNull();
    expect(orgBillingNotice({ result: { status: 'active', reason: null }, role: 'OWNER', trialEnd: null })).toBeNull();
    // The member notice for a lapsed org carries no reason: why billing lapsed is plan detail.
    const memberLapsed = orgBillingNotice({ result: { status: 'lapsed', reason: 'unpaid' }, role: 'MEMBER', trialEnd: null });
    expect(memberLapsed).not.toHaveProperty('reason');
  });
});
