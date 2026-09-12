/**
 * `profile` — the identity-only scope (ADR 0004 Decision 4; epic
 * `yv08hib74nrtmksdzxmf5nkw` architecture decision 4).
 *
 * `profile` grants exactly one thing: the identity fields `/api/auth/me`
 * returns (name, email, avatar). It carries ZERO content access, so it is the
 * only scope in the grammar that can be approved without the consent step-up
 * ceremony (`requiresStepUp`, `./step-up-boundary`). Every assertion below is
 * a fail-closed rule: `profile` never widens, never satisfies a drive or
 * account request, and never combines with a scope whose principal shape
 * contradicts "identity, nothing else".
 */
import { describe, it, expect } from 'vitest';
import {
  parseScopeList,
  formatScopeSet,
  isPureDriveGrant,
  isScopeSubset,
  type ScopeSet,
} from '../scopes';
import { describeScopeForConsent } from '../consent';
import { describeGrantScopes } from '../grant-scope-summary';
import { buildServerMetadata } from '../metadata';

function emptySet(overrides: Partial<ScopeSet> = {}): ScopeSet {
  return {
    account: false,
    offlineAccess: false,
    drives: new Map(),
    manageKeys: false,
    allDrives: false,
    profile: false,
    updateKeyId: null,
    activateKeyId: null,
    newKeyName: null,
    ...overrides,
  };
}

const memberDrive = (driveId: string): ScopeSet['drives'] =>
  new Map([[driveId, { kind: 'drive' as const, driveId, role: { kind: 'member' as const } }]]);

describe('parseScopeList — profile', () => {
  it('parses "profile" alone into an identity-only set: no drives, no account', () => {
    const result = parseScopeList('profile');
    expect(result).toEqual({ ok: true, scopes: emptySet({ profile: true }) });
  });

  it('rejects "profile account" with profile_account_conflict (one principal shape or the other, never both)', () => {
    expect(parseScopeList('profile account')).toEqual({
      ok: false,
      error: { code: 'profile_account_conflict' },
    });
    // Order-independent: the conflict is a property of the set, not the string.
    expect(parseScopeList('account profile')).toEqual({
      ok: false,
      error: { code: 'profile_account_conflict' },
    });
  });

  it('parses "profile drive:<id>:member offline_access" — sign in AND act in one drive', () => {
    const result = parseScopeList('profile drive:abc123:member offline_access');
    expect(result).toEqual({
      ok: true,
      scopes: emptySet({ profile: true, offlineAccess: true, drives: memberDrive('abc123') }),
    });
  });

  it('accepts "profile offline_access" — profile is its own principal shape, so rule 10 is satisfied', () => {
    const result = parseScopeList('profile offline_access');
    expect(result).toEqual({ ok: true, scopes: emptySet({ profile: true, offlineAccess: true }) });
  });

  it('still rejects "offline_access" alone (rule 10 is extended by profile, not weakened)', () => {
    expect(parseScopeList('offline_access')).toEqual({
      ok: false,
      error: { code: 'offline_access_alone' },
    });
  });

  it('rejects "profile manage_keys" with the existing manage_keys_conflict shape (fail closed)', () => {
    expect(parseScopeList('profile manage_keys')).toEqual({
      ok: false,
      error: { code: 'manage_keys_conflict' },
    });
  });

  it('rejects "profile all_drives" with the existing all_drives_conflict shape (fail closed)', () => {
    expect(parseScopeList('profile all_drives')).toEqual({
      ok: false,
      error: { code: 'all_drives_conflict' },
    });
  });

  it('rejects profile alongside activate_key (activate_key must be the only scope)', () => {
    expect(parseScopeList('profile activate_key:tok123')).toEqual({
      ok: false,
      error: { code: 'activate_key_not_alone' },
    });
  });

  it('rejects profile alongside update_key (nothing but drives attaches to an mcp key)', () => {
    expect(parseScopeList('profile update_key:tok123 drive:abc123')).toEqual({
      ok: false,
      error: { code: 'update_key_conflict' },
    });
  });
});

describe('formatScopeSet — profile', () => {
  it('emits profile in canonical order: after offline_access, before drive:*', () => {
    const scopes = emptySet({ profile: true, offlineAccess: true, drives: memberDrive('abc123') });
    expect(formatScopeSet(scopes)).toBe('offline_access profile drive:abc123:member');
  });

  it('round-trips (rule 9): parse ∘ format is the identity on a profile-bearing set', () => {
    const scopes = emptySet({ profile: true, offlineAccess: true, drives: memberDrive('abc123') });
    const reparsed = parseScopeList(formatScopeSet(scopes));
    expect(reparsed).toEqual({ ok: true, scopes });
  });

  it('round-trips profile alone', () => {
    const reparsed = parseScopeList(formatScopeSet(emptySet({ profile: true })));
    expect(reparsed).toEqual({ ok: true, scopes: emptySet({ profile: true }) });
  });
});

describe('isScopeSubset — profile', () => {
  it('profile ⊄ a drive-only grant', () => {
    expect(isScopeSubset(emptySet({ profile: true }), emptySet({ drives: memberDrive('abc123') }))).toBe(false);
  });

  it('profile ⊄ account (no cross-shape narrowing; account does not imply identity consent)', () => {
    expect(isScopeSubset(emptySet({ profile: true }), emptySet({ account: true }))).toBe(false);
  });

  it('profile ⊄ all_drives', () => {
    expect(isScopeSubset(emptySet({ profile: true }), emptySet({ allDrives: true }))).toBe(false);
  });

  it('profile ⊆ profile, and profile ⊆ (profile + drive)', () => {
    expect(isScopeSubset(emptySet({ profile: true }), emptySet({ profile: true }))).toBe(true);
    expect(
      isScopeSubset(emptySet({ profile: true }), emptySet({ profile: true, drives: memberDrive('abc123') })),
    ).toBe(true);
  });

  it('a profile-bearing grant does NOT make a drive:* request a subset', () => {
    expect(isScopeSubset(emptySet({ drives: memberDrive('abc123') }), emptySet({ profile: true }))).toBe(false);
  });

  it('narrowing still works inside a profile-bearing grant: the drive must match exactly', () => {
    const granted = emptySet({ profile: true, drives: memberDrive('abc123') });
    expect(isScopeSubset(emptySet({ profile: true, drives: memberDrive('abc123') }), granted)).toBe(true);
    expect(isScopeSubset(emptySet({ profile: true, drives: memberDrive('other1') }), granted)).toBe(false);
  });
});

describe('isPureDriveGrant — profile', () => {
  it('a profile-bearing drive grant is NOT a pure drive grant (an mcp_tokens row cannot carry identity)', () => {
    expect(isPureDriveGrant(emptySet({ profile: true, drives: memberDrive('abc123') }))).toBe(false);
    expect(isPureDriveGrant(emptySet({ drives: memberDrive('abc123') }))).toBe(true);
  });
});

describe('describeScopeForConsent — profile', () => {
  const text = () => describeScopeForConsent({ kind: 'profile' }, {});

  it('names exactly the identity fields it releases', () => {
    expect(text()).toMatch(/name/i);
    expect(text()).toMatch(/email/i);
    expect(text()).toMatch(/avatar/i);
  });

  it('states plainly that it reaches no drive and no content', () => {
    expect(text()).toMatch(/no access to any drive or content/i);
  });
});

describe('describeGrantScopes — profile', () => {
  const resolvers = { driveNamesById: new Map<string, string>(), roleNamesById: new Map<string, { name: string; description: string | null }>() };

  it('lists the profile narration for a stored profile grant', () => {
    const lines = describeGrantScopes(['profile'], resolvers);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/no access to any drive or content/i);
  });

  it('lists profile alongside the drive it is combined with', () => {
    const lines = describeGrantScopes(['profile', 'drive:abc123:member'], resolvers);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/no access to any drive or content/i);
    expect(lines[1]).toMatch(/member access/i);
  });
});

describe('buildServerMetadata — profile', () => {
  it('advertises profile in scopes_supported (RFC 8414 discovery)', () => {
    const metadata = buildServerMetadata({ issuer: 'https://pagespace.ai' });
    expect(metadata.scopes_supported).toContain('profile');
  });
});
