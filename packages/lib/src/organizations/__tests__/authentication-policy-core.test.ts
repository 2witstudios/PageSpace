import { describe, expect, it } from 'vitest';
import {
  countSignInBlocked,
  decideOrgAuthentication,
  decideReauthentication,
  decideSignInPolicyChange,
  normalizeMaximumSessionAgeMinutes,
  signInPolicyLoosened,
  signInPolicyTightened,
  type OrgAuthenticationPolicy,
} from '../authentication-policy-core';

const nowMs = Date.parse('2026-10-12T12:00:00Z');
const unrestricted: OrgAuthenticationPolicy = { requireStrongSignIn: false, maximumSessionAgeMinutes: null };
const strong = { authenticatedAtMs: nowMs - 1000, assurance: 'user_verified_passkey' as const };
describe('organization authentication policy decision', () => {
  it('SEC-2 (partial) unset restrictions preserve access without credential evidence', () => {
    expect(decideOrgAuthentication({ policy: unrestricted, authentication: null, nowMs })).toEqual({ allowed: true });
  });
  it('SEC-2 (partial) a verified passkey satisfies strong sign-in', () => {
    expect(decideOrgAuthentication({ policy: { ...unrestricted, requireStrongSignIn: true }, authentication: strong, nowMs })).toEqual({ allowed: true });
  });
  it.each([null, { authenticatedAtMs: nowMs, assurance: 'single_factor' as const }])('SEC-2 (partial) a missing or email-only proof requires strong reauthentication', (authentication) => {
    expect(decideOrgAuthentication({ policy: { ...unrestricted, requireStrongSignIn: true }, authentication, nowMs })).toEqual({ allowed: false, code: 'org_strong_sign_in_required' });
  });
  it('SEC-3 (partial) email authentication satisfies freshness when strong sign-in is not required', () => {
    expect(decideOrgAuthentication({ policy: { ...unrestricted, maximumSessionAgeMinutes: 15 }, authentication: { ...strong, assurance: 'single_factor' }, nowMs })).toEqual({ allowed: true });
  });
  it.each([15 * 60_000, 15 * 60_000 + 1])('SEC-3 (partial) the maximum age expires at its exact boundary (%d ms)', (age) => {
    expect(decideOrgAuthentication({ policy: { ...unrestricted, maximumSessionAgeMinutes: 15 }, authentication: { ...strong, authenticatedAtMs: nowMs - age }, nowMs })).toEqual({ allowed: false, code: 'org_reauthentication_required' });
  });
  it('SEC-3 (partial) immediately before expiry the original authentication remains usable', () => {
    expect(decideOrgAuthentication({ policy: { ...unrestricted, maximumSessionAgeMinutes: 15 }, authentication: { ...strong, authenticatedAtMs: nowMs - 15 * 60_000 + 1 }, nowMs })).toEqual({ allowed: true });
  });
  it.each([null, { ...strong, authenticatedAtMs: NaN }, { ...strong, authenticatedAtMs: nowMs + 1 }, { ...strong, authenticatedAtMs: -1 }])('SEC-3 (partial) malformed, missing and future authentication evidence fails closed', (authentication) => {
    expect(decideOrgAuthentication({ policy: { ...unrestricted, maximumSessionAgeMinutes: 60 }, authentication, nowMs })).toEqual({ allowed: false, code: 'org_reauthentication_required' });
  });
  it('SEC-2 (partial) SEC-3 (partial) fresh single-factor evidence does not satisfy both policies', () => {
    expect(decideOrgAuthentication({ policy: { requireStrongSignIn: true, maximumSessionAgeMinutes: 60 }, authentication: { ...strong, assurance: 'single_factor' }, nowMs })).toEqual({ allowed: false, code: 'org_strong_sign_in_required' });
  });
  it.each([0, -1, 14, 43201, 15.5, NaN])('SEC-3 (partial) a corrupt configured maximum age denies access (%d)', (maximumSessionAgeMinutes) => {
    expect(decideOrgAuthentication({ policy: { ...unrestricted, maximumSessionAgeMinutes }, authentication: strong, nowMs })).toEqual({ allowed: false, code: 'org_reauthentication_required' });
  });
  it('SEC-3 (partial) disabling restrictions restores access without changing the credential', () => {
    const authentication = { ...strong, authenticatedAtMs: nowMs - 31 * 86400_000 };
    expect(decideOrgAuthentication({ policy: { ...unrestricted, maximumSessionAgeMinutes: 43200 }, authentication, nowMs }).allowed).toBe(false);
    expect(decideOrgAuthentication({ policy: unrestricted, authentication, nowMs }).allowed).toBe(true);
  });
  it.each([null, 15, 43200])('accepts off and bounded whole-minute policy values (%s)', (value) => {
    expect(normalizeMaximumSessionAgeMinutes(value)).toBe(value);
  });
  it.each([undefined, '15', 0, 14, 43201, 15.1, Infinity, NaN])('rejects invalid policy values (%s)', (value) => {
    expect(normalizeMaximumSessionAgeMinutes(value)).toBeUndefined();
  });
});

describe('changing a sign-in policy (D-OW-45)', () => {
  const single = { authenticatedAtMs: nowMs - 1000, assurance: 'single_factor' as const };
  const strongOn: OrgAuthenticationPolicy = { requireStrongSignIn: true, maximumSessionAgeMinutes: null };
  const hourly: OrgAuthenticationPolicy = { requireStrongSignIn: false, maximumSessionAgeMinutes: 60 };

  it('SEC-2 (partial) turning strong sign-in off needs a credential that satisfies it now', () => {
    expect(decideSignInPolicyChange({ before: strongOn, after: unrestricted, authentication: single, nowMs })).toEqual({ allowed: false, code: 'org_strong_sign_in_required' });
    expect(decideSignInPolicyChange({ before: strongOn, after: unrestricted, authentication: null, nowMs })).toEqual({ allowed: false, code: 'org_strong_sign_in_required' });
    expect(decideSignInPolicyChange({ before: strongOn, after: unrestricted, authentication: strong, nowMs })).toEqual({ allowed: true });
  });
  it.each([null, 120])('SEC-3 (partial) raising or removing the maximum age (%s) needs a credential fresher than the age in force', (maximumSessionAgeMinutes) => {
    const after = { ...hourly, maximumSessionAgeMinutes };
    const stale = { ...single, authenticatedAtMs: nowMs - 61 * 60_000 };
    expect(decideSignInPolicyChange({ before: hourly, after, authentication: stale, nowMs })).toEqual({ allowed: false, code: 'org_reauthentication_required' });
    expect(decideSignInPolicyChange({ before: hourly, after, authentication: single, nowMs })).toEqual({ allowed: true });
  });
  it.each([
    [unrestricted, strongOn],
    [unrestricted, hourly],
    [hourly, { ...hourly, maximumSessionAgeMinutes: 15 }],
    [strongOn, strongOn],
  ])('SEC-2 (partial) SEC-3 (partial) tightening or keeping a sign-in policy is always allowed, from any credential', (before, after) => {
    expect(decideSignInPolicyChange({ before, after, authentication: null, nowMs })).toEqual({ allowed: true });
  });
  it('SEC-3 (partial) a damaged stored age is judged as the strictest valid age, so a fresh sign-in can repair it', () => {
    const damaged = { ...unrestricted, maximumSessionAgeMinutes: 0 };
    expect(decideSignInPolicyChange({ before: damaged, after: hourly, authentication: single, nowMs })).toEqual({ allowed: true });
    expect(decideSignInPolicyChange({ before: damaged, after: hourly, authentication: { ...single, authenticatedAtMs: nowMs - 15 * 60_000 }, nowMs })).toEqual({ allowed: false, code: 'org_reauthentication_required' });
  });
  it('signInPolicyLoosened names only a change that admits more credentials', () => {
    expect(signInPolicyLoosened(strongOn, unrestricted)).toBe(true);
    expect(signInPolicyLoosened(hourly, { ...hourly, maximumSessionAgeMinutes: 61 })).toBe(true);
    expect(signInPolicyLoosened(hourly, unrestricted)).toBe(true);
    expect(signInPolicyLoosened(unrestricted, hourly)).toBe(false);
    expect(signInPolicyLoosened(hourly, hourly)).toBe(false);
  });
  it('signInPolicyTightened names only a change that admits fewer credentials', () => {
    expect(signInPolicyTightened(unrestricted, strongOn)).toBe(true);
    expect(signInPolicyTightened(hourly, { ...hourly, maximumSessionAgeMinutes: 30 })).toBe(true);
    expect(signInPolicyTightened(hourly, hourly)).toBe(false);
    expect(signInPolicyTightened(strongOn, unrestricted)).toBe(false);
  });
});

describe('re-authenticating the current credential (D-OW-45)', () => {
  const fresh = { authenticatedAtMs: nowMs, assurance: 'single_factor' as const };
  it('SEC-3 (partial) a fresh ceremony replaces older evidence of the same or higher strength', () => {
    expect(decideReauthentication({ current: null, fresh })).toEqual({ ok: true, authentication: fresh });
    expect(decideReauthentication({ current: { ...fresh, authenticatedAtMs: 1 }, fresh })).toEqual({ ok: true, authentication: fresh });
    const uv = { ...fresh, assurance: 'user_verified_passkey' as const };
    expect(decideReauthentication({ current: fresh, fresh: uv })).toEqual({ ok: true, authentication: uv });
  });
  it('SEC-2 (partial) a weaker ceremony never downgrades a passkey-verified credential', () => {
    expect(decideReauthentication({ current: strong, fresh })).toEqual({ ok: false, reason: 'weaker_than_current' });
  });
});

describe('counting who a sign-in policy blocks (POL-1, D-OW-45)', () => {
  const single = { authenticatedAtMs: nowMs - 1000, assurance: 'single_factor' as const };
  it('POL-1 (partial) counts credentials that fail and members left with no credential that passes', () => {
    const rows = [
      { userId: 'a', authentication: single },
      { userId: 'a', authentication: strong },
      { userId: 'b', authentication: single },
      { userId: 'b', authentication: null },
      { userId: 'c', authentication: null },
    ];
    expect(countSignInBlocked({ policy: { requireStrongSignIn: true, maximumSessionAgeMinutes: null }, credentials: rows, nowMs })).toEqual({ members: 2, credentials: 4 });
    expect(countSignInBlocked({ policy: unrestricted, credentials: rows, nowMs })).toEqual({ members: 0, credentials: 0 });
    expect(countSignInBlocked({ policy: unrestricted, credentials: [], nowMs })).toEqual({ members: 0, credentials: 0 });
  });
});
