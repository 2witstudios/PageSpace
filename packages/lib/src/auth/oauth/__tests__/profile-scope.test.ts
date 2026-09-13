/**
 * `profile` — the identity-only scope (ADR 0004 Decision 4; epic
 * `yv08hib74nrtmksdzxmf5nkw` architecture decision 4).
 *
 * `profile` is defined to grant exactly one thing: the identity fields
 * `/api/auth/me` returns (name, email, avatar). Because it carries no content
 * access, it is the only scope in the grammar that can be approved without the
 * consent step-up ceremony (`requiresStepUp`, `./step-up-boundary`).
 *
 * Scope of these tests: the GRAMMAR — that `profile` never widens, never
 * satisfies a drive or account request, and never combines with a scope whose
 * principal shape contradicts "identity, nothing else". The RESOLUTION half —
 * that a profile-only principal is denied by `checkMCPDriveScope` /
 * `getAllowedDriveIds` the way a `manage_keys` principal already is — is
 * Phase 1's `isProfileOnly` sentinel and is deliberately not asserted here.
 * See ADR 0004 Decision 4, "Phase 1 obligations". Nothing below should be read
 * as evidence that content access is enforced today; it is not.
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

  it('rejects `name:` on a profile-bearing drive grant — the consent screen would promise a key that nothing mints (rule 13)', () => {
    // Reported by Codex on PR #2612. `isPureDriveGrant` excludes profile-bearing
    // sets, so `validateAuthorizeRequest`'s mint-name guard (which fires only for
    // `isPureDriveGrant || isAllDrivesGrant`) never sees this shape, and exchange
    // falls through to `not_a_key_grant`. The user would approve "create a key
    // named ci" and receive an OAuth pair instead. `profile` therefore joins
    // `update_key`/`activate_key` in rule 13's exclusion.
    expect(parseScopeList('profile drive:abc123 name:ci')).toEqual({
      ok: false,
      error: { code: 'name_without_mint_grant' },
    });
    expect(parseScopeList('profile drive:abc123:member offline_access name:ci')).toEqual({
      ok: false,
      error: { code: 'name_without_mint_grant' },
    });
    // …and the same set without `name:` still parses, so the rule rejects the
    // promise, not the grant.
    expect(parseScopeList('profile drive:abc123').ok).toBe(true);
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
  it('names exactly the identity fields it releases', () => {
    const text = describeScopeForConsent({ kind: 'profile' }, {});
    expect(text).toMatch(/name/i);
    expect(text).toMatch(/email/i);
    expect(text).toMatch(/avatar/i);
  });

  it('states plainly that it reaches no drive and no content when the caller affirms profile is the whole grant', () => {
    expect(describeScopeForConsent({ kind: 'profile' }, { profileIsSoleAccess: true })).toMatch(
      /no access to any drive or content/i,
    );
  });

  it('does NOT make that absolute claim by default — a per-scope formatter cannot know the rest of the set', () => {
    // The claim is about the SET, not about this scope. Emitting it
    // unconditionally made `profile drive:abc123` render "No access to any
    // drive or content" immediately above "Act as you in Acme Drive".
    // Defaulting to the weaker sentence means a caller that forgets the flag
    // gets something true and less informative, never something false.
    const text = describeScopeForConsent({ kind: 'profile' }, {});
    expect(text).toMatch(/name/i);
    expect(text).not.toMatch(/no access to any drive/i);
  });
});

describe('describeGrantScopes — profile', () => {
  const resolvers = { driveNamesById: new Map<string, string>(), roleNamesById: new Map<string, { name: string; description: string | null }>() };

  it('lists the profile narration for a stored profile grant, with the absolute claim, because it is true there', () => {
    const lines = describeGrantScopes(['profile'], resolvers);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/no access to any drive or content/i);
  });

  it('keeps the absolute claim for `profile offline_access` — a refresh credential is not drive access', () => {
    const lines = describeGrantScopes(['profile', 'offline_access'], resolvers);
    expect(lines[0]).toMatch(/no access to any drive or content/i);
  });

  it('DROPS the absolute claim when the same grant also carries a drive', () => {
    // Regression: this rendered "No access to any drive or content." directly
    // above "Act as you in Acme Drive …" on /api/account/oauth-grants, which is
    // a live surface. A user skimming reads the reassuring absolute.
    const lines = describeGrantScopes(['profile', 'drive:abc123:member'], resolvers);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/name/i);
    expect(lines[0]).not.toMatch(/no access to any drive/i);
    expect(lines[1]).toMatch(/member access/i);
  });

  it('no line in a profile+drive grant claims the grant reaches no drive', () => {
    const lines = describeGrantScopes(['profile', 'drive:abc123'], resolvers);
    // The length assertion is what stops this from proving nothing: a bare
    // `.some(...) === false` also holds for an empty array, so a
    // `describeGrantScopes` that returned `[]` unconditionally would pass it.
    // Verified by making it do exactly that — this test went green until the
    // line below was added.
    expect(lines).toHaveLength(2);
    expect(lines.some((line) => /no access to any drive or content/i.test(line))).toBe(false);
  });
});

describe('buildServerMetadata — profile', () => {
  it('advertises profile in scopes_supported (RFC 8414 discovery)', () => {
    const metadata = buildServerMetadata({ issuer: 'https://pagespace.ai' });
    expect(metadata.scopes_supported).toContain('profile');
  });
});
