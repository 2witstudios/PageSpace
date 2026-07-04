import { describe, expect, it } from 'vitest';
import { isAuthenticationError } from '@pagespace/sdk';
import { buildAuthProvider, enforceAuth, FailingAuthProvider } from '../auth-context.js';
import { missingCredentialsMessage, resolveAuth } from '../resolve.js';
import type { HostCredential } from '../../credentials/serialize.js';
import { EXIT_RUNTIME_ERROR } from '../../exit-codes.js';

const HOST = 'https://pagespace.ai';

const CREDENTIAL: HostCredential = {
  refreshToken: 'ps_rt_original_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  clientId: 'pagespace-cli',
  scopes: ['account', 'offline_access'],
  createdAt: '2026-07-03T00:00:00.000Z',
};

function fakeSink() {
  const lines: string[] = [];
  return { lines, write: (chunk: string) => lines.push(chunk) };
}

function fakeStoreSpy(initial: Record<string, HostCredential> = {}) {
  const hosts = new Map(Object.entries(initial));
  const setCalls: Array<{ host: string; credential: HostCredential }> = [];
  const deleteCalls: string[] = [];
  return {
    setCalls,
    deleteCalls,
    async get(host: string) {
      return hosts.get(host) ?? null;
    },
    async set(host: string, credential: HostCredential) {
      setCalls.push({ host, credential });
      hosts.set(host, credential);
    },
    async delete(host: string) {
      deleteCalls.push(host);
      hosts.delete(host);
    },
    async list() {
      return [...hosts.keys()].map((host) => ({ host, tokenPrefix: hosts.get(host)!.refreshToken.slice(0, 12) }));
    },
  };
}

describe('buildAuthProvider — flag/env sources (static, stateless)', () => {
  it('flag source: getAccessToken resolves to the flag token and never touches discovery or the store', async () => {
    const store = fakeStoreSpy();
    let discoverCalls = 0;
    const provider = buildAuthProvider(
      { kind: 'flag', token: 'mcp_flag_token' },
      {
        discoverMetadata: async () => {
          discoverCalls += 1;
          return { authorizationEndpoint: 'x', tokenEndpoint: 'y' };
        },
        createRefreshAccessToken: () => {
          throw new Error('must not be called for a static source');
        },
        credentialStore: store,
        now: () => 0,
      },
    );

    expect(await provider.getAccessToken()).toBe('mcp_flag_token');
    expect(await provider.getAccessToken()).toBe('mcp_flag_token');
    expect(discoverCalls).toBe(0);
    expect(store.setCalls).toEqual([]);
  });

  it('env source: same statelessness guarantee as flag', async () => {
    const store = fakeStoreSpy();
    const provider = buildAuthProvider(
      { kind: 'env', token: 'mcp_env_token' },
      {
        discoverMetadata: async () => ({ authorizationEndpoint: 'x', tokenEndpoint: 'y' }),
        createRefreshAccessToken: () => {
          throw new Error('must not be called for a static source');
        },
        credentialStore: store,
        now: () => 0,
      },
    );

    expect(await provider.getAccessToken()).toBe('mcp_env_token');
    expect(store.setCalls).toEqual([]);
  });
});

describe('buildAuthProvider — profile source (silent OAuth refresh)', () => {
  it('discovers + refreshes lazily (not at construction time) and persists the rotated refresh token', async () => {
    const store = fakeStoreSpy();
    let discoverCalls = 0;
    let refreshCallArgs: { tokenEndpoint: string; clientId: string } | undefined;

    const provider = buildAuthProvider(
      { kind: 'profile', host: HOST, credential: CREDENTIAL },
      {
        discoverMetadata: async (host) => {
          discoverCalls += 1;
          expect(host).toBe(HOST);
          return { authorizationEndpoint: 'https://x/authorize', tokenEndpoint: 'https://x/token' };
        },
        createRefreshAccessToken: (tokenEndpoint, clientId) => {
          refreshCallArgs = { tokenEndpoint, clientId };
          return async (refreshToken: string) => {
            expect(refreshToken).toBe(CREDENTIAL.refreshToken);
            return {
              accessToken: 'ps_at_fresh',
              accessExpiresAt: 999_999_999,
              refreshToken: 'ps_rt_rotated',
              refreshExpiresAt: 999_999_999,
            };
          };
        },
        credentialStore: store,
        now: () => Date.parse('2026-07-03T12:00:00.000Z'),
      },
    );

    expect(discoverCalls).toBe(0);

    const token = await provider.getAccessToken();

    expect(token).toBe('ps_at_fresh');
    expect(discoverCalls).toBe(1);
    expect(refreshCallArgs).toEqual({ tokenEndpoint: 'https://x/token', clientId: CREDENTIAL.clientId });
    expect(store.setCalls).toHaveLength(1);
    expect(store.setCalls[0]).toEqual({
      host: HOST,
      credential: {
        refreshToken: 'ps_rt_rotated',
        clientId: CREDENTIAL.clientId,
        scopes: CREDENTIAL.scopes,
        createdAt: '2026-07-03T12:00:00.000Z',
      },
    });
  });

  it('a definitive refresh failure rejects getAccessToken with AuthenticationError and never persists anything', async () => {
    const store = fakeStoreSpy();
    const provider = buildAuthProvider(
      { kind: 'profile', host: HOST, credential: CREDENTIAL },
      {
        discoverMetadata: async () => ({ authorizationEndpoint: 'x', tokenEndpoint: 'y' }),
        createRefreshAccessToken: () => async () => {
          throw new Error('invalid_grant');
        },
        credentialStore: store,
        now: () => 0,
      },
    );

    await expect(provider.getAccessToken()).rejects.toSatisfy((error: unknown) => isAuthenticationError(error));
    expect(store.setCalls).toEqual([]);
  });
});

describe('buildAuthProvider — none source (fail closed)', () => {
  it('getAccessToken always rejects with the actionable, secret-free message; never touches discovery or the store', async () => {
    const store = fakeStoreSpy();
    let discoverCalls = 0;
    const provider = buildAuthProvider(
      { kind: 'none', host: HOST },
      {
        discoverMetadata: async () => {
          discoverCalls += 1;
          return { authorizationEndpoint: 'x', tokenEndpoint: 'y' };
        },
        createRefreshAccessToken: () => {
          throw new Error('must not be called');
        },
        credentialStore: store,
        now: () => 0,
      },
    );

    await expect(provider.getAccessToken()).rejects.toSatisfy(
      (error: unknown) => isAuthenticationError(error) && error.message === missingCredentialsMessage(HOST),
    );
    expect(discoverCalls).toBe(0);
    expect(store.setCalls).toEqual([]);
  });
});

describe('FailingAuthProvider', () => {
  it('invalidate() is a harmless no-op (nothing to invalidate)', () => {
    const provider = new FailingAuthProvider('no credentials');
    expect(() => provider.invalidate()).not.toThrow();
  });
});

describe('enforceAuth', () => {
  it('returns null and touches nothing when the access token resolves', async () => {
    const store = fakeStoreSpy();
    const stderr = fakeSink();
    const source = resolveAuth({ token: 'mcp_ok' }, {}, {}, HOST);
    const auth = buildAuthProvider(source, {
      discoverMetadata: async () => ({ authorizationEndpoint: 'x', tokenEndpoint: 'y' }),
      createRefreshAccessToken: () => async () => {
        throw new Error('unused');
      },
      credentialStore: store,
      now: () => 0,
    });

    const result = await enforceAuth({ auth, source, credentialStore: store, stderr });

    expect(result).toBeNull();
    expect(stderr.lines).toEqual([]);
    expect(store.deleteCalls).toEqual([]);
  });

  it('on a profile refresh failure: purges the stored credential, tells the user to re-login, exits 1', async () => {
    const store = fakeStoreSpy({ [HOST]: CREDENTIAL });
    const stderr = fakeSink();
    const source = { kind: 'profile' as const, host: HOST, credential: CREDENTIAL };
    const auth = buildAuthProvider(source, {
      discoverMetadata: async () => ({ authorizationEndpoint: 'x', tokenEndpoint: 'y' }),
      createRefreshAccessToken: () => async () => {
        throw new Error('invalid_grant');
      },
      credentialStore: store,
      now: () => 0,
    });

    const result = await enforceAuth({ auth, source, credentialStore: store, stderr });

    expect(result).toBe(EXIT_RUNTIME_ERROR);
    expect(store.deleteCalls).toEqual([HOST]);
    expect(stderr.lines.join('')).toMatch(/pagespace login/);
  });

  it('on zero credentials: exits 1 naming all three provision options, never purges, never prompts', async () => {
    const store = fakeStoreSpy();
    const stderr = fakeSink();
    const source = resolveAuth({}, {}, {}, HOST);
    const auth = buildAuthProvider(source, {
      discoverMetadata: async () => ({ authorizationEndpoint: 'x', tokenEndpoint: 'y' }),
      createRefreshAccessToken: () => {
        throw new Error('must not be called');
      },
      credentialStore: store,
      now: () => 0,
    });

    const result = await enforceAuth({ auth, source, credentialStore: store, stderr });

    expect(result).toBe(EXIT_RUNTIME_ERROR);
    expect(store.deleteCalls).toEqual([]);
    const message = stderr.lines.join('');
    expect(message).toContain('--token');
    expect(message).toContain('PAGESPACE_TOKEN');
    expect(message).toContain('pagespace login');
  });
});

describe('non-interactive posture', () => {
  it('this module never references stdin/readline/prompt — there is no interactive fallback to accidentally trigger', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(fileURLToPath(new URL('../auth-context.ts', import.meta.url)), 'utf-8');
    expect(source).not.toMatch(/process\.stdin|readline|inquirer/i);
  });
});
