import { describe, expect, it } from 'vitest';
import { decideOrgAuthentication } from '../authentication-policy-core';
import { parseOrgPolicies, policyChangeOnlyRestricts, validateOrgPoliciesPatch } from '../policies-core';

describe('organization authentication policy storage', () => {
  it('SEC-2 (partial) leaves sign-in unrestricted until the organization enables a requirement', () => {
    const policy = parseOrgPolicies({});
    expect(decideOrgAuthentication({ policy, authentication: null, nowMs: 1000 })).toEqual({ allowed: true });
  });

  it('SEC-2 (partial) stores strong sign-in and rejects malformed values', () => {
    expect(validateOrgPoliciesPatch({ requireStrongSignIn: true })).toEqual({ ok: true, patch: { requireStrongSignIn: true } });
    expect(validateOrgPoliciesPatch({ requireStrongSignIn: 'true' }).ok).toBe(false);
    expect(decideOrgAuthentication({ policy: parseOrgPolicies({ requireStrongSignIn: 'false' }), authentication: null, nowMs: 1000 })).toEqual({ allowed: false, code: 'org_strong_sign_in_required' });
  });

  it.each([15, 60, 43_200, null])('SEC-3 (partial) accepts a bounded age or disabled limit (%s)', (maximumSessionAgeMinutes) => {
    expect(validateOrgPoliciesPatch({ maximumSessionAgeMinutes })).toEqual({ ok: true, patch: { maximumSessionAgeMinutes } });
  });

  it.each([0, 14, 43_201, 15.5, '60', true])('SEC-3 (partial) rejects invalid limits and denies access if corrupt storage contains %s', (maximumSessionAgeMinutes) => {
    expect(validateOrgPoliciesPatch({ maximumSessionAgeMinutes }).ok).toBe(false);
    expect(decideOrgAuthentication({ policy: parseOrgPolicies({ maximumSessionAgeMinutes }), authentication: { authenticatedAtMs: 1000, assurance: 'user_verified_passkey' }, nowMs: 1000 })).toEqual({ allowed: false, code: 'org_reauthentication_required' });
  });

  it('SEC-2 (partial) permits enabling strong sign-in while lapsed, but refuses weakening it', () => {
    const loose = parseOrgPolicies({ requireStrongSignIn: false });
    const strict = parseOrgPolicies({ requireStrongSignIn: true });
    expect(policyChangeOnlyRestricts(loose, strict)).toBe(true);
    expect(policyChangeOnlyRestricts(strict, loose)).toBe(false);
  });

  it('SEC-3 (partial) permits shortening session age while lapsed, but refuses extending or disabling it', () => {
    const unlimited = parseOrgPolicies({ maximumSessionAgeMinutes: null });
    const hour = parseOrgPolicies({ maximumSessionAgeMinutes: 60 });
    const short = parseOrgPolicies({ maximumSessionAgeMinutes: 15 });
    expect(policyChangeOnlyRestricts(unlimited, hour)).toBe(true);
    expect(policyChangeOnlyRestricts(hour, short)).toBe(true);
    expect(policyChangeOnlyRestricts(short, hour)).toBe(false);
    expect(policyChangeOnlyRestricts(hour, unlimited)).toBe(false);
  });
});
