import { describe, expect, it } from 'vitest';
import {
  CredentialsFileFormatError,
  DEFAULT_PROFILE_NAME,
  emptyCredentialsFile,
  getHost,
  isSecureMode,
  listSummaries,
  parseCredentialsFile,
  parseHostCredential,
  permissionFixItMessage,
  removeHost,
  serializeCredentialsFile,
  serializeHostCredential,
  tokenPrefix,
  upsertHost,
} from '@pagespace/cli';
import type { CredentialsFile, HostCredential } from '@pagespace/cli';

const CRED_A: HostCredential = {
  refreshToken: 'ps_rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  clientId: 'cli-first-party',
  scopes: ['drives:read', 'drives:write'],
  createdAt: '2026-07-03T00:00:00.000Z',
};

const CRED_B: HostCredential = {
  refreshToken: 'ps_rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  clientId: 'cli-first-party',
  scopes: ['*'],
  createdAt: '2026-07-03T01:00:00.000Z',
};

describe('emptyCredentialsFile', () => {
  it('starts with version 2 and no hosts', () => {
    expect(emptyCredentialsFile()).toEqual({ version: 2, hosts: {} });
  });
});

describe('upsertHost / getHost / removeHost', () => {
  it('is pure: does not mutate the input file', () => {
    const file = emptyCredentialsFile();
    const next = upsertHost(file, 'pagespace.ai', CRED_A);
    expect(file).toEqual({ version: 2, hosts: {} });
    expect(getHost(next, 'pagespace.ai')).toEqual(CRED_A);
  });

  it('supports multiple hosts independently', () => {
    let file = emptyCredentialsFile();
    file = upsertHost(file, 'pagespace.ai', CRED_A);
    file = upsertHost(file, 'self-hosted.example', CRED_B);
    expect(getHost(file, 'pagespace.ai')).toEqual(CRED_A);
    expect(getHost(file, 'self-hosted.example')).toEqual(CRED_B);
  });

  it('getHost returns null for an unknown host', () => {
    expect(getHost(emptyCredentialsFile(), 'unknown.example')).toBeNull();
  });

  it('removeHost drops only the named host, pure', () => {
    let file = emptyCredentialsFile();
    file = upsertHost(file, 'pagespace.ai', CRED_A);
    file = upsertHost(file, 'self-hosted.example', CRED_B);
    const next = removeHost(file, 'pagespace.ai');
    expect(getHost(next, 'pagespace.ai')).toBeNull();
    expect(getHost(next, 'self-hosted.example')).toEqual(CRED_B);
    expect(getHost(file, 'pagespace.ai')).toEqual(CRED_A);
  });

  it('removeHost on a missing host is a no-op', () => {
    const file = upsertHost(emptyCredentialsFile(), 'pagespace.ai', CRED_A);
    expect(removeHost(file, 'unknown.example')).toEqual(file);
  });
});

describe('serializeCredentialsFile / parseCredentialsFile round-trip', () => {
  it('round-trips an empty file', () => {
    const file = emptyCredentialsFile();
    expect(parseCredentialsFile(serializeCredentialsFile(file))).toEqual(file);
  });

  it('round-trips a multi-host file', () => {
    let file = emptyCredentialsFile();
    file = upsertHost(file, 'pagespace.ai', CRED_A);
    file = upsertHost(file, 'self-hosted.example', CRED_B);
    expect(parseCredentialsFile(serializeCredentialsFile(file))).toEqual(file);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseCredentialsFile('{not json')).toThrow(CredentialsFileFormatError);
  });

  it('rejects an unsupported version', () => {
    expect(() => parseCredentialsFile(JSON.stringify({ version: 99, hosts: {} }))).toThrow(
      CredentialsFileFormatError,
    );
  });

  it('rejects a malformed host entry (missing refreshToken)', () => {
    const raw = JSON.stringify({
      version: 1,
      hosts: { 'pagespace.ai': { clientId: 'x', scopes: [], createdAt: '2026-01-01T00:00:00.000Z' } },
    });
    expect(() => parseCredentialsFile(raw)).toThrow(CredentialsFileFormatError);
  });

  it('rejects a host entry with non-string scopes', () => {
    const raw = JSON.stringify({
      version: 1,
      hosts: {
        'pagespace.ai': { refreshToken: 't', clientId: 'x', scopes: [1, 2], createdAt: '2026-01-01T00:00:00.000Z' },
      },
    });
    expect(() => parseCredentialsFile(raw)).toThrow(CredentialsFileFormatError);
  });
});

describe('v1 -> v2 migration (automatic, one-time, on read)', () => {
  const v1Raw = JSON.stringify({
    version: 1,
    hosts: {
      'pagespace.ai': CRED_A,
      'self-hosted.example': CRED_B,
    },
  });

  it('reads a v1 file back as version 2, folding each host into its "default" profile', () => {
    const file = parseCredentialsFile(v1Raw);
    expect(file.version).toBe(2);
    expect(file).toEqual({
      version: 2,
      hosts: {
        'pagespace.ai': { profiles: { default: CRED_A } },
        'self-hosted.example': { profiles: { default: CRED_B } },
      },
    });
  });

  it('a migrated v1 credential reads back identically through the profile-aware API, with zero behavior change', () => {
    const file = parseCredentialsFile(v1Raw);
    expect(getHost(file, 'pagespace.ai')).toEqual(CRED_A);
    expect(getHost(file, 'pagespace.ai', DEFAULT_PROFILE_NAME)).toEqual(CRED_A);
    expect(getHost(file, 'self-hosted.example')).toEqual(CRED_B);
    expect(listSummaries(file)).toEqual([
      { host: 'pagespace.ai', tokenPrefix: tokenPrefix(CRED_A.refreshToken) },
      { host: 'self-hosted.example', tokenPrefix: tokenPrefix(CRED_B.refreshToken) },
    ]);
  });

  it('still rejects a malformed v1 host entry during migration', () => {
    const raw = JSON.stringify({
      version: 1,
      hosts: { 'pagespace.ai': { clientId: 'x', scopes: [], createdAt: '2026-01-01T00:00:00.000Z' } },
    });
    expect(() => parseCredentialsFile(raw)).toThrow(CredentialsFileFormatError);
  });
});

describe('named profiles (v2)', () => {
  it('upsertHost defaults to the "default" profile, leaving other profiles for the same host untouched', () => {
    let file = emptyCredentialsFile();
    file = upsertHost(file, 'pagespace.ai', CRED_A);
    file = upsertHost(file, 'pagespace.ai', CRED_B, 'work');

    expect(getHost(file, 'pagespace.ai')).toEqual(CRED_A);
    expect(getHost(file, 'pagespace.ai', 'default')).toEqual(CRED_A);
    expect(getHost(file, 'pagespace.ai', 'work')).toEqual(CRED_B);
  });

  it('getHost returns null for a profile that was never stored', () => {
    const file = upsertHost(emptyCredentialsFile(), 'pagespace.ai', CRED_A);
    expect(getHost(file, 'pagespace.ai', 'work')).toBeNull();
  });

  it('removeHost drops only the named profile, leaving sibling profiles for the same host intact', () => {
    let file = emptyCredentialsFile();
    file = upsertHost(file, 'pagespace.ai', CRED_A, 'default');
    file = upsertHost(file, 'pagespace.ai', CRED_B, 'work');

    const next = removeHost(file, 'pagespace.ai', 'work');

    expect(getHost(next, 'pagespace.ai', 'work')).toBeNull();
    expect(getHost(next, 'pagespace.ai', 'default')).toEqual(CRED_A);
  });

  it('removeHost drops the host entirely once its last profile is removed', () => {
    const file = upsertHost(emptyCredentialsFile(), 'pagespace.ai', CRED_A);
    const next = removeHost(file, 'pagespace.ai', 'default');
    expect(next.hosts['pagespace.ai']).toBeUndefined();
  });

  it('removeHost of an unknown profile on a known host is a no-op', () => {
    const file = upsertHost(emptyCredentialsFile(), 'pagespace.ai', CRED_A);
    expect(removeHost(file, 'pagespace.ai', 'unknown-profile')).toEqual(file);
  });

  it('listSummaries(file, profile) only reports hosts that have that profile stored', () => {
    let file = emptyCredentialsFile();
    file = upsertHost(file, 'pagespace.ai', CRED_A, 'default');
    file = upsertHost(file, 'pagespace.ai', CRED_B, 'work');
    file = upsertHost(file, 'self-hosted.example', CRED_B, 'default');

    expect(listSummaries(file, 'default')).toEqual([
      { host: 'pagespace.ai', tokenPrefix: tokenPrefix(CRED_A.refreshToken) },
      { host: 'self-hosted.example', tokenPrefix: tokenPrefix(CRED_B.refreshToken) },
    ]);
    expect(listSummaries(file, 'work')).toEqual([{ host: 'pagespace.ai', tokenPrefix: tokenPrefix(CRED_B.refreshToken) }]);
  });

  it('round-trips a multi-profile file through serialize/parse', () => {
    let file = emptyCredentialsFile();
    file = upsertHost(file, 'pagespace.ai', CRED_A, 'default');
    file = upsertHost(file, 'pagespace.ai', CRED_B, 'work');

    expect(parseCredentialsFile(serializeCredentialsFile(file))).toEqual(file);
  });

  it('rejects a v2 host entry missing a "profiles" object', () => {
    const raw = JSON.stringify({ version: 2, hosts: { 'pagespace.ai': { notProfiles: {} } } });
    expect(() => parseCredentialsFile(raw)).toThrow(CredentialsFileFormatError);
  });

  it('rejects a v2 profile entry that is a malformed credential', () => {
    const raw = JSON.stringify({
      version: 2,
      hosts: { 'pagespace.ai': { profiles: { default: { clientId: 'x' } } } },
    });
    expect(() => parseCredentialsFile(raw)).toThrow(CredentialsFileFormatError);
  });
});

describe('prototype-named profiles are ordinary data, never Object.prototype lookups', () => {
  const PROTOTYPE_NAMES = ['__proto__', 'constructor', 'toString'] as const;

  it('getHost returns null (not a prototype member) for a prototype-named profile that was never stored', () => {
    const file = upsertHost(emptyCredentialsFile(), 'pagespace.ai', CRED_A);
    for (const name of PROTOTYPE_NAMES) {
      expect(getHost(file, 'pagespace.ai', name)).toBeNull();
    }
  });

  it('getHost returns null for a prototype-named host that was never stored', () => {
    for (const name of PROTOTYPE_NAMES) {
      expect(getHost(emptyCredentialsFile(), name)).toBeNull();
    }
  });

  it('stores and reads back a prototype-named profile like any other name', () => {
    for (const name of PROTOTYPE_NAMES) {
      const file = upsertHost(emptyCredentialsFile(), 'pagespace.ai', CRED_A, name);
      expect(getHost(file, 'pagespace.ai', name)).toEqual(CRED_A);
    }
  });

  it('removeHost of a never-stored prototype-named profile is a no-op that keeps the host', () => {
    const file = upsertHost(emptyCredentialsFile(), 'pagespace.ai', CRED_A);
    for (const name of PROTOTYPE_NAMES) {
      expect(removeHost(file, 'pagespace.ai', name)).toEqual(file);
    }
  });

  it('removeHost drops a stored prototype-named profile, leaving siblings intact', () => {
    for (const name of PROTOTYPE_NAMES) {
      let file = upsertHost(emptyCredentialsFile(), 'pagespace.ai', CRED_A);
      file = upsertHost(file, 'pagespace.ai', CRED_B, name);
      const next = removeHost(file, 'pagespace.ai', name);
      expect(getHost(next, 'pagespace.ai', name)).toBeNull();
      expect(getHost(next, 'pagespace.ai')).toEqual(CRED_A);
    }
  });

  it('listSummaries neither crashes nor reports hosts for a never-stored prototype-named profile', () => {
    const file = upsertHost(emptyCredentialsFile(), 'pagespace.ai', CRED_A);
    for (const name of PROTOTYPE_NAMES) {
      expect(listSummaries(file, name)).toEqual([]);
    }
  });

  it('listSummaries reports a stored prototype-named profile normally', () => {
    for (const name of PROTOTYPE_NAMES) {
      const file = upsertHost(emptyCredentialsFile(), 'pagespace.ai', CRED_B, name);
      expect(listSummaries(file, name)).toEqual([{ host: 'pagespace.ai', tokenPrefix: tokenPrefix(CRED_B.refreshToken) }]);
    }
  });

  it('round-trips a prototype-named profile through serialize/parse without corrupting the object', () => {
    for (const name of PROTOTYPE_NAMES) {
      const file = upsertHost(emptyCredentialsFile(), 'pagespace.ai', CRED_A, name);
      const reparsed = parseCredentialsFile(serializeCredentialsFile(file));
      expect(getHost(reparsed, 'pagespace.ai', name)).toEqual(CRED_A);
      // Own data property, not a polluted prototype slot that a bracket read
      // only appears to find.
      expect(Object.hasOwn(reparsed.hosts['pagespace.ai']!.profiles, name)).toBe(true);
    }
  });
});

describe('listSummaries', () => {
  it('exposes host + tokenPrefix only, sorted by host, never the full token', () => {
    let file: CredentialsFile = emptyCredentialsFile();
    file = upsertHost(file, 'self-hosted.example', CRED_B);
    file = upsertHost(file, 'pagespace.ai', CRED_A);

    const summaries = listSummaries(file);

    expect(summaries).toEqual([
      { host: 'pagespace.ai', tokenPrefix: tokenPrefix(CRED_A.refreshToken) },
      { host: 'self-hosted.example', tokenPrefix: tokenPrefix(CRED_B.refreshToken) },
    ]);

    const serialized = JSON.stringify(summaries);
    expect(serialized).not.toContain(CRED_A.refreshToken);
    expect(serialized).not.toContain(CRED_B.refreshToken);
    expect(Object.keys(summaries[0] as object).sort()).toEqual(['host', 'tokenPrefix']);
  });
});

describe('tokenPrefix', () => {
  it('truncates to a short, non-reversible prefix', () => {
    const long = 'ps_rt_0123456789abcdefghijklmnopqrstuvwxyz';
    const prefix = tokenPrefix(long);
    expect(prefix.length).toBeLessThan(long.length);
    expect(long.startsWith(prefix)).toBe(true);
  });

  it('never grows longer than the input', () => {
    expect(tokenPrefix('short').length).toBeLessThanOrEqual('short'.length);
  });
});

describe('serializeHostCredential / parseHostCredential round-trip (keychain secret encoding)', () => {
  it('round-trips a credential', () => {
    expect(parseHostCredential(serializeHostCredential(CRED_A))).toEqual(CRED_A);
  });

  it('rejects a malformed secret', () => {
    expect(() => parseHostCredential('{"refreshToken":"x"}')).toThrow(CredentialsFileFormatError);
  });

  it('rejects non-JSON secrets', () => {
    expect(() => parseHostCredential('not json at all')).toThrow(CredentialsFileFormatError);
  });
});

describe('isSecureMode', () => {
  it('accepts 0600 (owner read/write only)', () => {
    expect(isSecureMode(0o600)).toBe(true);
  });

  it('accepts 0700 (owner-only directory)', () => {
    expect(isSecureMode(0o700)).toBe(true);
  });

  it('rejects group-readable 0640', () => {
    expect(isSecureMode(0o640)).toBe(false);
  });

  it('rejects other-readable 0604', () => {
    expect(isSecureMode(0o604)).toBe(false);
  });

  it('rejects world-writable 0666', () => {
    expect(isSecureMode(0o666)).toBe(false);
  });
});

describe('permissionFixItMessage', () => {
  it('names the offending path and a chmod fix-it, never any credential content', () => {
    const message = permissionFixItMessage('/home/user/.pagespace/credentials.json', 0o644);
    expect(message).toContain('/home/user/.pagespace/credentials.json');
    expect(message.toLowerCase()).toContain('chmod 600');
  });
});
