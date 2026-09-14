import { describe, it, expect } from 'vitest';
import { parseScopeList, type ScopeSet } from '@pagespace/lib/auth/oauth/scopes';
import { decideIdentityDisclosure } from '../identity-disclosure';

const scopes = (raw: string): ScopeSet => {
  const parsed = parseScopeList(raw);
  if (!parsed.ok) throw new Error(`fixture did not parse: ${raw}`);
  return parsed.scopes;
};

describe('decideIdentityDisclosure (what /api/auth/me may tell an OAuth client)', () => {
  it('gives a first-party client the full profile, whatever it was granted — pagespace login/whoami', () => {
    expect(decideIdentityDisclosure({ clientFirstParty: true, scopes: scopes('manage_keys offline_access') })).toBe('full');
    expect(decideIdentityDisclosure({ clientFirstParty: true, scopes: scopes('drive:abc123:member name:k') })).toBe('full');
  });

  it('gives an account grant the full profile — it already IS the whole user', () => {
    expect(decideIdentityDisclosure({ clientFirstParty: false, scopes: scopes('account') })).toBe('full');
  });

  it('gives a third-party client exactly what profile consent narrates, only when profile was granted', () => {
    expect(decideIdentityDisclosure({ clientFirstParty: false, scopes: scopes('profile') })).toBe('profile');
    expect(decideIdentityDisclosure({ clientFirstParty: false, scopes: scopes('profile drive:abc123:member offline_access') })).toBe('profile');
  });

  it('denies a third-party client identity the consent screen never named', () => {
    expect(decideIdentityDisclosure({ clientFirstParty: false, scopes: scopes('drive:abc123:member') })).toBe('deny');
    expect(decideIdentityDisclosure({ clientFirstParty: false, scopes: scopes('drive:abc123:member offline_access') })).toBe('deny');
  });

  it('fails closed when first-party status is anything but true', () => {
    const unknownClient = { clientFirstParty: undefined as unknown as boolean, scopes: scopes('manage_keys offline_access') };
    expect(decideIdentityDisclosure(unknownClient)).toBe('deny');
  });
});
