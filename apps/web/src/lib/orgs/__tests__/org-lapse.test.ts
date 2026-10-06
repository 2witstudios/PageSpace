import { describe, it, expect } from 'vitest';
import { DEFAULT_ORG_POLICIES, type OrgPolicies } from '@pagespace/lib/organizations/policies-core';
import { orgIsLapsed, policyChangeAllowed, roleChangeAllowed, seatCapChangeAllowed, visibilityChangeAllowed } from '../org-lapse';

const policies: OrgPolicies = { ...DEFAULT_ORG_POLICIES, guests: 'approve', publicShareLinks: false, seatAllowanceCents: 150, providerAllowlist: ['anthropic', 'openai'] };

describe('orgIsLapsed', () => {
  it('SEAT-9 (partial): the reactivate and read_only notices mean lapsed; payment_failed and none do not', () => {
    expect(orgIsLapsed({ kind: 'reactivate', reason: 'canceled', canManageBilling: true })).toBe(true);
    expect(orgIsLapsed({ kind: 'read_only', canManageBilling: false })).toBe(true);
    expect(orgIsLapsed({ kind: 'payment_failed', canManageBilling: true })).toBe(false);
    expect(orgIsLapsed(undefined)).toBe(false);
  });
});

describe('policyChangeAllowed', () => {
  it('anything goes while the org is paid', () => {
    expect(policyChangeAllowed(false, policies, { guests: 'on', publicShareLinks: true })).toBe(true);
  });

  it('SEAT-9 (partial) D-OW-33: while lapsed, restricting works and loosening is paused', () => {
    expect(policyChangeAllowed(true, policies, { guests: 'off' })).toBe(true);
    expect(policyChangeAllowed(true, policies, { guests: 'on' })).toBe(false);
    expect(policyChangeAllowed(true, policies, { publicShareLinks: true })).toBe(false);
    expect(policyChangeAllowed(true, policies, { publishWeb: false })).toBe(true);
    expect(policyChangeAllowed(true, policies, { seatAllowanceCents: 100 })).toBe(true);
    expect(policyChangeAllowed(true, policies, { seatAllowanceCents: 200 })).toBe(false);
    expect(policyChangeAllowed(true, policies, { providerAllowlist: ['anthropic'] })).toBe(true);
    expect(policyChangeAllowed(true, policies, { providerAllowlist: null })).toBe(false);
    expect(policyChangeAllowed(true, policies, { openDriveRoleFloor: 'edit' })).toBe(false);
  });
});

describe('seatCapChangeAllowed', () => {
  const seat = { dailyCapCents: 20, monthlyCapCents: null, monthlyLimitCents: 150 };
  it('SEAT-9 (partial) D-OW-33: while lapsed a cap may be lowered or added, never raised or removed', () => {
    expect(seatCapChangeAllowed(true, seat, { dailyCapCents: 10, monthlyCapCents: null }, 150)).toBe(true);
    expect(seatCapChangeAllowed(true, seat, { dailyCapCents: 20, monthlyCapCents: 100 }, 150)).toBe(true);
    expect(seatCapChangeAllowed(true, seat, { dailyCapCents: 50, monthlyCapCents: null }, 150)).toBe(false);
    expect(seatCapChangeAllowed(true, seat, { dailyCapCents: null, monthlyCapCents: null }, 150)).toBe(false);
    expect(seatCapChangeAllowed(true, seat, { dailyCapCents: 20, monthlyCapCents: 300 }, 150)).toBe(false);
  });

  it('anything goes while paid', () => {
    expect(seatCapChangeAllowed(false, seat, { dailyCapCents: null, monthlyCapCents: 900 }, 150)).toBe(true);
  });
});

describe('visibilityChangeAllowed and roleChangeAllowed', () => {
  it('SEAT-9 (partial) D-OW-33: while lapsed a drive may only be made less open, and a role only lowered; paid, anything goes', () => {
    expect(visibilityChangeAllowed(true, 'OPEN', 'RESTRICTED')).toBe(true);
    expect(visibilityChangeAllowed(true, 'RESTRICTED', 'PRIVATE')).toBe(true);
    expect(visibilityChangeAllowed(true, 'PRIVATE', 'RESTRICTED')).toBe(false);
    expect(visibilityChangeAllowed(true, 'RESTRICTED', 'OPEN')).toBe(false);
    expect(visibilityChangeAllowed(false, 'PRIVATE', 'OPEN')).toBe(true);
    expect(roleChangeAllowed(true, 'ADMIN', 'MEMBER')).toBe(true);
    expect(roleChangeAllowed(true, 'MEMBER', 'ADMIN')).toBe(false);
    expect(roleChangeAllowed(false, 'MEMBER', 'ADMIN')).toBe(true);
  });
});
