/**
 * The consent step-up boundary (ADR 0004 Decision 6; epic
 * `yv08hib74nrtmksdzxmf5nkw` architecture decision 6).
 *
 * One pure predicate decides whether approving a grant requires the
 * second-factor ceremony. It is the only place that answer is computed, so the
 * screen that offers the ceremony and the server that demands it cannot drift
 * (the failure mode `isCredentialEscalatingGrant` was written to prevent, one
 * layer down). Fail closed: everything that reaches content or mints/re-scopes
 * a credential steps up; only identity-alone does not.
 */
import { describe, it, expect } from 'vitest';
import { requiresStepUp } from '../step-up-boundary';
import { parseScopeList, type ScopeSet } from '../scopes';

function parse(raw: string): ScopeSet {
  const result = parseScopeList(raw);
  if (!result.ok) throw new Error(`fixture scope string did not parse: ${raw}`);
  return result.scopes;
}

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

describe('requiresStepUp — steps up for everything that reaches content or keys', () => {
  it.each([
    ['a single inherit drive', 'drive:abc123 name:ci'],
    ['a member drive', 'drive:abc123:member name:ci'],
    ['an admin drive', 'drive:abc123:admin name:ci'],
    ['a custom-role drive', 'drive:abc123:role:role01 name:ci'],
    ['two drives', 'drive:abc123 drive:def456 name:ci'],
    ['account', 'account'],
    ['account offline_access', 'account offline_access'],
    ['all_drives', 'all_drives name:ci'],
    ['manage_keys', 'manage_keys'],
    ['manage_keys offline_access', 'manage_keys offline_access'],
    ['update_key with a drive', 'update_key:tok123 drive:abc123'],
    ['activate_key alone', 'activate_key:tok123'],
    ['profile alongside a drive (US8 stops at identity-only)', 'profile drive:abc123:member'],
    ['profile alongside a drive, refreshable', 'profile drive:abc123:member offline_access'],
  ])('requires step-up for %s', (_label, raw) => {
    expect(requiresStepUp(parse(raw))).toBe(true);
  });
});

describe('requiresStepUp — identity alone does not', () => {
  it('is false for `profile`', () => {
    expect(requiresStepUp(parse('profile'))).toBe(false);
  });

  it('is false for `profile offline_access` — a refresh credential for identity is still only identity', () => {
    expect(requiresStepUp(parse('profile offline_access'))).toBe(false);
  });
});

describe('requiresStepUp — each field is load-bearing on its own', () => {
  it.each([
    ['drives', emptySet({ drives: new Map([['abc123', { kind: 'drive' as const, driveId: 'abc123', role: { kind: 'inherit' as const } }]]) })],
    ['allDrives', emptySet({ allDrives: true })],
    ['account', emptySet({ account: true })],
    ['manageKeys', emptySet({ manageKeys: true })],
    ['updateKeyId', emptySet({ updateKeyId: 'tok123' })],
    ['activateKeyId', emptySet({ activateKeyId: 'tok123' })],
  ])('%s alone flips the decision to true', (_label, scopes) => {
    expect(requiresStepUp(scopes)).toBe(true);
  });

  it.each([
    ['an empty set', emptySet()],
    ['profile', emptySet({ profile: true })],
    ['offlineAccess', emptySet({ offlineAccess: true })],
    ['newKeyName with nothing to name', emptySet({ newKeyName: 'ci' })],
  ])('%s alone does not', (_label, scopes) => {
    expect(requiresStepUp(scopes)).toBe(false);
  });
});

describe('requiresStepUp — total', () => {
  it('never throws on any parseable scope string', () => {
    for (const raw of ['profile', 'account', 'manage_keys', 'all_drives name:ci', 'drive:abc123 name:ci', 'activate_key:tok123']) {
      expect(() => requiresStepUp(parse(raw))).not.toThrow();
    }
  });

  it('returns a boolean, never a truthy value', () => {
    expect(requiresStepUp(emptySet({ updateKeyId: 'tok123' }))).toStrictEqual(true);
    expect(requiresStepUp(emptySet({ profile: true }))).toStrictEqual(false);
  });
});
