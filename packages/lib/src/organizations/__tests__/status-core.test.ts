import { describe, it, expect } from 'vitest';
import { ORG_BUSINESS_TRIAL_DAYS } from '../../billing/org-subscription-core';
import {
  ORG_LAPSED_MESSAGE,
  ORG_TRIAL_GRACE_MS,
  deriveOrgStatus,
  orgBillingNotice,
  orgLapseTransition,
  orgLegStatus,
  orgStatusAllows,
  type OrgSubscriptionState,
} from '../status-core';

const NOW = new Date('2026-09-27T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
/** An org created long ago: its creation trial is over. */
const OLD_ORG = new Date(NOW.getTime() - 365 * DAY);

function sub(status: string, over: Partial<OrgSubscriptionState> = {}): OrgSubscriptionState {
  return {
    status,
    trialEnd: null,
    currentPeriodStart: new Date(NOW.getTime() - 10 * DAY),
    currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY),
    cancelAtPeriodEnd: false,
    ...over,
  };
}

describe('deriveOrgStatus', () => {
  it('SEAT-9 (partial) billing disabled (onprem, tenant) is always active, with or without a subscription row', () => {
    expect(deriveOrgStatus({ billingEnabled: false, subscription: null, orgCreatedAt: OLD_ORG, now: NOW })).toEqual({ status: 'active', reason: null });
    expect(deriveOrgStatus({ billingEnabled: false, subscription: sub('canceled'), orgCreatedAt: OLD_ORG, now: NOW })).toEqual({ status: 'active', reason: null });
  });

  it('SEAT-9 (partial) SEAT-8 (partial) an org with no subscription is on its creation trial, then lapsed: there is no free org tier', () => {
    const trialMs = ORG_BUSINESS_TRIAL_DAYS * DAY;
    // Created just now while Stripe was unreachable (D1's "pending"): trialing, as SEAT-8 promises.
    expect(deriveOrgStatus({ billingEnabled: true, subscription: null, orgCreatedAt: NOW, now: NOW })).toEqual({ status: 'trialing', reason: null });
    const justInside = new Date(NOW.getTime() - trialMs - ORG_TRIAL_GRACE_MS + 1);
    expect(deriveOrgStatus({ billingEnabled: true, subscription: null, orgCreatedAt: justInside, now: NOW }).status).toBe('trialing');
    const over = new Date(NOW.getTime() - trialMs - ORG_TRIAL_GRACE_MS);
    expect(deriveOrgStatus({ billingEnabled: true, subscription: null, orgCreatedAt: over, now: NOW })).toEqual({ status: 'lapsed', reason: 'no_subscription' });
    expect(deriveOrgStatus({ billingEnabled: true, subscription: null, orgCreatedAt: OLD_ORG, now: NOW })).toEqual({ status: 'lapsed', reason: 'no_subscription' });
  });

  it('SEAT-9 (partial) a subscription row decides alone: a new org whose trial Stripe already canceled is lapsed', () => {
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('canceled'), orgCreatedAt: NOW, now: NOW })).toEqual({ status: 'lapsed', reason: 'canceled' });
  });

  it('SEAT-9 (partial) active and past_due keep the org working; past_due is Stripe still retrying', () => {
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('active'), orgCreatedAt: OLD_ORG, now: NOW }).status).toBe('active');
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('past_due'), orgCreatedAt: OLD_ORG, now: NOW }).status).toBe('past_due');
  });

  it('SEAT-9 (partial) a trial is trialing until its end plus the grace window, then lapsed as trial_expired', () => {
    const trialEnd = new Date(NOW.getTime() - ORG_TRIAL_GRACE_MS + 1);
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('trialing', { trialEnd }), orgCreatedAt: OLD_ORG, now: NOW }).status).toBe('trialing');
    const expired = new Date(NOW.getTime() - ORG_TRIAL_GRACE_MS);
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('trialing', { trialEnd: expired }), orgCreatedAt: OLD_ORG, now: NOW })).toEqual({
      status: 'lapsed',
      reason: 'trial_expired',
    });
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('trialing', { trialEnd: null }), orgCreatedAt: OLD_ORG, now: NOW }).status).toBe('trialing');
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
      expect(deriveOrgStatus({ billingEnabled: true, subscription: sub(status), orgCreatedAt: OLD_ORG, now: NOW })).toEqual({ status: 'lapsed', reason });
    }
  });

  it('SEAT-9 (partial) trial → canceled (no card at trial end): the last period is the trial, so it is lapsed as trial_expired', () => {
    const trialEnd = new Date(NOW.getTime() - DAY);
    // Stripe canceled it at the end of its only period, the trial.
    const trialPeriod = { trialEnd, currentPeriodStart: new Date(trialEnd.getTime() - ORG_BUSINESS_TRIAL_DAYS * DAY), currentPeriodEnd: trialEnd };
    for (const status of ['canceled', 'incomplete_expired']) {
      expect(deriveOrgStatus({ billingEnabled: true, subscription: sub(status, trialPeriod), orgCreatedAt: OLD_ORG, now: NOW })).toEqual({
        status: 'lapsed',
        reason: 'trial_expired',
      });
    }
  });

  it('SEAT-9 (partial) trial → paid → canceled keeps its historical trialEnd but is lapsed as canceled, not trial_expired', () => {
    const trialEnd = new Date(NOW.getTime() - 90 * DAY);
    // Paid periods follow the trial; Stripe starts the first one exactly at trialEnd.
    const firstPaid = { trialEnd, currentPeriodStart: trialEnd, currentPeriodEnd: new Date(trialEnd.getTime() + 30 * DAY) };
    const laterPaid = { trialEnd, currentPeriodStart: new Date(NOW.getTime() - 30 * DAY), currentPeriodEnd: NOW };
    for (const period of [firstPaid, laterPaid]) {
      expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('canceled', period), orgCreatedAt: OLD_ORG, now: NOW })).toEqual({
        status: 'lapsed',
        reason: 'canceled',
      });
    }
  });

  it('SEAT-9 (partial) a canceled row with no known period, or canceled before its trial ended, is lapsed as canceled', () => {
    const trialEnd = new Date(NOW.getTime() - DAY);
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('canceled', { trialEnd, currentPeriodStart: null }), orgCreatedAt: OLD_ORG, now: NOW }).reason).toBe('canceled');
    const futureTrialEnd = new Date(NOW.getTime() + 5 * DAY);
    expect(
      deriveOrgStatus({ billingEnabled: true, subscription: sub('canceled', { trialEnd: futureTrialEnd, currentPeriodStart: new Date(NOW.getTime() - 9 * DAY) }), orgCreatedAt: OLD_ORG, now: NOW }).reason,
    ).toBe('canceled');
  });

  it('SEAT-9 (partial) an unrecognised Stripe status fails closed to lapsed', () => {
    expect(deriveOrgStatus({ billingEnabled: true, subscription: sub('something_new'), orgCreatedAt: OLD_ORG, now: NOW })).toEqual({ status: 'lapsed', reason: 'unknown_status' });
  });
});

describe('orgStatusAllows', () => {
  it('SEAT-9 (partial) only a lapsed org is refused, with the lapse refusal message and a stable code', () => {
    expect(orgStatusAllows({ status: 'active', reason: null })).toEqual({ ok: true });
    expect(orgStatusAllows({ status: 'trialing', reason: null })).toEqual({ ok: true });
    expect(orgStatusAllows({ status: 'past_due', reason: null })).toEqual({ ok: true });
    expect(orgStatusAllows({ status: 'lapsed', reason: 'canceled' })).toEqual({ ok: false, code: 'org_lapsed', status: 402, message: ORG_LAPSED_MESSAGE });
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

describe('orgLegStatus', () => {
  it('SEAT-9 (partial) SPEND-6 (partial) while the org is lapsed every org wallet leg reads as paused, whatever it stores; otherwise as stored', () => {
    for (const stored of ['active', 'paused', 'over'] as const) {
      expect(orgLegStatus(stored, true)).toBe('paused');
      expect(orgLegStatus(stored, false)).toBe(stored);
    }
  });
});
