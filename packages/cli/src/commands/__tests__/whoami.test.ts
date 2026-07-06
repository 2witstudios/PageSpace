import { describe, expect, it } from 'vitest';
import { createWhoamiHandler, EXIT_RUNTIME_ERROR, EXIT_SUCCESS, parseArgv } from '@pagespace/cli';
import type { HostCredential, CredentialStore } from '@pagespace/cli';
import type { OAuthTokens } from '@pagespace/sdk';
import { createFakeContext, createRecordingSink } from '../../__tests__/fake-context.js';

const CREDENTIAL: HostCredential = {
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
    list: async () => [...initial.entries()].map(([host, credential]) => ({ host, tokenPrefix: credential.refreshToken.slice(0, 12) })),
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
    });
  });

  it('exits 1 with "not logged in" and does not prompt when no credential is stored', async () => {
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
    expect(stderr.lines.join('')).toMatch(/not logged in/i);
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
    expect((await wrappedStore.get('https://pagespace.ai'))?.refreshToken).toBe(REFRESHED.refreshToken);
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

  it('resolves the profile from --profile and reads/writes that profile, not "default"', async () => {
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
    const code = await handler(ctx, commandIntent(['whoami', '--profile', 'work', '--json']));

    expect(code).toBe(EXIT_SUCCESS);
    const parsed = JSON.parse(stdout.lines.join(''));
    expect(parsed.email).toBe(IDENTITY.email);
    expect((await store.get('https://pagespace.ai', 'work'))?.refreshToken).toBe(REFRESHED.refreshToken);
  });

  it('exits 1 "not logged in" when only a different profile is stored for the host', async () => {
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
    const code = await handler(ctx, commandIntent(['whoami', '--profile', 'work']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toMatch(/not logged in/i);
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
});
