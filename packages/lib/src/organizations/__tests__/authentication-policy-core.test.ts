import { describe, expect, it } from 'vitest';
import { decideOrgAuthentication, normalizeMaximumSessionAgeMinutes, type OrgAuthenticationPolicy } from '../authentication-policy-core';

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
