import { describe, it, expect } from 'vitest';
import {
  computeChargeFor,
  computeChargeTier,
  computeSpendKind,
  driveAccrualChargeFor,
  orgComputeRefusalOf,
  isOrgComputeRefusal,
  ORG_COMPUTE_REFUSAL_MESSAGES,
  type ComputeCharge,
  sameCharge,
} from '../compute-charge';
import { ORG_ENTITLEMENT_TIER } from '../spend-target';
import { ORG_LAPSED_MESSAGE } from '../../organizations/status-core';

describe('computeChargeFor', () => {
  it('WAL-9 (partial) an org payer charges the org pool, recorded under the person who ran it — never their own wallet', () => {
    const charge = computeChargeFor({ kind: 'org', orgId: 'org-northwind' }, 'member-ana');
    expect(charge).toEqual({ kind: 'org', orgId: 'org-northwind', userId: 'member-ana' });
  });

  it('WAL-9 (partial) a personal payer charges that person, whoever ran it', () => {
    expect(computeChargeFor({ kind: 'user', userId: 'owner-1' }, 'member-ana')).toEqual({ kind: 'user', userId: 'owner-1' });
  });
});

describe('driveAccrualChargeFor and computeSpendKind', () => {
  it('WAL-2 (partial) a drive accrual on an org drive is the org pool\'s, recorded under the lead, and marked so it never counts toward the lead\'s seat', () => {
    const charge = driveAccrualChargeFor({ kind: 'org', orgId: 'org-northwind' }, 'lead-jono');
    expect(charge).toEqual({ kind: 'org', orgId: 'org-northwind', userId: 'lead-jono', accrual: true });
    expect(computeSpendKind(charge)).toBe('drive_compute');
  });

  it('WAL-2 (partial) compute a member ran on an org pool is kind compute: their seat draw', () => {
    expect(computeSpendKind(computeChargeFor({ kind: 'org', orgId: 'org-northwind' }, 'member-ana'))).toBe('compute');
  });

  it('a personal payer\'s accrual is that person\'s own compute, exactly as before', () => {
    const charge = driveAccrualChargeFor({ kind: 'user', userId: 'owner-1' }, 'owner-1');
    expect(charge).toEqual({ kind: 'user', userId: 'owner-1' });
    expect(computeSpendKind(charge)).toBe('compute');
  });
});

describe('computeChargeTier', () => {
  it('an org charge carries the org entitlement tier, not the recorded person\'s own tier', () => {
    const charge: ComputeCharge = { kind: 'org', orgId: 'o1', userId: 'free-member' };
    expect(computeChargeTier(charge, 'free')).toBe(ORG_ENTITLEMENT_TIER);
  });

  it('a personal charge carries the payer\'s own tier', () => {
    expect(computeChargeTier({ kind: 'user', userId: 'u1' }, 'pro')).toBe('pro');
  });

  it('WAL-8 (partial) SEAT-9 (partial) a LAPSED org\'s charge carries no Business entitlement: free, whatever the recorded person\'s plan', () => {
    const charge: ComputeCharge = { kind: 'org', orgId: 'o1', userId: 'pro-member' };
    expect(computeChargeTier(charge, 'pro', true)).toBe('free');
    expect(computeChargeTier(charge, 'pro', false)).toBe(ORG_ENTITLEMENT_TIER);
    // A personal charge never reads an org's lapse.
    expect(computeChargeTier({ kind: 'user', userId: 'u1' }, 'pro', true)).toBe('pro');
  });
});

describe('orgComputeRefusalOf', () => {
  it('names a missing org pool', () => {
    expect(orgComputeRefusalOf({ allowed: false, reason: 'source_refused', refusal: { source: null, reason: 'source_unavailable', options: [] } }))
      .toBe('org_wallet_unavailable');
  });

  it('names a paused org pool', () => {
    expect(orgComputeRefusalOf({ allowed: false, reason: 'source_refused', refusal: { source: null, reason: 'source_paused', options: [] } }))
      .toBe('org_wallet_paused');
  });

  it('WAL-2 (partial) names the member\'s used-up allowance of the pool, not an empty pool', () => {
    expect(orgComputeRefusalOf({ allowed: false, reason: 'source_refused', refusal: { source: null, reason: 'source_cap_reached', options: [] } }))
      .toBe('org_member_cap_reached');
  });

  it('names an org pool that cannot cover the reservation', () => {
    expect(orgComputeRefusalOf({ allowed: false, reason: 'out_of_credits' })).toBe('org_wallet_empty');
  });

  it('keeps the concurrency refusal its own reason — waiting clears it, a top-up does not', () => {
    expect(orgComputeRefusalOf({ allowed: false, reason: 'too_many_in_flight' })).toBe('concurrency_limit');
  });

  it('keeps the daily cap its own reason', () => {
    expect(orgComputeRefusalOf({ allowed: false, reason: 'daily_cap_exceeded' })).toBe('daily_cap_exceeded');
  });

  it('SEAT-9 (partial) names a LAPSED org apart from a paused pool: the org must reactivate billing, not resume a wallet', () => {
    expect(
      orgComputeRefusalOf({ allowed: false, reason: 'source_refused', refusal: { source: null, reason: 'source_paused', options: [] }, orgLapsed: true }),
    ).toBe('org_lapsed');
  });

  it('is null for an allowed gate', () => {
    expect(orgComputeRefusalOf({ allowed: true, reason: 'ok', holdId: 'h1' })).toBeNull();
  });
});

describe('ORG_COMPUTE_REFUSAL_MESSAGES', () => {
  it('tells the user which org wallet state stopped the run and who can fix it', () => {
    expect(ORG_COMPUTE_REFUSAL_MESSAGES.org_wallet_empty).toMatch(/organization/i);
    expect(ORG_COMPUTE_REFUSAL_MESSAGES.org_wallet_paused).toMatch(/paused/i);
    expect(ORG_COMPUTE_REFUSAL_MESSAGES.org_wallet_unavailable).toMatch(/organization/i);
    for (const message of Object.values(ORG_COMPUTE_REFUSAL_MESSAGES)) expect(message).toMatch(/Owner or Admin/);
    // Codex review: the member cap may be the DAILY one, so the message names both resets.
    expect(ORG_COMPUTE_REFUSAL_MESSAGES.org_member_cap_reached).toMatch(/daily allowance renews at midnight UTC/);
    expect(ORG_COMPUTE_REFUSAL_MESSAGES.org_member_cap_reached).toMatch(/monthly one with the organization's next billing period/);
  });

  it('SEAT-9 (partial) a lapsed org\'s compute refusal is the lapse message: drives readable, sandboxes paused until an Owner or Admin reactivates', () => {
    expect(ORG_COMPUTE_REFUSAL_MESSAGES.org_lapsed).toBe(ORG_LAPSED_MESSAGE);
  });

  it('isOrgComputeRefusal recognizes exactly the org wallet states, the lapse and the member cap', () => {
    expect(isOrgComputeRefusal('org_lapsed')).toBe(true);
    expect(isOrgComputeRefusal('org_member_cap_reached')).toBe(true);
    expect(isOrgComputeRefusal('org_wallet_empty')).toBe(true);
    expect(isOrgComputeRefusal('org_wallet_paused')).toBe(true);
    expect(isOrgComputeRefusal('org_wallet_unavailable')).toBe(true);
    expect(isOrgComputeRefusal('credit_exhausted')).toBe(false);
  });
});

describe('sameCharge', () => {
  const org = (orgId: string, userId: string) => ({ kind: 'org', orgId, userId }) as const;
  const user = (userId: string) => ({ kind: 'user', userId }) as const;

  it('WAL-9 (partial) two org charges are the same payer whoever they are recorded under, and differ when the org differs', () => {
    expect(sameCharge(org('o1', 'lead'), org('o1', 'member'))).toBe(true);
    expect(sameCharge(org('o1', 'lead'), org('o2', 'lead'))).toBe(false);
  });

  it('WAL-9 (partial) two personal charges are the same payer only for the same person', () => {
    expect(sameCharge(user('p1'), user('p1'))).toBe(true);
    expect(sameCharge(user('p1'), user('p2'))).toBe(false);
  });

  it('WAL-9 (partial) an org charge and a personal charge are never the same payer, in either order, even when the person is the one recorded', () => {
    expect(sameCharge(org('o1', 'p1'), user('p1'))).toBe(false);
    expect(sameCharge(user('p1'), org('o1', 'p1'))).toBe(false);
  });
});
