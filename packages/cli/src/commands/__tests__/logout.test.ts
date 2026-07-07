import { describe, expect, it } from 'vitest';
import { createLogoutHandler, credentialSecret, EXIT_RUNTIME_ERROR, EXIT_SUCCESS, formatLogoutLine, parseArgv, summarizeLogout } from '@pagespace/cli';
import type { HostCredential, CredentialStore, OAuthHostCredential, RevokeResult, RevokeToken } from '@pagespace/cli';
import { createFakeContext, createRecordingSink } from '../../__tests__/fake-context.js';

const CREDENTIAL: OAuthHostCredential = {
  kind: 'oauth',
  refreshToken: 'ps_rt_test-refresh-token',
  clientId: 'pagespace-cli',
  scopes: ['account', 'offline_access'],
  createdAt: '2026-01-01T00:00:00.000Z',
};

function fakeStore(initial: Map<string, HostCredential> = new Map()): CredentialStore {
  return {
    get: async (host) => initial.get(host) ?? null,
    set: async (host, credential) => {
      initial.set(host, credential);
    },
    delete: async (host) => {
      initial.delete(host);
    },
    list: async () =>
      [...initial.entries()]
        .map(([host, credential]) => ({ host, tokenPrefix: credentialSecret(credential).slice(0, 12) }))
        .sort((a, b) => a.host.localeCompare(b.host)),
  };
}

function commandIntent(argv: string[]) {
  const intent = parseArgv(argv);
  if (intent.kind !== 'command') throw new Error('expected command');
  return intent;
}

describe('createLogoutHandler', () => {
  it('calls revokeToken BEFORE deleting the local credential (zero-trust ordering)', async () => {
    const calls: string[] = [];
    const store = fakeStore(new Map([['https://pagespace.ai', CREDENTIAL]]));
    const originalDelete = store.delete.bind(store);
    const wrappedStore: CredentialStore = {
      ...store,
      delete: async (host) => {
        calls.push('delete');
        await originalDelete(host);
      },
    };
    const revokeToken: RevokeToken = async () => {
      calls.push('revoke');
      return { outcome: 'revoked' };
    };

    const handler = createLogoutHandler({ createCredentialStore: () => wrappedStore, revokeToken });
    const ctx = createFakeContext({ env: {} });
    const code = await handler(ctx, commandIntent(['logout']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(calls).toEqual(['revoke', 'delete']);
    expect(await wrappedStore.get('https://pagespace.ai')).toBeNull();
  });

  it('never deletes the local credential when revocation fails and --force is absent', async () => {
    const store = fakeStore(new Map([['https://pagespace.ai', CREDENTIAL]]));
    const revokeToken: RevokeToken = async () => ({ outcome: 'failed', message: 'network_error: ECONNRESET' });
    const handler = createLogoutHandler({ createCredentialStore: () => store, revokeToken });

    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });
    const code = await handler(ctx, commandIntent(['logout']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(await store.get('https://pagespace.ai')).not.toBeNull();
    expect(stderr.lines.join('')).toMatch(/--force/);
    expect(stderr.lines.join('')).not.toContain(CREDENTIAL.refreshToken);
  });

  it('deletes the local credential when revocation fails but --force is given, and still exits 0', async () => {
    const store = fakeStore(new Map([['https://pagespace.ai', CREDENTIAL]]));
    const revokeToken: RevokeToken = async () => ({ outcome: 'failed', message: 'network_error: ECONNRESET' });
    const handler = createLogoutHandler({ createCredentialStore: () => store, revokeToken });

    const ctx = createFakeContext({ env: {} });
    const code = await handler(ctx, commandIntent(['logout', '--force']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(await store.get('https://pagespace.ai')).toBeNull();
  });

  it('reports "not logged in" for a host with no stored credential, without attempting revocation', async () => {
    let revokeCalls = 0;
    const store = fakeStore();
    const revokeToken: RevokeToken = async () => {
      revokeCalls += 1;
      return { outcome: 'revoked' };
    };
    const handler = createLogoutHandler({ createCredentialStore: () => store, revokeToken });

    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, env: {} });
    const code = await handler(ctx, commandIntent(['logout']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(revokeCalls).toBe(0);
    expect(stdout.lines.join('')).toMatch(/not logged in/i);
  });

  it('--all iterates every stored profile, continues on individual failures, and reports per-host outcomes', async () => {
    const store = fakeStore(
      new Map([
        ['https://pagespace.ai', CREDENTIAL],
        ['https://self-hosted.example', { ...CREDENTIAL, refreshToken: 'ps_rt_other' }],
      ]),
    );
    const revokeToken: RevokeToken = async (params) => {
      if (params.host === 'https://self-hosted.example') {
        return { outcome: 'failed', message: 'http_503' };
      }
      return { outcome: 'revoked' };
    };
    const handler = createLogoutHandler({ createCredentialStore: () => store, revokeToken });

    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, env: {} });
    const code = await handler(ctx, commandIntent(['logout', '--all']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(await store.get('https://pagespace.ai')).toBeNull();
    expect(await store.get('https://self-hosted.example')).not.toBeNull();
    expect(stdout.lines.join('')).toContain('pagespace.ai');
    expect(stderr.lines.join('')).toContain('self-hosted.example');
  });

  it('--all with no stored profiles exits 0 with an informational message', async () => {
    const store = fakeStore();
    const handler = createLogoutHandler({ createCredentialStore: () => store, revokeToken: async () => ({ outcome: 'revoked' }) });

    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, env: {} });
    const code = await handler(ctx, commandIntent(['logout', '--all']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).toMatch(/no stored credentials/i);
  });

  it('never writes the refresh token to stdout or stderr in any outcome', async () => {
    const store = fakeStore(new Map([['https://pagespace.ai', CREDENTIAL]]));
    const revokeToken: RevokeToken = async () => ({ outcome: 'failed', message: 'network_error: ECONNRESET' });
    const handler = createLogoutHandler({ createCredentialStore: () => store, revokeToken });

    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, env: {} });
    await handler(ctx, commandIntent(['logout']));

    const allOutput = [...stdout.lines, ...stderr.lines].join('');
    expect(allOutput).not.toContain(CREDENTIAL.refreshToken);
  });

  it('a static (mcp) credential is forgotten locally without calling revokeToken — the mcp_* key itself stays valid until "pagespace keys revoke" or Settings > MCP explicitly revokes it', async () => {
    const staticCredential: HostCredential = { kind: 'static', token: 'mcp_abc123', scopes: ['drive:d1:member'], createdAt: '2026-01-01T00:00:00.000Z' };
    const store = fakeStore(new Map([['https://pagespace.ai', staticCredential]]));
    let revokeCalls = 0;
    const revokeToken: RevokeToken = async () => {
      revokeCalls += 1;
      return { outcome: 'revoked' };
    };
    const handler = createLogoutHandler({ createCredentialStore: () => store, revokeToken });

    const ctx = createFakeContext({ env: {} });
    const code = await handler(ctx, commandIntent(['logout']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(revokeCalls).toBe(0);
    expect(await store.get('https://pagespace.ai')).toBeNull();
  });
});

describe('createLogoutHandler — named profiles', () => {
  function profileAwareStore(): CredentialStore & { readonly calls: Array<{ op: string; host: string; profile: string | undefined }> } {
    const hosts = new Map<string, Map<string, HostCredential>>();
    const calls: Array<{ op: string; host: string; profile: string | undefined }> = [];
    return {
      calls,
      get: async (host, profile = 'default') => {
        calls.push({ op: 'get', host, profile });
        return hosts.get(host)?.get(profile) ?? null;
      },
      set: async (host, credential, profile = 'default') => {
        const profiles = hosts.get(host) ?? new Map<string, HostCredential>();
        profiles.set(profile, credential);
        hosts.set(host, profiles);
      },
      delete: async (host, profile = 'default') => {
        calls.push({ op: 'delete', host, profile });
        hosts.get(host)?.delete(profile);
      },
      list: async (profile = 'default') =>
        [...hosts.entries()]
          .filter(([, profiles]) => profiles.has(profile))
          .map(([host, profiles]) => ({ host, tokenPrefix: credentialSecret(profiles.get(profile)!).slice(0, 12) })),
    };
  }

  it('--profile logs out only the named profile, leaving "default" for the same host untouched', async () => {
    const store = profileAwareStore();
    await store.set('https://pagespace.ai', CREDENTIAL, 'default');
    await store.set('https://pagespace.ai', { ...CREDENTIAL, refreshToken: 'ps_rt_work' }, 'work');
    const revokeToken: RevokeToken = async () => ({ outcome: 'revoked' });
    const handler = createLogoutHandler({ createCredentialStore: () => store, revokeToken });

    const ctx = createFakeContext({ env: {} });
    const code = await handler(ctx, commandIntent(['logout', '--profile', 'work']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(await store.get('https://pagespace.ai', 'work')).toBeNull();
    expect(await store.get('https://pagespace.ai', 'default')).not.toBeNull();
  });

  it('PAGESPACE_PROFILE env selects the profile when --profile is absent', async () => {
    const store = profileAwareStore();
    await store.set('https://pagespace.ai', CREDENTIAL, 'work');
    const revokeToken: RevokeToken = async () => ({ outcome: 'revoked' });
    const handler = createLogoutHandler({ createCredentialStore: () => store, revokeToken });

    const ctx = createFakeContext({ env: { PAGESPACE_PROFILE: 'work' } });
    const code = await handler(ctx, commandIntent(['logout']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(await store.get('https://pagespace.ai', 'work')).toBeNull();
  });

  it('--all with --profile only iterates hosts that have that named profile stored', async () => {
    const store = profileAwareStore();
    await store.set('https://pagespace.ai', CREDENTIAL, 'work');
    await store.set('https://self-hosted.example', CREDENTIAL, 'default');
    const revokeToken: RevokeToken = async () => ({ outcome: 'revoked' });
    const handler = createLogoutHandler({ createCredentialStore: () => store, revokeToken });

    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, env: {} });
    const code = await handler(ctx, commandIntent(['logout', '--all', '--profile', 'work']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).toContain('pagespace.ai');
    expect(stdout.lines.join('')).not.toContain('self-hosted.example');
  });
});

describe('formatLogoutLine (pure)', () => {
  it('formats each outcome kind distinctly', () => {
    expect(formatLogoutLine({ host: 'h', kind: 'not_logged_in' })).toMatch(/not logged in/i);
    expect(formatLogoutLine({ host: 'h', kind: 'revoked' })).toMatch(/logged out/i);
    expect(formatLogoutLine({ host: 'h', kind: 'forced', reason: 'http_503' })).toMatch(/force/i);
    expect(formatLogoutLine({ host: 'h', kind: 'revoke_failed', reason: 'http_503' })).toMatch(/could not log out/i);
  });
});

describe('summarizeLogout (pure)', () => {
  it('exits 0 when every outcome is not_logged_in/revoked/forced', () => {
    expect(
      summarizeLogout([
        { host: 'a', kind: 'revoked' },
        { host: 'b', kind: 'not_logged_in' },
        { host: 'c', kind: 'forced', reason: 'http_503' },
      ]),
    ).toBe(EXIT_SUCCESS);
  });

  it('exits 1 when any outcome is revoke_failed', () => {
    expect(
      summarizeLogout([
        { host: 'a', kind: 'revoked' },
        { host: 'b', kind: 'revoke_failed', reason: 'http_503' },
      ]),
    ).toBe(EXIT_RUNTIME_ERROR);
  });
});

describe('RevokeResult type sanity', () => {
  it('accepts a revoked or failed shape', () => {
    const ok: RevokeResult = { outcome: 'revoked' };
    const bad: RevokeResult = { outcome: 'failed', message: 'x' };
    expect(ok.outcome).toBe('revoked');
    expect(bad.outcome).toBe('failed');
  });
});
