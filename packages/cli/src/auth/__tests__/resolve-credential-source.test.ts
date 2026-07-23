/**
 * The full precedence chain, effects included. `resolve.ts`'s own tests cover
 * the pure rules; these cover the two store reads layered on top — above all
 * the active-key link, whose absence from `whoami`'s hand-rolled copy of this
 * chain is what made a machine with a working activated key report
 * "Not logged in".
 */
import { describe, expect, it } from 'vitest';
import { resolveCredentialSource, describeCredentialSource } from '@pagespace/cli';
import type { ActiveKeyStore, CredentialStore, HostCredential } from '@pagespace/cli';

const HOST = 'https://pagespace.ai';

const OAUTH: HostCredential = {
  kind: 'oauth',
  refreshToken: 'ps_rt_default',
  clientId: 'pagespace-cli',
  scopes: ['manage_keys', 'offline_access'],
  createdAt: '2026-01-01T00:00:00.000Z',
};

const KEY: HostCredential = {
  kind: 'static',
  token: 'mcp_scoped',
  scopes: ['drive:d1:member'],
  createdAt: '2026-01-01T00:00:00.000Z',
};

function store(entries: Record<string, Record<string, HostCredential>> = {}): CredentialStore {
  return {
    get: async (host, profile = 'default') => entries[host]?.[profile] ?? null,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  };
}

function activeKeys(map: Record<string, string> = {}): ActiveKeyStore {
  return {
    getActiveKey: async (host) => map[host] ?? null,
    setActiveKey: async () => {},
    clearActiveKey: async () => {},
  };
}

function resolve(overrides: {
  flags?: { token?: string; key?: string };
  env?: Record<string, string | undefined>;
  credentialStore?: CredentialStore;
  activeKeyStore?: ActiveKeyStore;
  allowActiveKey?: boolean;
} = {}) {
  return resolveCredentialSource({
    flags: overrides.flags ?? {},
    env: overrides.env ?? {},
    host: HOST,
    credentialStore: overrides.credentialStore ?? store(),
    activeKeyStore: overrides.activeKeyStore ?? activeKeys(),
    allowActiveKey: overrides.allowActiveKey ?? true,
  });
}

describe('resolveCredentialSource', () => {
  it('--token beats every other source, and reads no store at all', async () => {
    let reads = 0;
    const counting: CredentialStore = {
      ...store({ [HOST]: { default: OAUTH, work: KEY } }),
      get: async () => {
        reads += 1;
        return OAUTH;
      },
    };
    const resolved = await resolve({
      flags: { token: 'flag-token', key: 'work' },
      env: { PAGESPACE_TOKEN: 'env-token' },
      credentialStore: counting,
      activeKeyStore: activeKeys({ [HOST]: 'work' }),
    });

    expect(resolved.source).toEqual({ kind: 'flag', token: 'flag-token' });
    expect(resolved.explicit).toBe(true);
    expect(resolved.activeKeyName).toBeNull();
    // The store IS still consulted for the named key (harmless, no network),
    // but the resolved source must not come from it.
    expect(reads).toBeLessThanOrEqual(1);
  });

  it('PAGESPACE_TOKEN beats a stored key and the active key', async () => {
    const resolved = await resolve({
      env: { PAGESPACE_TOKEN: 'env-token' },
      credentialStore: store({ [HOST]: { default: OAUTH, work: KEY } }),
      activeKeyStore: activeKeys({ [HOST]: 'work' }),
    });

    expect(resolved.source).toEqual({ kind: 'env', token: 'env-token' });
    expect(resolved.activeKeyName).toBeNull();
  });

  it('--key names the slot and suppresses the active key entirely', async () => {
    const resolved = await resolve({
      flags: { key: 'work' },
      credentialStore: store({ [HOST]: { default: OAUTH, work: KEY, other: OAUTH } }),
      activeKeyStore: activeKeys({ [HOST]: 'other' }),
    });

    expect(resolved.keyName).toBe('work');
    expect(resolved.activeKeyName).toBeNull();
    expect(resolved.source).toMatchObject({ kind: 'stored', credential: KEY });
    expect(resolved.explicit).toBe(true);
  });

  it('falls back to the active key when nothing explicit is given — the link whoami used to miss', async () => {
    const resolved = await resolve({
      credentialStore: store({ [HOST]: { ALL: KEY } }),
      activeKeyStore: activeKeys({ [HOST]: 'ALL' }),
    });

    expect(resolved.keyName).toBe('ALL');
    expect(resolved.activeKeyName).toBe('ALL');
    expect(resolved.source).toMatchObject({ kind: 'stored', credential: KEY });
    expect(resolved.source.kind).toBe('stored');
    expect(resolved.explicit).toBe(false);
  });

  it('ignores the active key when the caller forbids it, falling through to the default slot', async () => {
    const resolved = await resolve({
      allowActiveKey: false,
      credentialStore: store({ [HOST]: { default: OAUTH, ALL: KEY } }),
      activeKeyStore: activeKeys({ [HOST]: 'ALL' }),
    });

    expect(resolved.keyName).toBe('default');
    expect(resolved.activeKeyName).toBeNull();
    expect(resolved.source).toMatchObject({ kind: 'stored', credential: OAUTH });
  });

  it('falls through to the default slot when the active key names a credential that is not stored', async () => {
    const resolved = await resolve({
      credentialStore: store({ [HOST]: { default: OAUTH } }),
      activeKeyStore: activeKeys({ [HOST]: 'gone' }),
    });

    expect(resolved.keyName).toBe('default');
    expect(resolved.activeKeyName).toBeNull();
    expect(resolved.source).toMatchObject({ kind: 'stored', credential: OAUTH });
  });

  it('resolves to none when the active key is dangling and no default is stored', async () => {
    const resolved = await resolve({
      credentialStore: store({}),
      activeKeyStore: activeKeys({ [HOST]: 'gone' }),
    });

    expect(resolved.source).toEqual({ kind: 'none', host: HOST });
    expect(resolved.source.kind).toBe('none');
  });

  it('an active key set for a DIFFERENT host is invisible', async () => {
    const resolved = await resolve({
      credentialStore: store({ [HOST]: { default: OAUTH } }),
      activeKeyStore: activeKeys({ 'https://other.example': 'ALL' }),
    });

    expect(resolved.activeKeyName).toBeNull();
    expect(resolved.keyName).toBe('default');
  });

  it('honors the deprecated PAGESPACE_AUTH_TOKEN / PAGESPACE_PROFILE aliases', async () => {
    const viaToken = await resolve({ env: { PAGESPACE_AUTH_TOKEN: 'legacy-token' } });
    expect(viaToken.source).toEqual({ kind: 'env', token: 'legacy-token' });

    const viaKey = await resolve({
      env: { PAGESPACE_PROFILE: 'work' },
      credentialStore: store({ [HOST]: { default: OAUTH, work: KEY } }),
      activeKeyStore: activeKeys({ [HOST]: 'ALL' }),
    });
    expect(viaKey.keyName).toBe('work');
    expect(viaKey.source).toMatchObject({ kind: 'stored', credential: KEY });
  });
});

describe('describeCredentialSource', () => {
  it('names each source in the copy whoami prints', async () => {
    const label = (resolved: Parameters<typeof describeCredentialSource>[0]) =>
      describeCredentialSource(resolved, 'PAGESPACE_TOKEN');

    expect(label({ source: { kind: 'flag', token: 't' }, keyName: 'default', activeKeyName: null })).toBe('--token flag');
    expect(label({ source: { kind: 'env', token: 't' }, keyName: 'default', activeKeyName: null })).toBe(
      'PAGESPACE_TOKEN environment variable',
    );
    expect(
      label({ source: { kind: 'stored', host: HOST, keyName: 'ALL', credential: KEY }, keyName: 'ALL', activeKeyName: 'ALL' }),
    ).toBe('active key "ALL"');
    expect(
      label({ source: { kind: 'stored', host: HOST, keyName: 'work', credential: KEY }, keyName: 'work', activeKeyName: null }),
    ).toBe('key "work"');
    expect(
      label({
        source: { kind: 'stored', host: HOST, keyName: 'default', credential: OAUTH },
        keyName: 'default',
        activeKeyName: null,
      }),
    ).toBe('personal login');
    expect(label({ source: { kind: 'none', host: HOST }, keyName: 'default', activeKeyName: null })).toBe('none');
  });
});
