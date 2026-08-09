import { describe, expect, it } from 'vitest';
import { createWhoamiHandler, credentialSecret, EXIT_RUNTIME_ERROR, EXIT_SUCCESS, parseArgv } from '@pagespace/cli';
import type { HostCredential, CredentialStore, OAuthHostCredential } from '@pagespace/cli';
import type { OAuthTokens } from '@pagespace/sdk';
import { createFakeActiveKeyStore, createFakeContext, createRecordingSink } from '../../__tests__/fake-context.js';

const CREDENTIAL: OAuthHostCredential = {
  kind: 'oauth',
  refreshToken: 'ps_rt_old',
  clientId: 'pagespace-cli',
  scopes: ['account', 'offline_access'],
  createdAt: '2026-01-01T00:00:00.000Z',
};

const REFRESHED: OAuthTokens = {
  accessToken: 'ps_at_new',
  accessExpiresAt: 999_999_999,
  refreshToken: 'ps_rt_new',
  refreshExpiresAt: 999_999_999,
};

const IDENTITY = { name: 'Ada Lovelace', email: 'ada@example.com' };

function fakeStore(initial: Map<string, HostCredential> = new Map()): CredentialStore {
  return {
    get: async (host) => initial.get(host) ?? null,
    set: async (host, credential) => {
      initial.set(host, credential);
    },
    delete: async (host) => {
      initial.delete(host);
    },
    list: async () => [...initial.entries()].map(([host, credential]) => ({ host, tokenPrefix: credentialSecret(credential).slice(0, 12) })),
  };
}

function commandIntent(argv: string[]) {
  const intent = parseArgv(argv);
  if (intent.kind !== 'command') throw new Error('expected command');
  return intent;
}

function baseDeps(store: CredentialStore) {
  return {
    createCredentialStore: () => store,
    discoverMetadata: async () => ({
      authorizationEndpoint: 'https://pagespace.ai/api/oauth/authorize',
      tokenEndpoint: 'https://pagespace.ai/api/oauth/token',
    }),
    createRefreshAccessToken: () => async () => REFRESHED,
    confirmIdentity: async () => IDENTITY,
    probeDriveCount: async () => 3,
    now: () => Date.parse('2026-07-03T00:00:00.000Z'),
  };
}

describe('createWhoamiHandler', () => {
  it('prints identity, host, and granted scopes in human-readable form', async () => {
    const store = fakeStore(new Map([['https://pagespace.ai', CREDENTIAL]]));
    const handler = createWhoamiHandler(baseDeps(store));

    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, env: {} });
    const code = await handler(ctx, commandIntent(['whoami']));

    expect(code).toBe(EXIT_SUCCESS);
    const output = stdout.lines.join('');
    expect(output).toContain('ada@example.com');
    expect(output).toContain('https://pagespace.ai');
    expect(output).toContain('account');
    expect(output).toContain('offline_access');
  });

  it('emits machine-readable JSON with --json', async () => {
    const store = fakeStore(new Map([['https://pagespace.ai', CREDENTIAL]]));
    const handler = createWhoamiHandler(baseDeps(store));

    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, env: {} });
    const code = await handler(ctx, commandIntent(['whoami', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    const parsed = JSON.parse(stdout.lines.join(''));
    expect(parsed).toEqual({
      host: 'https://pagespace.ai',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      scopes: ['account', 'offline_access'],
      activeKey: null,
      source: 'stored',
      sourceLabel: 'personal login',
      keyName: 'default',
      tokenPrefix: null,
      driveCount: null,
      personalLogin: null,
    });
  });

  it('reports the ACTIVE KEY as the source when one is set for the resolved host — human line and --json field', async () => {
    const store = fakeStore(new Map([['https://pagespace.ai', CREDENTIAL]]));
    const handler = createWhoamiHandler(baseDeps(store));

    const humanStdout = createRecordingSink();
    const humanCtx = createFakeContext({
      stdout: humanStdout,
      env: {},
      activeKeyStore: createFakeActiveKeyStore({ 'https://pagespace.ai': 'agent' }),
    });
    expect(await handler(humanCtx, commandIntent(['whoami']))).toBe(EXIT_SUCCESS);
    expect(humanStdout.lines.join('')).toContain('Source: active key "agent"');

    const jsonStdout = createRecordingSink();
    const jsonCtx = createFakeContext({
      stdout: jsonStdout,
      env: {},
      activeKeyStore: createFakeActiveKeyStore({ 'https://pagespace.ai': 'agent' }),
    });
    expect(await handler(jsonCtx, commandIntent(['whoami', '--json']))).toBe(EXIT_SUCCESS);
    expect(JSON.parse(jsonStdout.lines.join('')).activeKey).toBe('agent');
  });

  it('never reports an active key when none is set (or it is set for a different host)', async () => {
    const store = fakeStore(new Map([['https://pagespace.ai', CREDENTIAL]]));
    const handler = createWhoamiHandler(baseDeps(store));

    const stdout = createRecordingSink();
    const ctx = createFakeContext({
      stdout,
      env: {},
      activeKeyStore: createFakeActiveKeyStore({ 'https://other.example': 'agent' }),
    });
    expect(await handler(ctx, commandIntent(['whoami']))).toBe(EXIT_SUCCESS);
    expect(stdout.lines.join('')).not.toContain('active key');
  });

  // The exact machine state this command used to get wrong: a scoped key
  // activated with `pagespace keys use`, no personal login at all. Every
  // content command works; whoami said "Not logged in to ...".
  it('reports a working active key even when the "default" login slot is empty, and exits 0', async () => {
    const hosts = new Map<string, Map<string, HostCredential>>();
    const activeCredential: HostCredential = {
      kind: 'static',
      token: 'mcp_activekey123',
      scopes: ['all_drives', 'offline_access'],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    hosts.set('https://pagespace.ai', new Map([['ALL', activeCredential]]));
    const store: CredentialStore = {
      get: async (host, profile = 'default') => hosts.get(host)?.get(profile) ?? null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };
    const handler = createWhoamiHandler({ ...baseDeps(store), probeDriveCount: async () => 14 });

    const stdout = createRecordingSink();
    const ctx = createFakeContext({
      stdout,
      env: {},
      activeKeyStore: createFakeActiveKeyStore({ 'https://pagespace.ai': 'ALL' }),
    });
    const code = await handler(ctx, commandIntent(['whoami']));

    expect(code).toBe(EXIT_SUCCESS);
    const output = stdout.lines.join('');
    expect(output).toContain('Source: active key "ALL"');
    expect(output).toContain('all_drives');
    expect(output).toContain('Drives: 14 accessible');
    expect(output).toContain('Personal login: none');
    expect(output).not.toMatch(/not logged in/i);
  });

  it('reports a --token / PAGESPACE_TOKEN credential instead of ignoring it for the stored "default" slot', async () => {
    const handler = createWhoamiHandler({ ...baseDeps(fakeStore()), probeDriveCount: async () => 2 });

    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, env: {} });
    const code = await handler(ctx, commandIntent(['whoami', '--token', 'mcp_flagtoken']));

    expect(code).toBe(EXIT_SUCCESS);
    const output = stdout.lines.join('');
    expect(output).toContain('Source: --token flag');
    expect(output).toContain('Drives: 2 accessible');
  });

  it('exits 1 with an actionable message and does not prompt when no credential resolves at all', async () => {
    const store = fakeStore();
    let refreshCalls = 0;
    const handler = createWhoamiHandler({
      ...baseDeps(store),
      createRefreshAccessToken: () => async () => {
        refreshCalls += 1;
        return REFRESHED;
      },
    });

    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });
    const code = await handler(ctx, commandIntent(['whoami']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(refreshCalls).toBe(0);
    expect(stderr.lines.join('')).toMatch(/no credential resolved/i);
    expect(stderr.lines.join('')).toContain('pagespace login');
  });

  it('persists the rotated refresh token BEFORE using the new access token to confirm identity', async () => {
    const calls: string[] = [];
    const store = fakeStore(new Map([['https://pagespace.ai', CREDENTIAL]]));
    const wrappedStore: CredentialStore = {
      ...store,
      set: async (host, credential) => {
        calls.push('persist');
        await store.set(host, credential);
      },
    };
    const handler = createWhoamiHandler({
      ...baseDeps(wrappedStore),
      confirmIdentity: async () => {
        calls.push('confirm');
        return IDENTITY;
      },
    });

    const ctx = createFakeContext({ env: {} });
    const code = await handler(ctx, commandIntent(['whoami']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(calls).toEqual(['persist', 'confirm']);
    expect(credentialSecret((await wrappedStore.get('https://pagespace.ai'))!)).toBe(REFRESHED.refreshToken);
  });

  it('exits 1 and never leaks a token when the refresh grant is rejected', async () => {
    const store = fakeStore(new Map([['https://pagespace.ai', CREDENTIAL]]));
    const handler = createWhoamiHandler({
      ...baseDeps(store),
      createRefreshAccessToken: () => async () => {
        throw new Error(`rejected: ${CREDENTIAL.refreshToken}`);
      },
    });

    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });
    const code = await handler(ctx, commandIntent(['whoami']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).not.toContain(CREDENTIAL.refreshToken);
  });

  it('reports the LIVE server-granted scope from the refresh response, not the stale locally-cached scopes, when the server narrows the grant', async () => {
    const store = fakeStore(new Map([['https://pagespace.ai', CREDENTIAL]]));
    const narrowed = { ...REFRESHED, scope: 'account' };
    const handler = createWhoamiHandler({
      ...baseDeps(store),
      createRefreshAccessToken: () => async () => narrowed,
    });

    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, env: {} });
    const code = await handler(ctx, commandIntent(['whoami', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    const parsed = JSON.parse(stdout.lines.join(''));
    // CREDENTIAL.scopes still has 'offline_access' too — the live response
    // narrowed to just 'account', and that's what must be reported/persisted.
    expect(parsed.scopes).toEqual(['account']);
    expect((await store.get('https://pagespace.ai'))?.scopes).toEqual(['account']);
  });

  it('falls back to the stored scopes when the refresh response carries no scope field', async () => {
    const store = fakeStore(new Map([['https://pagespace.ai', CREDENTIAL]]));
    const handler = createWhoamiHandler(baseDeps(store));

    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, env: {} });
    const code = await handler(ctx, commandIntent(['whoami', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    const parsed = JSON.parse(stdout.lines.join(''));
    expect(parsed.scopes).toEqual(CREDENTIAL.scopes);
  });

  it('resolves the key from --key and reads/writes that slot, not "default"', async () => {
    const hosts = new Map<string, Map<string, HostCredential>>();
    hosts.set('https://pagespace.ai', new Map([['work', CREDENTIAL]]));
    const store: CredentialStore = {
      get: async (host, profile = 'default') => hosts.get(host)?.get(profile) ?? null,
      set: async (host, credential, profile = 'default') => {
        const profiles = hosts.get(host) ?? new Map<string, HostCredential>();
        profiles.set(profile, credential);
        hosts.set(host, profiles);
      },
      delete: async () => {},
      list: async () => [],
    };
    const handler = createWhoamiHandler(baseDeps(store));

    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, env: {} });
    const code = await handler(ctx, commandIntent(['whoami', '--key', 'work', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    const parsed = JSON.parse(stdout.lines.join(''));
    expect(parsed.email).toBe(IDENTITY.email);
    expect(credentialSecret((await store.get('https://pagespace.ai', 'work'))!)).toBe(REFRESHED.refreshToken);
  });

  it('exits 1 when --key names a slot with nothing stored, even though another key IS stored for the host', async () => {
    const hosts = new Map<string, Map<string, HostCredential>>();
    hosts.set('https://pagespace.ai', new Map([['default', CREDENTIAL]]));
    const store: CredentialStore = {
      get: async (host, profile = 'default') => hosts.get(host)?.get(profile) ?? null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };
    const handler = createWhoamiHandler(baseDeps(store));

    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });
    const code = await handler(ctx, commandIntent(['whoami', '--key', 'work']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    // Must name the key the user asked for, not the "default" one that happens
    // to be stored.
    expect(stderr.lines.join('')).toContain('under key "work"');
  });

  it('blames the requested --key, not a dangling active key that this invocation never consulted', async () => {
    const handler = createWhoamiHandler(baseDeps(fakeStore()));

    const stderr = createRecordingSink();
    const ctx = createFakeContext({
      stderr,
      env: {},
      activeKeyStore: createFakeActiveKeyStore({ 'https://pagespace.ai': 'ALL' }),
    });
    const code = await handler(ctx, commandIntent(['whoami', '--key', 'nope']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    const err = stderr.lines.join('');
    expect(err).toContain('under key "nope"');
    expect(err).not.toContain('ALL');
  });

  it('strips the name:<...> mint plumbing token from the human Scopes line but keeps it in --json', async () => {
    const named: HostCredential = {
      kind: 'static',
      token: 'mcp_named',
      scopes: ['name:ALL', 'all_drives', 'offline_access'],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const store = fakeStore(new Map([['https://pagespace.ai', named]]));
    const handler = createWhoamiHandler({
      ...baseDeps(store),
      confirmIdentity: async () => {
        throw new Error('must not be called for an mcp_* token');
      },
    });

    const humanStdout = createRecordingSink();
    expect(await handler(createFakeContext({ stdout: humanStdout, env: {} }), commandIntent(['whoami']))).toBe(
      EXIT_SUCCESS,
    );
    expect(humanStdout.lines.join('')).toContain('Scopes: all_drives offline_access');
    expect(humanStdout.lines.join('')).not.toContain('name:ALL');

    const jsonStdout = createRecordingSink();
    expect(
      await handler(createFakeContext({ stdout: jsonStdout, env: {} }), commandIntent(['whoami', '--json'])),
    ).toBe(EXIT_SUCCESS);
    expect(JSON.parse(jsonStdout.lines.join('')).scopes).toEqual(['name:ALL', 'all_drives', 'offline_access']);
  });

  it('never writes the access or refresh token to stdout/stderr on success', async () => {
    const store = fakeStore(new Map([['https://pagespace.ai', CREDENTIAL]]));
    const handler = createWhoamiHandler(baseDeps(store));

    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, env: {} });
    await handler(ctx, commandIntent(['whoami']));

    const allOutput = [...stdout.lines, ...stderr.lines].join('');
    expect(allOutput).not.toContain(REFRESHED.accessToken);
    expect(allOutput).not.toContain(REFRESHED.refreshToken);
    expect(allOutput).not.toContain(CREDENTIAL.refreshToken);
  });

  // `/api/auth/me` deliberately refuses `mcp_*` tokens (a scoped key is its
  // own principal and must not surface the owner's email), so asking it for an
  // identity could only ever 401 — which is exactly what whoami used to do,
  // reporting a live key as "invalidated".
  it('a static (mcp) credential reports its stored scopes and proves liveness with a drives probe — never an identity call, no refresh grant, no discovery, no store write', async () => {
    const staticCredential: HostCredential = { kind: 'static', token: 'mcp_abc123', scopes: ['drive:d1:member', 'offline_access'], createdAt: '2026-01-01T00:00:00.000Z' };
    const store = fakeStore(new Map([['https://pagespace.ai', staticCredential]]));
    let discoverCalls = 0;
    let probeAccessToken: string | undefined;
    const setCalls: unknown[] = [];
    const wrappedStore: CredentialStore = {
      ...store,
      set: async (...args) => {
        setCalls.push(args);
        return store.set(...args);
      },
    };
    const handler = createWhoamiHandler({
      createCredentialStore: () => wrappedStore,
      discoverMetadata: async () => {
        discoverCalls += 1;
        throw new Error('must not be called for a static credential');
      },
      createRefreshAccessToken: () => {
        throw new Error('must not be called for a static credential — mcp_* tokens never refresh');
      },
      confirmIdentity: async () => {
        throw new Error('must not be called for an mcp_* token — /api/auth/me refuses it by design');
      },
      probeDriveCount: async ({ accessToken }) => {
        probeAccessToken = accessToken;
        return 7;
      },
      now: () => Date.parse('2026-07-03T00:00:00.000Z'),
    });

    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, env: {} });
    const code = await handler(ctx, commandIntent(['whoami', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(discoverCalls).toBe(0);
    expect(setCalls).toEqual([]);
    expect(probeAccessToken).toBe('mcp_abc123');
    const parsed = JSON.parse(stdout.lines.join(''));
    expect(parsed.scopes).toEqual(['drive:d1:member', 'offline_access']);
    expect(parsed.driveCount).toBe(7);
    expect(parsed.name).toBeNull();
  });

  it('exits 1 pointing at re-minting (not re-login) when a static key is rejected by the probe', async () => {
    const staticCredential: HostCredential = { kind: 'static', token: 'mcp_revoked', scopes: ['drive:d1:member'], createdAt: '2026-01-01T00:00:00.000Z' };
    const store = fakeStore(new Map([['https://pagespace.ai', staticCredential]]));
    const handler = createWhoamiHandler({
      ...baseDeps(store),
      confirmIdentity: async () => {
        throw new Error('must not be called for an mcp_* token');
      },
      probeDriveCount: async () => {
        throw new Error('401 Unauthorized');
      },
    });

    const stderr = createRecordingSink();
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, env: {} });
    const code = await handler(ctx, commandIntent(['whoami']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    const err = stderr.lines.join('');
    expect(err).toContain('keys create');
    expect(err).not.toContain('mcp_revoked');
  });
});
