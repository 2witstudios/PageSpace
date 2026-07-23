import { describe, expect, it, vi } from 'vitest';
import type { PageSpaceClient } from '@pagespace/sdk';
import type { CredentialStore, HostCredential, LoopbackCallback, LoopbackServer } from '@pagespace/cli';
import { parseArgv } from '../../../argv/parse.js';
import type { CommandIntent } from '../../../argv/parse.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../../exit-codes.js';
import { credentialSecret } from '../../../credentials/serialize.js';
import { createFakeActiveKeyStore, createFakeContext, createRecordingSink } from '../../../__tests__/fake-context.js';
import { createKeysUseHandler, findServerTokenId } from '../use.js';

const HOST = 'https://pagespace.ai';

const STATIC_KEY: HostCredential = {
  kind: 'static',
  token: 'mcp_abcdefghijk_full_secret_value',
  scopes: ['drive:drv1:member'],
  createdAt: '2026-07-01T00:00:00.000Z',
};

const LOGIN_CREDENTIAL: HostCredential = {
  kind: 'oauth',
  refreshToken: 'ps_rt_login_secret',
  clientId: 'pagespace-cli',
  scopes: ['manage_keys', 'offline_access'],
  createdAt: '2026-07-01T00:00:00.000Z',
};

const SERVER_KEYS = [
  {
    id: 'tok1',
    name: 'CI bot',
    tokenPrefix: 'mcp_abcdefghijk',
    lastUsed: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    isScoped: true,
    driveScopes: [{ id: 'drv1', name: 'Engineering' }],
  },
  {
    id: 'tok2',
    name: 'Other key',
    tokenPrefix: 'mcp_zzzzzzzzzzz',
    lastUsed: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    isScoped: false,
    driveScopes: [],
  },
];

function commandIntent(argv: string[]): CommandIntent {
  const parsed = parseArgv(argv);
  if (parsed.kind !== 'command') throw new Error('expected command');
  return { ...parsed, args: parsed.args.slice(2) };
}

function fakeStore(entries: Record<string, HostCredential> = {}): CredentialStore {
  const hosts = new Map<string, Map<string, HostCredential>>([[HOST, new Map(Object.entries(entries))]]);
  return {
    get: async (host, profile = 'default') => hosts.get(host)?.get(profile) ?? null,
    set: async (host, credential, profile = 'default') => {
      const profiles = hosts.get(host) ?? new Map<string, HostCredential>();
      profiles.set(profile, credential);
      hosts.set(host, profiles);
    },
    delete: async (host, profile = 'default') => {
      hosts.get(host)?.delete(profile);
    },
    list: async (profile = 'default') =>
      [...hosts.entries()]
        .filter(([, profiles]) => profiles.has(profile))
        .map(([host, profiles]) => ({ host, tokenPrefix: credentialSecret(profiles.get(profile)!).slice(0, 12) })),
    listCredentialNames: async (host) => [...(hosts.get(host)?.keys() ?? [])].sort(),
  };
}

function fakeLoopbackServer(port = 55555) {
  let pendingResolve: ((cb: LoopbackCallback) => void) | null = null;
  let buffered: LoopbackCallback | null = null;
  const server: LoopbackServer = {
    port,
    nextCallback: () => {
      if (buffered) {
        const callback = buffered;
        buffered = null;
        return Promise.resolve(callback);
      }
      return new Promise((resolve) => {
        pendingResolve = resolve;
      });
    },
    finish: async () => {},
    close: async () => {},
  };
  return {
    server,
    deliver: (query: Record<string, string>) => {
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve({ query });
      } else {
        buffered = { query };
      }
    },
  };
}

function autoApprove(fake: ReturnType<typeof fakeLoopbackServer>) {
  return async (url: string) => {
    const state = new URL(url).searchParams.get('state')!;
    queueMicrotask(() => fake.deliver({ code: 'auth-code', state }));
    return true;
  };
}

function baseDeps(store: CredentialStore, fake = fakeLoopbackServer()) {
  return {
    fake,
    deps: {
      createCredentialStore: () => store,
      randomBytes: (n: number) => new Uint8Array(n).fill(7),
      discoverMetadata: async () => ({
        authorizationEndpoint: 'https://pagespace.ai/api/oauth/authorize',
        tokenEndpoint: 'https://pagespace.ai/api/oauth/token',
      }),
      startServer: async () => fake.server,
      openBrowser: autoApprove(fake),
      waitMs: () => new Promise<void>(() => {}),
      exchangeCode: async () => ({ kind: 'mcp_activate' as const, tokenId: 'tok1', scope: 'activate_key:tok1' }),
      confirmIdentity: async () => ({ name: 'Ada Lovelace', email: 'ada@example.com' }),
      requestDeviceAuthorization: async () => {
        throw new Error('device flow not exercised by this test — loopback transport expected');
      },
      pollDeviceToken: async () => {
        throw new Error('device flow not exercised by this test — loopback transport expected');
      },
      createIsInterrupted: () => () => false,
      deviceWaitMs: async () => {},
      now: () => Date.parse('2026-07-07T00:00:00.000Z'),
    },
  };
}

function fakeSdk(invoke: ReturnType<typeof vi.fn>): PageSpaceClient {
  return { invoke } as unknown as PageSpaceClient;
}

describe('findServerTokenId', () => {
  it('matches the server row whose tokenPrefix prefixes the stored token', () => {
    expect(findServerTokenId(SERVER_KEYS, STATIC_KEY)).toBe('tok1');
  });

  it('returns null when nothing matches', () => {
    expect(findServerTokenId(SERVER_KEYS, { ...STATIC_KEY, token: 'mcp_unrelated_token' })).toBeNull();
  });

  it('returns null against an empty server list', () => {
    expect(findServerTokenId([], STATIC_KEY)).toBeNull();
  });
});

describe('createKeysUseHandler — argument validation', () => {
  it('rejects a missing name/--off with a usage error showing both forms', async () => {
    const { deps } = baseDeps(fakeStore());
    const handler = createKeysUseHandler(deps);
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr });

    const code = await handler(ctx, commandIntent(['keys', 'use']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.lines.join('')).toContain('keys use <name>');
    expect(stderr.lines.join('')).toContain('keys use --off');
  });

  it('rejects a name that is not stored for the host', async () => {
    const { deps } = baseDeps(fakeStore());
    const handler = createKeysUseHandler(deps);
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr });

    const code = await handler(ctx, commandIntent(['keys', 'use', 'ghost']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.lines.join('')).toContain('No key named "ghost" is stored for https://pagespace.ai.');
    expect(stderr.lines.join('')).toContain('pagespace keys');
  });

  it('rejects an oauth-kind credential (a login credential, e.g. "default") — only static keys activate', async () => {
    const { deps } = baseDeps(fakeStore({ default: LOGIN_CREDENTIAL }));
    const handler = createKeysUseHandler(deps);
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr });

    const code = await handler(ctx, commandIntent(['keys', 'use', 'default']));

    expect(code).toBe(EXIT_USAGE_ERROR);
    expect(stderr.lines.join('')).toContain(
      '"default" is a login credential, not an access key — only keys minted by "pagespace keys" can be activated.',
    );
  });
});

describe('createKeysUseHandler — activation happy path', () => {
  it('resolves the server tokenId by prefix, runs the activate_key consent, and records the activation locally', async () => {
    const store = fakeStore({ agent: STATIC_KEY });
    const fake = fakeLoopbackServer();
    let requestedScope: string | undefined;
    const { deps } = baseDeps(store, fake);
    const handler = createKeysUseHandler({
      ...deps,
      openBrowser: async (url: string) => {
        requestedScope = new URL(url).searchParams.get('scope') ?? undefined;
        return autoApprove(fake)(url);
      },
    });

    const invoke = vi.fn(async () => SERVER_KEYS);
    const activeKeyStore = createFakeActiveKeyStore();
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk(invoke), activeKeyStore, stdout });

    const code = await handler(ctx, commandIntent(['keys', 'use', 'agent']));

    expect(code).toBe(EXIT_SUCCESS);
    // The consent carried activate_key:<tokenId> as the SOLE scope.
    expect(requestedScope).toBe('activate_key:tok1');
    // The activation was recorded for exactly this host + LOCAL name.
    expect(activeKeyStore.entries.get(HOST)).toBe('agent');
    const output = stdout.lines.join('');
    expect(output).toContain('"agent" is now the active key for https://pagespace.ai.');
    expect(output).toContain('--key/PAGESPACE_KEY/--token');
    expect(output).toContain('pagespace keys use --off');
  });

  it('persists NOTHING to the credential store on activation — the ceremony mints no secret', async () => {
    const store = fakeStore({ agent: STATIC_KEY });
    const setSpy = vi.fn(store.set);
    const spiedStore: CredentialStore = { ...store, set: setSpy };
    const { deps } = baseDeps(spiedStore);
    const handler = createKeysUseHandler(deps);
    const ctx = createFakeContext({ sdk: fakeSdk(vi.fn(async () => SERVER_KEYS)) });

    const code = await handler(ctx, commandIntent(['keys', 'use', 'agent']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('createKeysUseHandler — failure paths', () => {
  it('a key with no matching server row (revoked) fails with a keys-list pointer and records nothing', async () => {
    const store = fakeStore({ agent: { ...STATIC_KEY, token: 'mcp_no_longer_on_server' } });
    const { deps } = baseDeps(store);
    const handler = createKeysUseHandler(deps);
    const stderr = createRecordingSink();
    const activeKeyStore = createFakeActiveKeyStore();
    const ctx = createFakeContext({ sdk: fakeSdk(vi.fn(async () => SERVER_KEYS)), stderr, activeKeyStore });

    const code = await handler(ctx, commandIntent(['keys', 'use', 'agent']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('may have been revoked');
    expect(stderr.lines.join('')).toContain('pagespace keys list');
    expect(activeKeyStore.entries.size).toBe(0);
  });

  it('a failed server lookup surfaces the error without opening a browser', async () => {
    const store = fakeStore({ agent: STATIC_KEY });
    const fake = fakeLoopbackServer();
    let browserOpened = false;
    const { deps } = baseDeps(store, fake);
    const handler = createKeysUseHandler({
      ...deps,
      openBrowser: async () => {
        browserOpened = true;
        return true;
      },
    });
    const stderr = createRecordingSink();
    const ctx = createFakeContext({
      sdk: fakeSdk(
        vi.fn(async () => {
          throw new Error('server unreachable');
        }),
      ),
      stderr,
    });

    const code = await handler(ctx, commandIntent(['keys', 'use', 'agent']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('server unreachable');
    expect(browserOpened).toBe(false);
  });

  it('a denied consent fails without recording an activation', async () => {
    const store = fakeStore({ agent: STATIC_KEY });
    const fake = fakeLoopbackServer();
    const { deps } = baseDeps(store, fake);
    const handler = createKeysUseHandler({
      ...deps,
      openBrowser: async (url: string) => {
        const state = new URL(url).searchParams.get('state')!;
        queueMicrotask(() => fake.deliver({ error: 'access_denied', state }));
        return true;
      },
    });
    const stderr = createRecordingSink();
    const activeKeyStore = createFakeActiveKeyStore();
    const ctx = createFakeContext({ sdk: fakeSdk(vi.fn(async () => SERVER_KEYS)), stderr, activeKeyStore });

    const code = await handler(ctx, commandIntent(['keys', 'use', 'agent']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toMatch(/denied/i);
    expect(activeKeyStore.entries.size).toBe(0);
  });

  it('fails closed when the server answers the activation with a surprise mint — nothing stored, nothing activated', async () => {
    const store = fakeStore({ agent: STATIC_KEY });
    const setSpy = vi.fn(store.set);
    const spiedStore: CredentialStore = { ...store, set: setSpy };
    const { deps } = baseDeps(spiedStore);
    const handler = createKeysUseHandler({
      ...deps,
      exchangeCode: async () => ({ kind: 'mcp' as const, token: 'mcp_surprise_mint', scope: 'drive:drv1:member' }),
    });
    const stderr = createRecordingSink();
    const activeKeyStore = createFakeActiveKeyStore();
    const ctx = createFakeContext({ sdk: fakeSdk(vi.fn(async () => SERVER_KEYS)), stderr, activeKeyStore });

    const code = await handler(ctx, commandIntent(['keys', 'use', 'agent']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(setSpy).not.toHaveBeenCalled();
    expect(activeKeyStore.entries.size).toBe(0);
    expect(stderr.lines.join('')).not.toContain('mcp_surprise_mint');
  });

  it('fails closed when the server approves a DIFFERENT key than the ceremony named', async () => {
    const store = fakeStore({ agent: STATIC_KEY });
    const { deps } = baseDeps(store);
    const handler = createKeysUseHandler({
      ...deps,
      exchangeCode: async () => ({ kind: 'mcp_activate' as const, tokenId: 'tok2', scope: 'activate_key:tok2' }),
    });
    const stderr = createRecordingSink();
    const activeKeyStore = createFakeActiveKeyStore();
    const ctx = createFakeContext({ sdk: fakeSdk(vi.fn(async () => SERVER_KEYS)), stderr, activeKeyStore });

    const code = await handler(ctx, commandIntent(['keys', 'use', 'agent']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('different key');
    expect(activeKeyStore.entries.size).toBe(0);
  });
});

describe('createKeysUseHandler — --off', () => {
  it('clears the activation locally with no browser and no server call', async () => {
    const store = fakeStore({ agent: STATIC_KEY });
    const fake = fakeLoopbackServer();
    let browserOpened = false;
    const { deps } = baseDeps(store, fake);
    const handler = createKeysUseHandler({
      ...deps,
      openBrowser: async () => {
        browserOpened = true;
        return true;
      },
    });

    const invoke = vi.fn(async () => SERVER_KEYS);
    const activeKeyStore = createFakeActiveKeyStore({ [HOST]: 'agent' });
    const stdout = createRecordingSink();
    const ctx = createFakeContext({ sdk: fakeSdk(invoke), activeKeyStore, stdout });

    const code = await handler(ctx, commandIntent(['keys', 'use', '--off']));

    expect(code).toBe(EXIT_SUCCESS);
    expect(activeKeyStore.entries.size).toBe(0);
    expect(browserOpened).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(stdout.lines.join('')).toContain('Active key cleared for https://pagespace.ai.');
  });

  it('--off respects --host for which host it clears', async () => {
    const { deps } = baseDeps(fakeStore());
    const handler = createKeysUseHandler(deps);
    const activeKeyStore = createFakeActiveKeyStore({ 'https://dev.example': 'agent', [HOST]: 'other' });
    const ctx = createFakeContext({ activeKeyStore });

    const parsed = parseArgv(['keys', 'use', '--off', '--host', 'https://dev.example']);
    if (parsed.kind !== 'command') throw new Error('expected command');
    const code = await handler(ctx, { ...parsed, args: parsed.args.slice(2) });

    expect(code).toBe(EXIT_SUCCESS);
    expect(activeKeyStore.entries.has('https://dev.example')).toBe(false);
    expect(activeKeyStore.entries.get(HOST)).toBe('other');
  });
});
