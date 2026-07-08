import { describe, it, expect } from 'vitest';
import {
  parseScopeList,
  formatScopeSet,
  isAllDrivesGrant,
  isKeyActivationGrant,
  isKeyUpdateGrant,
  isPureDriveGrant,
  isScopeSubset,
  scopeSetToDriveScopes,
  checkGrantAuthority,
  type ScopeSet,
} from '../scopes';

function drives(...entries: Array<[string, ScopeSet['drives'] extends ReadonlyMap<string, infer V> ? V : never]>): ScopeSet['drives'] {
  return new Map(entries);
}

function emptySet(overrides: Partial<ScopeSet> = {}): ScopeSet {
  return {
    account: false,
    offlineAccess: false,
    drives: new Map(),
    manageKeys: false,
    allDrives: false,
    updateKeyId: null,
    activateKeyId: null,
    ...overrides,
  };
}

describe('parseScopeList', () => {
  describe('grammar productions (ADR 0002 Decision 1)', () => {
    it('parses "account" alone', () => {
      const result = parseScopeList('account');
      expect(result).toEqual({ ok: true, scopes: emptySet({ account: true }) });
    });

    it('parses "account offline_access" together', () => {
      const result = parseScopeList('account offline_access');
      expect(result).toEqual({ ok: true, scopes: emptySet({ account: true, offlineAccess: true }) });
    });

    it('parses a bare drive scope as inherit', () => {
      const result = parseScopeList('drive:abc123');
      expect(result).toEqual({
        ok: true,
        scopes: emptySet({ drives: drives(['abc123', { kind: 'drive', driveId: 'abc123', role: { kind: 'inherit' } }]) }),
      });
    });

    it('parses drive:<id>:admin', () => {
      const result = parseScopeList('drive:abc123:admin');
      expect(result).toEqual({
        ok: true,
        scopes: emptySet({ drives: drives(['abc123', { kind: 'drive', driveId: 'abc123', role: { kind: 'admin' } }]) }),
      });
    });

    it('parses drive:<id>:member', () => {
      const result = parseScopeList('drive:abc123:member');
      expect(result).toEqual({
        ok: true,
        scopes: emptySet({ drives: drives(['abc123', { kind: 'drive', driveId: 'abc123', role: { kind: 'member' } }]) }),
      });
    });

    it('parses drive:<id>:role:<roleId> as a custom role', () => {
      const result = parseScopeList('drive:abc123:role:xyz789');
      expect(result).toEqual({
        ok: true,
        scopes: emptySet({
          drives: drives(['abc123', { kind: 'drive', driveId: 'abc123', role: { kind: 'custom', customRoleId: 'xyz789' } }]),
        }),
      });
    });

    it('parses multiple distinct drive scopes', () => {
      const result = parseScopeList('drive:aaa drive:bbb:admin');
      expect(result).toEqual({
        ok: true,
        scopes: emptySet({
          drives: drives(
            ['aaa', { kind: 'drive', driveId: 'aaa', role: { kind: 'inherit' } }],
            ['bbb', { kind: 'drive', driveId: 'bbb', role: { kind: 'admin' } }],
          ),
        }),
      });
    });

    it('parses offline_access combined with drive scopes (no account present)', () => {
      const result = parseScopeList('offline_access drive:aaa');
      expect(result).toEqual({
        ok: true,
        scopes: emptySet({
          offlineAccess: true,
          drives: drives(['aaa', { kind: 'drive', driveId: 'aaa', role: { kind: 'inherit' } }]),
        }),
      });
    });

    it('accepts a 32-character resource id (upper bound)', () => {
      const id = 'a'.repeat(32);
      const result = parseScopeList(`drive:${id}`);
      expect(result.ok).toBe(true);
    });

    it('parses "manage_keys" alone', () => {
      const result = parseScopeList('manage_keys');
      expect(result).toEqual({ ok: true, scopes: emptySet({ manageKeys: true }) });
    });

    it('parses "manage_keys offline_access" together — a long-lived key-management session', () => {
      const result = parseScopeList('manage_keys offline_access');
      expect(result).toEqual({ ok: true, scopes: emptySet({ manageKeys: true, offlineAccess: true }) });
    });

    it('parses "all_drives" alone', () => {
      const result = parseScopeList('all_drives');
      expect(result).toEqual({ ok: true, scopes: emptySet({ allDrives: true }) });
    });

    it('parses "all_drives offline_access" together — a long-lived all-drives session', () => {
      const result = parseScopeList('all_drives offline_access');
      expect(result).toEqual({ ok: true, scopes: emptySet({ allDrives: true, offlineAccess: true }) });
    });
  });

  describe('fail-closed rejections (rules 1-5, F1-F3)', () => {
    it('rejects an empty scope string (rule 2 / F1)', () => {
      expect(parseScopeList('')).toEqual({ ok: false, error: { code: 'empty_scope' } });
    });

    it('rejects a whitespace-only scope string (rule 2 / F1)', () => {
      expect(parseScopeList('   ')).toEqual({ ok: false, error: { code: 'empty_scope' } });
    });

    it('rejects an unrecognized scope token (rule 1 / F1)', () => {
      expect(parseScopeList('not_a_real_scope')).toEqual({
        ok: false,
        error: { code: 'unknown_scope', scope: 'not_a_real_scope' },
      });
    });

    it('rejects the whole request when any token is unrecognized, not just that token', () => {
      const result = parseScopeList('account bogus');
      expect(result).toEqual({ ok: false, error: { code: 'unknown_scope', scope: 'bogus' } });
    });

    it('rejects "drive:" with a missing resource id (malformed / F1)', () => {
      expect(parseScopeList('drive:')).toEqual({ ok: false, error: { code: 'malformed_scope', scope: 'drive:' } });
    });

    it('rejects uppercase characters in the resource id (malformed / F1)', () => {
      expect(parseScopeList('drive:ABC123')).toEqual({
        ok: false,
        error: { code: 'malformed_scope', scope: 'drive:ABC123' },
      });
    });

    it('rejects a resource id longer than 32 characters (malformed / F1)', () => {
      const tooLong = 'a'.repeat(33);
      expect(parseScopeList(`drive:${tooLong}`)).toEqual({
        ok: false,
        error: { code: 'malformed_scope', scope: `drive:${tooLong}` },
      });
    });

    it('rejects "drive:<id>:owner" — OWNER is not grantable via scope (rule 5)', () => {
      expect(parseScopeList('drive:abc:owner')).toEqual({
        ok: false,
        error: { code: 'malformed_scope', scope: 'drive:abc:owner' },
      });
    });

    it('rejects "drive:<id>:role" with a missing role id (malformed)', () => {
      expect(parseScopeList('drive:abc:role')).toEqual({
        ok: false,
        error: { code: 'malformed_scope', scope: 'drive:abc:role' },
      });
    });

    it('rejects "drive:<id>:role:" with an empty role id (malformed)', () => {
      expect(parseScopeList('drive:abc:role:')).toEqual({
        ok: false,
        error: { code: 'malformed_scope', scope: 'drive:abc:role:' },
      });
    });

    it('rejects a role id containing invalid characters (malformed)', () => {
      expect(parseScopeList('drive:abc:role:BAD!')).toEqual({
        ok: false,
        error: { code: 'malformed_scope', scope: 'drive:abc:role:BAD!' },
      });
    });

    it('rejects extra trailing segments (malformed)', () => {
      expect(parseScopeList('drive:abc:admin:extra')).toEqual({
        ok: false,
        error: { code: 'malformed_scope', scope: 'drive:abc:admin:extra' },
      });
    });

    it('rejects malformed tokens produced by double spaces (no silent skipping)', () => {
      const result = parseScopeList('account  offline_access');
      expect(result.ok).toBe(false);
    });

    it('rejects "account" mixed with any drive:* scope (rule 3 / F2)', () => {
      expect(parseScopeList('account drive:abc')).toEqual({
        ok: false,
        error: { code: 'account_drive_conflict' },
      });
    });

    it('rejects "account" mixed with a drive:* scope regardless of order (rule 3 / F2)', () => {
      expect(parseScopeList('drive:abc account')).toEqual({
        ok: false,
        error: { code: 'account_drive_conflict' },
      });
    });

    it('rejects duplicate drive ids with identical roles (rule 4 / F3)', () => {
      expect(parseScopeList('drive:abc drive:abc')).toEqual({
        ok: false,
        error: { code: 'duplicate_drive', driveId: 'abc' },
      });
    });

    it('rejects duplicate drive ids with contradictory roles (rule 4 / F3)', () => {
      expect(parseScopeList('drive:abc:admin drive:abc:member')).toEqual({
        ok: false,
        error: { code: 'duplicate_drive', driveId: 'abc' },
      });
    });

    it('rejects "offline_access" alone — no account/drive:* means no access scope to refresh into (rule 10 / F13, Codex #1754)', () => {
      expect(parseScopeList('offline_access')).toEqual({
        ok: false,
        error: { code: 'offline_access_alone' },
      });
    });

    it('rejects "manage_keys" mixed with "account" (manage_keys_conflict)', () => {
      expect(parseScopeList('manage_keys account')).toEqual({
        ok: false,
        error: { code: 'manage_keys_conflict' },
      });
    });

    it('rejects "manage_keys" mixed with any drive:* scope, regardless of order (manage_keys_conflict)', () => {
      expect(parseScopeList('drive:abc manage_keys')).toEqual({
        ok: false,
        error: { code: 'manage_keys_conflict' },
      });
    });

    it('does not reject "manage_keys offline_access" as offline_access_alone — manage_keys is its own principal shape', () => {
      const result = parseScopeList('manage_keys offline_access');
      expect(result.ok).toBe(true);
    });

    it('rejects "all_drives" mixed with "account" (all_drives_conflict)', () => {
      expect(parseScopeList('all_drives account')).toEqual({
        ok: false,
        error: { code: 'all_drives_conflict' },
      });
    });

    it('rejects "all_drives" mixed with "manage_keys" (all_drives_conflict)', () => {
      expect(parseScopeList('all_drives manage_keys')).toEqual({
        ok: false,
        error: { code: 'all_drives_conflict' },
      });
    });

    it('rejects "all_drives" mixed with any drive:* scope, regardless of order (all_drives_conflict)', () => {
      expect(parseScopeList('all_drives drive:abc')).toEqual({
        ok: false,
        error: { code: 'all_drives_conflict' },
      });
      expect(parseScopeList('drive:abc all_drives')).toEqual({
        ok: false,
        error: { code: 'all_drives_conflict' },
      });
    });

    it('does not reject "all_drives offline_access" as offline_access_alone — all_drives is its own principal shape', () => {
      const result = parseScopeList('all_drives offline_access');
      expect(result.ok).toBe(true);
    });
  });

  it('is total: never throws, even on garbage input', () => {
    const garbageInputs = ['\n', ':::::', 'drive:::role::', '   drive:  ', 'a'.repeat(1000)];
    for (const input of garbageInputs) {
      expect(() => parseScopeList(input)).not.toThrow();
    }
  });
});

describe('formatScopeSet (canonical serialization, rule 9)', () => {
  it('formats account alone', () => {
    expect(formatScopeSet(emptySet({ account: true }))).toBe('account');
  });

  it('formats offline_access alone', () => {
    expect(formatScopeSet(emptySet({ offlineAccess: true }))).toBe('offline_access');
  });

  it('orders account before offline_access regardless of construction order', () => {
    expect(formatScopeSet(emptySet({ account: true, offlineAccess: true }))).toBe('account offline_access');
  });

  it('formats manage_keys alone', () => {
    expect(formatScopeSet(emptySet({ manageKeys: true }))).toBe('manage_keys');
  });

  it('orders manage_keys before offline_access regardless of construction order', () => {
    expect(formatScopeSet(emptySet({ manageKeys: true, offlineAccess: true }))).toBe('manage_keys offline_access');
  });

  it('formats all_drives alone', () => {
    expect(formatScopeSet(emptySet({ allDrives: true }))).toBe('all_drives');
  });

  it('orders all_drives before offline_access regardless of construction order', () => {
    expect(formatScopeSet(emptySet({ allDrives: true, offlineAccess: true }))).toBe('all_drives offline_access');
  });

  it('orders drive scopes by drive id ascending, independent of Map insertion order', () => {
    const scopes = emptySet({
      drives: drives(
        ['bbb', { kind: 'drive', driveId: 'bbb', role: { kind: 'admin' } }],
        ['aaa', { kind: 'drive', driveId: 'aaa', role: { kind: 'inherit' } }],
      ),
    });
    expect(formatScopeSet(scopes)).toBe('drive:aaa drive:bbb:admin');
  });

  it('formats each drive role kind in canonical form', () => {
    expect(
      formatScopeSet(emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'inherit' } }]) })),
    ).toBe('drive:x');
    expect(
      formatScopeSet(emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'admin' } }]) })),
    ).toBe('drive:x:admin');
    expect(
      formatScopeSet(emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'member' } }]) })),
    ).toBe('drive:x:member');
    expect(
      formatScopeSet(
        emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'custom', customRoleId: 'r1' } }]) }),
      ),
    ).toBe('drive:x:role:r1');
  });

  it('round-trips: parse(format(s)) deep-equals s for a representative set', () => {
    const original = emptySet({
      offlineAccess: true,
      drives: drives(
        ['bbb', { kind: 'drive', driveId: 'bbb', role: { kind: 'admin' } }],
        ['aaa', { kind: 'drive', driveId: 'aaa', role: { kind: 'custom', customRoleId: 'r9' } }],
      ),
    });
    const formatted = formatScopeSet(original);
    const reparsed = parseScopeList(formatted);
    expect(reparsed).toEqual({ ok: true, scopes: original });
  });

  it('round-trips an account grant', () => {
    const original = emptySet({ account: true, offlineAccess: true });
    const reparsed = parseScopeList(formatScopeSet(original));
    expect(reparsed).toEqual({ ok: true, scopes: original });
  });

  it('round-trips "manage_keys offline_access" back to the same string (rule 9)', () => {
    const formatted = formatScopeSet(emptySet({ manageKeys: true, offlineAccess: true }));
    expect(formatted).toBe('manage_keys offline_access');
    const reparsed = parseScopeList(formatted);
    expect(reparsed).toEqual({ ok: true, scopes: emptySet({ manageKeys: true, offlineAccess: true }) });
  });

  it('round-trips "all_drives offline_access" back to the same string (rule 9)', () => {
    const formatted = formatScopeSet(emptySet({ allDrives: true, offlineAccess: true }));
    expect(formatted).toBe('all_drives offline_access');
    const reparsed = parseScopeList(formatted);
    expect(reparsed).toEqual({ ok: true, scopes: emptySet({ allDrives: true, offlineAccess: true }) });
  });

  it('formatting is idempotent: format(parse(format(s))) === format(s)', () => {
    const original = emptySet({
      drives: drives(['zzz', { kind: 'drive', driveId: 'zzz', role: { kind: 'member' } }]),
    });
    const once = formatScopeSet(original);
    const parsedBack = parseScopeList(once);
    expect(parsedBack.ok).toBe(true);
    const twice = parsedBack.ok ? formatScopeSet(parsedBack.scopes) : null;
    expect(twice).toBe(once);
  });
});

describe('isScopeSubset (narrowing, rule 8 / F5) — escalation must be structurally impossible', () => {
  it('account is a subset of account', () => {
    expect(isScopeSubset(emptySet({ account: true }), emptySet({ account: true }))).toBe(true);
  });

  it('account is never a subset of a drive-only grant (escalation attempt)', () => {
    const requested = emptySet({ account: true });
    const granted = emptySet({ drives: drives(['aaa', { kind: 'drive', driveId: 'aaa', role: { kind: 'admin' } }]) });
    expect(isScopeSubset(requested, granted)).toBe(false);
  });

  it('a drive scope is a subset of an account grant (account covers every drive)', () => {
    const requested = emptySet({ drives: drives(['aaa', { kind: 'drive', driveId: 'aaa', role: { kind: 'admin' } }]) });
    const granted = emptySet({ account: true });
    expect(isScopeSubset(requested, granted)).toBe(true);
  });

  it('drive:X:admin is NOT a subset of drive:X:member (escalation attempt, ADR example)', () => {
    const requested = emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'admin' } }]) });
    const granted = emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'member' } }]) });
    expect(isScopeSubset(requested, granted)).toBe(false);
  });

  it('drive:X:member is NOT a subset of drive:X:admin (no implicit privilege ordering)', () => {
    const requested = emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'member' } }]) });
    const granted = emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'admin' } }]) });
    expect(isScopeSubset(requested, granted)).toBe(false);
  });

  it('identical drive grants are subsets of each other', () => {
    const set = emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'inherit' } }]) });
    expect(isScopeSubset(set, set)).toBe(true);
  });

  it('requesting a superset of granted drives is rejected (requested ⊃ granted)', () => {
    const requested = emptySet({
      drives: drives(
        ['aaa', { kind: 'drive', driveId: 'aaa', role: { kind: 'inherit' } }],
        ['bbb', { kind: 'drive', driveId: 'bbb', role: { kind: 'inherit' } }],
      ),
    });
    const granted = emptySet({ drives: drives(['aaa', { kind: 'drive', driveId: 'aaa', role: { kind: 'inherit' } }]) });
    expect(isScopeSubset(requested, granted)).toBe(false);
  });

  it('requesting a subset of granted drives succeeds', () => {
    const requested = emptySet({ drives: drives(['aaa', { kind: 'drive', driveId: 'aaa', role: { kind: 'inherit' } }]) });
    const granted = emptySet({
      drives: drives(
        ['aaa', { kind: 'drive', driveId: 'aaa', role: { kind: 'inherit' } }],
        ['bbb', { kind: 'drive', driveId: 'bbb', role: { kind: 'inherit' } }],
      ),
    });
    expect(isScopeSubset(requested, granted)).toBe(true);
  });

  it('disjoint drive sets are never subsets of one another', () => {
    const requested = emptySet({ drives: drives(['ccc', { kind: 'drive', driveId: 'ccc', role: { kind: 'inherit' } }]) });
    const granted = emptySet({ drives: drives(['aaa', { kind: 'drive', driveId: 'aaa', role: { kind: 'inherit' } }]) });
    expect(isScopeSubset(requested, granted)).toBe(false);
  });

  it('two different custom roles on the same drive are not interchangeable', () => {
    const requested = emptySet({
      drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'custom', customRoleId: 'r1' } }]),
    });
    const granted = emptySet({
      drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'custom', customRoleId: 'r2' } }]),
    });
    expect(isScopeSubset(requested, granted)).toBe(false);
  });

  it('offline_access requested but not granted is rejected', () => {
    expect(isScopeSubset(emptySet({ offlineAccess: true }), emptySet())).toBe(false);
  });

  it('not requesting offline_access is always fine, even if granted has it', () => {
    expect(isScopeSubset(emptySet(), emptySet({ offlineAccess: true }))).toBe(true);
  });

  it('manage_keys is a subset of manage_keys', () => {
    expect(isScopeSubset(emptySet({ manageKeys: true }), emptySet({ manageKeys: true }))).toBe(true);
  });

  it('manage_keys requested but not granted is rejected', () => {
    expect(isScopeSubset(emptySet({ manageKeys: true }), emptySet())).toBe(false);
  });

  it('not requesting manage_keys is always fine, even if granted has it', () => {
    expect(isScopeSubset(emptySet(), emptySet({ manageKeys: true }))).toBe(true);
  });

  it('all_drives is a subset of all_drives', () => {
    expect(isScopeSubset(emptySet({ allDrives: true }), emptySet({ allDrives: true }))).toBe(true);
  });

  it('all_drives requested but not granted is rejected', () => {
    expect(isScopeSubset(emptySet({ allDrives: true }), emptySet())).toBe(false);
  });

  it('a granted account does not implicitly satisfy a requested all_drives (fail closed, no cross-shape narrowing)', () => {
    expect(isScopeSubset(emptySet({ allDrives: true }), emptySet({ account: true }))).toBe(false);
  });

  it('not requesting all_drives is always fine, even if granted has it', () => {
    expect(isScopeSubset(emptySet(), emptySet({ allDrives: true }))).toBe(true);
  });
});

describe('scopeSetToDriveScopes (bridge to mcp_token_drives shape, Decision 2)', () => {
  it('produces no rows for an account-only grant', () => {
    expect(scopeSetToDriveScopes(emptySet({ account: true }))).toEqual([]);
  });

  it('produces no rows for an all_drives-only grant', () => {
    expect(scopeSetToDriveScopes(emptySet({ allDrives: true }))).toEqual([]);
  });

  it('maps inherit to a null role and null customRoleId', () => {
    const scopes = emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'inherit' } }]) });
    expect(scopeSetToDriveScopes(scopes)).toEqual([{ driveId: 'x', role: null, customRoleId: null }]);
  });

  it('maps admin to role ADMIN', () => {
    const scopes = emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'admin' } }]) });
    expect(scopeSetToDriveScopes(scopes)).toEqual([{ driveId: 'x', role: 'ADMIN', customRoleId: null }]);
  });

  it('maps member to role MEMBER', () => {
    const scopes = emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'member' } }]) });
    expect(scopeSetToDriveScopes(scopes)).toEqual([{ driveId: 'x', role: 'MEMBER', customRoleId: null }]);
  });

  it('maps a custom role to MEMBER + customRoleId (rule 6: custom implies MEMBER)', () => {
    const scopes = emptySet({
      drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'custom', customRoleId: 'r1' } }]),
    });
    expect(scopeSetToDriveScopes(scopes)).toEqual([{ driveId: 'x', role: 'MEMBER', customRoleId: 'r1' }]);
  });

  it('returns rows sorted by drive id', () => {
    const scopes = emptySet({
      drives: drives(
        ['bbb', { kind: 'drive', driveId: 'bbb', role: { kind: 'admin' } }],
        ['aaa', { kind: 'drive', driveId: 'aaa', role: { kind: 'inherit' } }],
      ),
    });
    expect(scopeSetToDriveScopes(scopes)).toEqual([
      { driveId: 'aaa', role: null, customRoleId: null },
      { driveId: 'bbb', role: 'ADMIN', customRoleId: null },
    ]);
  });
});

describe('isPureDriveGrant (Phase 9 follow-up: gates OAuth token exchange vs a real mcp_tokens mint)', () => {
  it('true for one or more drive:* scopes with no account/manage_keys', () => {
    const scopes = emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'member' } }]) });
    expect(isPureDriveGrant(scopes)).toBe(true);
  });

  it('true regardless of offlineAccess', () => {
    const scopes = emptySet({
      offlineAccess: true,
      drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'inherit' } }]),
    });
    expect(isPureDriveGrant(scopes)).toBe(true);
  });

  it('false for account (parse-time exclusion already guarantees no drives alongside it, but the predicate stands on its own)', () => {
    expect(isPureDriveGrant(emptySet({ account: true }))).toBe(false);
  });

  it('false for manage_keys', () => {
    expect(isPureDriveGrant(emptySet({ manageKeys: true }))).toBe(false);
  });

  it('false for all_drives', () => {
    expect(isPureDriveGrant(emptySet({ allDrives: true }))).toBe(false);
  });

  it('false for an empty scope set with no drives at all (e.g. offline_access alone would fail parseScopeList before reaching here, but the predicate itself must not treat "nothing" as a drive grant)', () => {
    expect(isPureDriveGrant(emptySet())).toBe(false);
  });

  it('false when update_key is set — a key-update grant must never fall into the fresh-mint branch', () => {
    const scopes = emptySet({
      updateKeyId: 'tok123',
      drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'member' } }]),
    });
    expect(isPureDriveGrant(scopes)).toBe(false);
  });
});

describe('isAllDrivesGrant (gates OAuth token exchange vs a real, unscoped mcp_tokens mint)', () => {
  it('true when allDrives is set', () => {
    expect(isAllDrivesGrant(emptySet({ allDrives: true }))).toBe(true);
  });

  it('false for account', () => {
    expect(isAllDrivesGrant(emptySet({ account: true }))).toBe(false);
  });

  it('false for manage_keys', () => {
    expect(isAllDrivesGrant(emptySet({ manageKeys: true }))).toBe(false);
  });

  it('false for a pure drive grant', () => {
    const scopes = emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'member' } }]) });
    expect(isAllDrivesGrant(scopes)).toBe(false);
  });

  it('false for an empty scope set', () => {
    expect(isAllDrivesGrant(emptySet())).toBe(false);
  });
});

describe('update_key:<tokenId> (in-place key re-scope grant)', () => {
  const driveEntry = drives(['abc123', { kind: 'drive', driveId: 'abc123', role: { kind: 'member' } }]);

  it('parses update_key:<id> alongside a drive scope', () => {
    const result = parseScopeList('update_key:tok123 drive:abc123:member');
    expect(result).toEqual({ ok: true, scopes: emptySet({ updateKeyId: 'tok123', drives: driveEntry }) });
  });

  it('round-trips through formatScopeSet with update_key serialized first', () => {
    const scopes = emptySet({ updateKeyId: 'tok123', drives: driveEntry });
    const formatted = formatScopeSet(scopes);
    expect(formatted).toBe('update_key:tok123 drive:abc123:member');
    expect(parseScopeList(formatted)).toEqual({ ok: true, scopes });
  });

  it('rejects a malformed token id (uppercase, too long, empty)', () => {
    expect(parseScopeList('update_key:TOK drive:abc123')).toEqual({
      ok: false,
      error: { code: 'malformed_scope', scope: 'update_key:TOK' },
    });
    expect(parseScopeList(`update_key:${'a'.repeat(33)} drive:abc123`).ok).toBe(false);
    expect(parseScopeList('update_key: drive:abc123').ok).toBe(false);
  });

  it('rejects a duplicate update_key token', () => {
    expect(parseScopeList('update_key:aaa update_key:bbb drive:abc123')).toEqual({
      ok: false,
      error: { code: 'duplicate_update_key' },
    });
  });

  it('rejects update_key without any drive scope — re-scoping to nothing is revocation, not an update', () => {
    expect(parseScopeList('update_key:tok123')).toEqual({
      ok: false,
      error: { code: 'update_key_without_drive' },
    });
  });

  it.each(['account', 'manage_keys', 'all_drives', 'offline_access'])('rejects update_key combined with %s', (conflicting) => {
    // account/manage_keys alongside drive:* already trip their own parse-time
    // exclusions before the update_key check runs — the exact code differs,
    // but every combination fails closed.
    expect(parseScopeList(`update_key:tok123 ${conflicting} drive:abc123`).ok).toBe(false);
  });

  it('rejects update_key + offline_access with the update_key_conflict code — no refreshable credential is minted by this grant', () => {
    expect(parseScopeList('update_key:tok123 offline_access drive:abc123')).toEqual({
      ok: false,
      error: { code: 'update_key_conflict' },
    });
    // Without a drive:* scope the account/manage_keys exclusions don't fire,
    // so the update_key conflict is what rejects these shapes too.
    expect(parseScopeList('update_key:tok123 account')).toEqual({
      ok: false,
      error: { code: 'update_key_conflict' },
    });
    expect(parseScopeList('update_key:tok123 manage_keys')).toEqual({
      ok: false,
      error: { code: 'update_key_conflict' },
    });
  });

  it('isKeyUpdateGrant discriminates the update shape from a fresh mint', () => {
    expect(isKeyUpdateGrant(emptySet({ updateKeyId: 'tok123', drives: driveEntry }))).toBe(true);
    expect(isKeyUpdateGrant(emptySet({ drives: driveEntry }))).toBe(false);
    expect(isKeyUpdateGrant(emptySet())).toBe(false);
  });

  it('isScopeSubset rejects a requested update_key the grant does not carry — refresh grants can never smuggle a re-scope in', () => {
    const requested = emptySet({ updateKeyId: 'tok123', drives: driveEntry });
    const grantedWithout = emptySet({ drives: driveEntry });
    const grantedOther = emptySet({ updateKeyId: 'tok999', drives: driveEntry });
    expect(isScopeSubset(requested, grantedWithout)).toBe(false);
    expect(isScopeSubset(requested, grantedOther)).toBe(false);
    expect(isScopeSubset(requested, emptySet({ updateKeyId: 'tok123', drives: driveEntry }))).toBe(true);
  });
});

describe('activate_key:<tokenId> (device activation approval ceremony)', () => {
  it('parses activate_key:<id> alone', () => {
    expect(parseScopeList('activate_key:tok123')).toEqual({
      ok: true,
      scopes: emptySet({ activateKeyId: 'tok123' }),
    });
  });

  it('round-trips through formatScopeSet', () => {
    const scopes = emptySet({ activateKeyId: 'tok123' });
    const formatted = formatScopeSet(scopes);
    expect(formatted).toBe('activate_key:tok123');
    expect(parseScopeList(formatted)).toEqual({ ok: true, scopes });
  });

  it('rejects a malformed token id (uppercase, too long, empty)', () => {
    expect(parseScopeList('activate_key:TOK')).toEqual({
      ok: false,
      error: { code: 'malformed_scope', scope: 'activate_key:TOK' },
    });
    expect(parseScopeList(`activate_key:${'a'.repeat(33)}`).ok).toBe(false);
    expect(parseScopeList('activate_key:').ok).toBe(false);
  });

  it('rejects a duplicate activate_key token', () => {
    expect(parseScopeList('activate_key:aaa activate_key:bbb')).toEqual({
      ok: false,
      error: { code: 'duplicate_activate_key' },
    });
  });

  it.each(['account', 'manage_keys', 'all_drives', 'offline_access', 'drive:abc123:member', 'update_key:tok999 drive:abc123:member'])(
    'rejects activate_key combined with %s — an "activate" consent must never carry a grant',
    (extra) => {
      expect(parseScopeList(`activate_key:tok123 ${extra}`)).toEqual({
        ok: false,
        error: { code: 'activate_key_not_alone' },
      });
    },
  );

  it('isKeyActivationGrant discriminates the activation shape', () => {
    expect(isKeyActivationGrant(emptySet({ activateKeyId: 'tok123' }))).toBe(true);
    expect(isKeyActivationGrant(emptySet())).toBe(false);
  });

  it('isPureDriveGrant is false for an activation (nothing to mint)', () => {
    expect(isPureDriveGrant(emptySet({ activateKeyId: 'tok123' }))).toBe(false);
  });

  it('isScopeSubset rejects a requested activate_key the grant does not carry — refresh grants can never smuggle an activation in', () => {
    const requested = emptySet({ activateKeyId: 'tok123' });
    expect(isScopeSubset(requested, emptySet())).toBe(false);
    expect(isScopeSubset(requested, emptySet({ activateKeyId: 'tok999' }))).toBe(false);
    expect(isScopeSubset(requested, emptySet({ activateKeyId: 'tok123' }))).toBe(true);
  });
});

describe('checkGrantAuthority (consent-time authority cap, Decision 2 / F4)', () => {
  function authorityMap(
    entries: Array<
      [
        string,
        {
          isOwner?: boolean;
          isMember?: boolean;
          isAdmin?: boolean;
          ownCustomRoleId?: string | null;
          roleBelongsToDrive?: (roleId: string) => boolean;
        },
      ]
    >,
  ) {
    return new Map(
      entries.map(([driveId, a]) => [
        driveId,
        {
          isOwner: a.isOwner ?? false,
          isMember: a.isMember ?? false,
          isAdmin: a.isAdmin ?? false,
          ownCustomRoleId: a.ownCustomRoleId ?? null,
          roleBelongsToDrive: a.roleBelongsToDrive ?? (() => true),
        },
      ]),
    );
  }

  it('allows an account-only request unconditionally (no drives to check)', () => {
    const result = checkGrantAuthority(emptySet({ account: true }), authorityMap([]));
    expect(result).toEqual({ ok: true });
  });

  it('rejects with no_access when the requester has no membership row for the drive', () => {
    const scopes = emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'inherit' } }]) });
    const result = checkGrantAuthority(scopes, authorityMap([]));
    expect(result).toEqual({ ok: false, reason: 'no_access', driveId: 'x' });
  });

  it('rejects with no_access when present but neither owner nor member', () => {
    const scopes = emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'inherit' } }]) });
    const result = checkGrantAuthority(scopes, authorityMap([['x', { isOwner: false, isMember: false }]]));
    expect(result).toEqual({ ok: false, reason: 'no_access', driveId: 'x' });
  });

  it('rejects with admin_not_grantable when a plain member requests admin', () => {
    const scopes = emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'admin' } }]) });
    const result = checkGrantAuthority(scopes, authorityMap([['x', { isMember: true, isAdmin: false }]]));
    expect(result).toEqual({ ok: false, reason: 'admin_not_grantable', driveId: 'x' });
  });

  it('allows an admin to grant admin', () => {
    const scopes = emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'admin' } }]) });
    const result = checkGrantAuthority(scopes, authorityMap([['x', { isMember: true, isAdmin: true }]]));
    expect(result).toEqual({ ok: true });
  });

  it('allows an owner to grant admin even without an explicit isAdmin flag', () => {
    const scopes = emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'admin' } }]) });
    const result = checkGrantAuthority(scopes, authorityMap([['x', { isOwner: true, isAdmin: false }]]));
    expect(result).toEqual({ ok: true });
  });

  it('allows a plain member to grant member/inherit scopes on their own drive', () => {
    const scopes = emptySet({ drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'member' } }]) });
    const result = checkGrantAuthority(scopes, authorityMap([['x', { isMember: true }]]));
    expect(result).toEqual({ ok: true });
  });

  it('rejects with custom_role_not_in_drive when the role does not belong to the drive', () => {
    const scopes = emptySet({
      drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'custom', customRoleId: 'r1' } }]),
    });
    const result = checkGrantAuthority(
      scopes,
      authorityMap([['x', { isMember: true, ownCustomRoleId: 'r1', roleBelongsToDrive: () => false }]]),
    );
    expect(result).toEqual({ ok: false, reason: 'custom_role_not_in_drive', driveId: 'x' });
  });

  it('rejects with foreign_custom_role when a non-admin requests a custom role that is not their own', () => {
    const scopes = emptySet({
      drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'custom', customRoleId: 'r1' } }]),
    });
    const result = checkGrantAuthority(
      scopes,
      authorityMap([['x', { isMember: true, ownCustomRoleId: 'r2', roleBelongsToDrive: () => true }]]),
    );
    expect(result).toEqual({ ok: false, reason: 'foreign_custom_role', driveId: 'x' });
  });

  it('allows a non-admin to grant their own assigned custom role', () => {
    const scopes = emptySet({
      drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'custom', customRoleId: 'r1' } }]),
    });
    const result = checkGrantAuthority(
      scopes,
      authorityMap([['x', { isMember: true, ownCustomRoleId: 'r1', roleBelongsToDrive: () => true }]]),
    );
    expect(result).toEqual({ ok: true });
  });

  it('allows an admin to grant a custom role that is not their own (admin/owner bypass foreign-role check)', () => {
    const scopes = emptySet({
      drives: drives(['x', { kind: 'drive', driveId: 'x', role: { kind: 'custom', customRoleId: 'r1' } }]),
    });
    const result = checkGrantAuthority(
      scopes,
      authorityMap([['x', { isMember: true, isAdmin: true, ownCustomRoleId: null, roleBelongsToDrive: () => true }]]),
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects the entire request at the first offending drive when multiple drives are requested', () => {
    const scopes = emptySet({
      drives: drives(
        ['good', { kind: 'drive', driveId: 'good', role: { kind: 'member' } }],
        ['bad', { kind: 'drive', driveId: 'bad', role: { kind: 'admin' } }],
      ),
    });
    const result = checkGrantAuthority(
      scopes,
      authorityMap([
        ['good', { isMember: true }],
        ['bad', { isMember: true, isAdmin: false }],
      ]),
    );
    expect(result).toEqual({ ok: false, reason: 'admin_not_grantable', driveId: 'bad' });
  });

  it('allows a fully authorized multi-drive request', () => {
    const scopes = emptySet({
      drives: drives(
        ['a', { kind: 'drive', driveId: 'a', role: { kind: 'inherit' } }],
        ['b', { kind: 'drive', driveId: 'b', role: { kind: 'admin' } }],
      ),
    });
    const result = checkGrantAuthority(
      scopes,
      authorityMap([
        ['a', { isMember: true }],
        ['b', { isOwner: true }],
      ]),
    );
    expect(result).toEqual({ ok: true });
  });
});
