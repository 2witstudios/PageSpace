import { describe, expect, it } from 'vitest';
import {
  createLoginHandler,
  EXIT_RUNTIME_ERROR,
  EXIT_SUCCESS,
  parseArgv,
} from '@pagespace/cli';
import type { CredentialStore, HostCredential, LoopbackCallback, LoopbackServer } from '@pagespace/cli';
import { createFakeContext, createRecordingSink } from '../../__tests__/fake-context.js';

const FIXED_TOKENS = {
  accessToken: 'ps_at_test',
  refreshToken: 'ps_rt_test',
  expiresIn: 900,
  scope: 'account offline_access',
};

/** Seeds every entry as that host's "default" profile -- named profiles are added independently via set(). */
function fakeStore(initial: Map<string, HostCredential> = new Map()): CredentialStore {
  const hosts = new Map<string, Map<string, HostCredential>>();
  for (const [host, credential] of initial) {
    hosts.set(host, new Map([['default', credential]]));
  }

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
    list: async () =>
      [...hosts.entries()]
        .filter(([, profiles]) => profiles.has('default'))
        .map(([host, profiles]) => ({ host, tokenPrefix: profiles.get('default')!.refreshToken.slice(0, 12) })),
  };
}

/** Buffers a delivery that races ahead of `nextCallback()` being subscribed — see loopback-flow.test.ts. */
function fakeServer(port = 55555) {
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

function baseHandlerDeps(store: CredentialStore) {
  return {
    createCredentialStore: () => store,
    randomBytes: (n: number) => new Uint8Array(n).fill(7),
    discoverMetadata: async () => ({
      authorizationEndpoint: 'https://pagespace.ai/api/oauth/authorize',
      tokenEndpoint: 'https://pagespace.ai/api/oauth/token',
    }),
    startServer: async () => fakeServer().server,
    openBrowser: async () => true,
    waitMs: () => new Promise<void>(() => {}),
    exchangeCode: async () => FIXED_TOKENS,
    confirmIdentity: async () => ({ name: 'Ada Lovelace', email: 'ada@example.com' }),
    now: () => Date.parse('2026-07-03T00:00:00.000Z'),
  };
}

function commandIntent(argv: string[]) {
  const intent = parseArgv(argv);
  if (intent.kind !== 'command') throw new Error('expected command');
  return intent;
}

describe('createLoginHandler', () => {
  it('logs in successfully and prints identity but never the tokens', async () => {
    const store = fakeStore();
    const fake = fakeServer();
    const handler = createLoginHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        const state = new URL(url).searchParams.get('state')!;
        queueMicrotask(() => fake.deliver({ code: 'auth-code', state }));
        return true;
      },
    });

    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, env: {} });

    const code = await handler(ctx, commandIntent(['login']));

    expect(code).toBe(EXIT_SUCCESS);
    const allOutput = [...stdout.lines, ...stderr.lines].join('');
    expect(allOutput).toContain('ada@example.com');
    expect(allOutput).toContain(FIXED_TOKENS.scope);
    expect(allOutput).toMatch(/personal account access/i);
    expect(allOutput).not.toContain(FIXED_TOKENS.accessToken);
    expect(allOutput).not.toContain(FIXED_TOKENS.refreshToken);
  });

  it('never writes the access or refresh token to stdout/stderr even on a token-exchange failure', async () => {
    const store = fakeStore();
    const fake = fakeServer();
    const handler = createLoginHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      exchangeCode: async () => {
        throw new Error(`rejected: ${FIXED_TOKENS.refreshToken}`);
      },
      openBrowser: async (url) => {
        const state = new URL(url).searchParams.get('state')!;
        queueMicrotask(() => fake.deliver({ code: 'auth-code', state }));
        return true;
      },
    });

    const stdout = createRecordingSink();
    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stdout, stderr, env: {} });

    const code = await handler(ctx, commandIntent(['login']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    const allOutput = [...stdout.lines, ...stderr.lines].join('');
    expect(allOutput).not.toContain(FIXED_TOKENS.accessToken);
  });

  it('refuses to overwrite an existing stored profile without --yes', async () => {
    const store = fakeStore(
      new Map([['https://pagespace.ai', { refreshToken: 'ps_rt_existing', clientId: 'pagespace-cli', scopes: ['account'], createdAt: '2026-01-01T00:00:00.000Z' }]]),
    );
    const handler = createLoginHandler(baseHandlerDeps(store));

    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });

    const code = await handler(ctx, commandIntent(['login']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toMatch(/--yes/);
    expect(stderr.lines.join('')).not.toContain('ps_rt_existing');
  });

  it('overwrites an existing stored profile when --yes is passed', async () => {
    const store = fakeStore(
      new Map([['https://pagespace.ai', { refreshToken: 'ps_rt_existing', clientId: 'pagespace-cli', scopes: ['account'], createdAt: '2026-01-01T00:00:00.000Z' }]]),
    );
    const fake = fakeServer();
    const handler = createLoginHandler({
      ...baseHandlerDeps(store),
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        const state = new URL(url).searchParams.get('state')!;
        queueMicrotask(() => fake.deliver({ code: 'auth-code', state }));
        return true;
      },
    });

    const ctx = createFakeContext({ env: {} });
    const code = await handler(ctx, commandIntent(['login', '--yes']));

    expect(code).toBe(EXIT_SUCCESS);
    const stored = await store.get('https://pagespace.ai');
    expect(stored?.refreshToken).toBe(FIXED_TOKENS.refreshToken);
  });

  it('resolves the host from --host, falling back to PAGESPACE_API_URL, then the default', async () => {
    const store = fakeStore();
    const hostsSeen: string[] = [];
    const handler = createLoginHandler({
      ...baseHandlerDeps(store),
      discoverMetadata: async (host: string) => {
        hostsSeen.push(host);
        return {
          authorizationEndpoint: `${host}/api/oauth/authorize`,
          tokenEndpoint: `${host}/api/oauth/token`,
        };
      },
      startServer: async () => fakeServer().server,
      waitMs: () => Promise.resolve(),
    });

    const ctx = createFakeContext({ env: { PAGESPACE_API_URL: 'https://self-hosted.example' } });
    await handler(ctx, commandIntent(['login', '--host', 'https://explicit.example']));

    expect(hostsSeen).toEqual(['https://explicit.example']);
  });

  it('maps each failure branch to exit 1 with a distinct message', async () => {
    const store = fakeStore();
    const handler = createLoginHandler({
      ...baseHandlerDeps(store),
      discoverMetadata: async () => {
        throw new Error('offline');
      },
    });

    const stderr = createRecordingSink();
    const ctx = createFakeContext({ stderr, env: {} });
    const code = await handler(ctx, commandIntent(['login']));

    expect(code).toBe(EXIT_RUNTIME_ERROR);
    expect(stderr.lines.join('')).toContain('offline');
  });
});
