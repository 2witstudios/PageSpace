import { describe, expect, it } from 'vitest';
import { describeOrgSignInRequirement, readOrgSignInDenial, strongestRequirement } from '../org-sign-in-denial';

describe('reading an org sign-in denial from an API error (D-OW-45)', () => {
  it.each([403, 401])('SEC-2 (partial) a %d carrying a sign-in code is a denial, with the org when named', (status) => {
    expect(readOrgSignInDenial(status, { error: 'x', code: 'org_strong_sign_in_required', orgId: 'org_nw' }))
      .toEqual({ code: 'org_strong_sign_in_required', orgId: 'org_nw' });
    expect(readOrgSignInDenial(status, { code: 'org_reauthentication_required' }))
      .toEqual({ code: 'org_reauthentication_required', orgId: null });
  });

  it.each<[number, unknown]>([
    [403, { code: 'insufficient_role' }],
    [403, { code: 'CSRF_TOKEN_INVALID' }],
    [200, { code: 'org_strong_sign_in_required' }],
    [500, { code: 'org_reauthentication_required' }],
    [403, null],
    [403, 'org_strong_sign_in_required'],
  ])('anything else is not (%d %o)', (status, body) => {
    expect(readOrgSignInDenial(status, body)).toBeNull();
  });

  it('a non-string orgId is dropped, never trusted', () => {
    expect(readOrgSignInDenial(403, { code: 'org_strong_sign_in_required', orgId: 42 })).toEqual({ code: 'org_strong_sign_in_required', orgId: null });
  });
});

describe('what to ask the person for (D-OW-45)', () => {
  it('SEC-2 (partial) strong sign-in wins over a fresh sign-in: a passkey satisfies both', () => {
    expect(strongestRequirement(['org_reauthentication_required', 'org_strong_sign_in_required'])).toBe('org_strong_sign_in_required');
    expect(strongestRequirement(['org_reauthentication_required'])).toBe('org_reauthentication_required');
    expect(strongestRequirement([])).toBeNull();
  });

  it('names the org and what it requires', () => {
    expect(describeOrgSignInRequirement('org_strong_sign_in_required', 'Northwind')).toBe('Northwind requires strong sign-in (passkey).');
    expect(describeOrgSignInRequirement('org_reauthentication_required', 'Northwind')).toBe('Northwind asks you to sign in again: your sign-in is older than it allows.');
    expect(describeOrgSignInRequirement('org_reauthentication_required', null)).toBe('An organization asks you to sign in again: your sign-in is older than it allows.');
  });
});
