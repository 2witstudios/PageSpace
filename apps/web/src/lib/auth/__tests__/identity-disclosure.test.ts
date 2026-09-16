import { describe, it, expect } from 'vitest';
import { parseScopeList, type ScopeSet } from '@pagespace/lib/auth/oauth/scopes';
import { decideIdentityDisclosure, decidePrincipalIdentityDisclosure } from '../identity-disclosure';
import type { AuthResult } from '../index';

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

describe('decidePrincipalIdentityDisclosure (full disclosure is an explicit allow)', () => {
  const base = { userId: 'u', role: 'user' as const, tokenVersion: 0, adminRoleVersion: 0 };

  it('gives a session the full profile', () => {
    expect(decidePrincipalIdentityDisclosure({ ...base, tokenType: 'session', sessionId: 's' })).toBe('full');
  });

  it('defers an OAuth token to its consent', () => {
    const oauth = (raw: string, clientFirstParty: boolean): AuthResult => ({
      ...base, tokenType: 'oauth', tokenId: 't', scopes: scopes(raw), driveScopes: [], allowedDriveIds: [], clientFirstParty,
    });
    expect(decidePrincipalIdentityDisclosure(oauth('manage_keys', true))).toBe('full');
    expect(decidePrincipalIdentityDisclosure(oauth('profile', false))).toBe('profile');
    expect(decidePrincipalIdentityDisclosure(oauth('drive:abc123:member', false))).toBe('deny');
  });

  it('denies an mcp_ key, scoped or not, and a service result', () => {
    expect(decidePrincipalIdentityDisclosure({ ...base, tokenType: 'mcp', tokenId: 't', allowedDriveIds: [] })).toBe('deny');
    expect(decidePrincipalIdentityDisclosure({ ...base, tokenType: 'mcp', tokenId: 't', allowedDriveIds: ['d'] })).toBe('deny');
    expect(decidePrincipalIdentityDisclosure({ ...base, tokenType: 'service', service: 'agent-dispatch', allowedDriveIds: [] })).toBe('deny');
  });
});
