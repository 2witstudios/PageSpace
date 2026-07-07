import { describe, expect, it } from 'vitest';
import { credentialSecret, runLoopbackLogin } from '@pagespace/cli';
import type {
  DiscoveredMetadata,
  ExchangeCodeParams,
  ExchangedTokens,
  HostCredential,
  Identity,
  LoopbackCallback,
  LoopbackLoginDeps,
  LoopbackServer,
} from '@pagespace/cli';

const METADATA: DiscoveredMetadata = {
  authorizationEndpoint: 'https://pagespace.ai/api/oauth/authorize',
  tokenEndpoint: 'https://pagespace.ai/api/oauth/token',
};

const TOKENS: ExchangedTokens = {
  kind: 'oauth',
  accessToken: 'ps_at_test-access-token',
  refreshToken: 'ps_rt_test-refresh-token',
  expiresIn: 900,
  scope: 'account offline_access',
};

const IDENTITY: Identity = { name: 'Ada Lovelace', email: 'ada@example.com' };

function fixedRandomBytes(length: number): Uint8Array {
  return new Uint8Array(Array.from({ length }, (_, i) => (i + 1) % 256));
}

/**
 * A controllable fake `LoopbackServer` — the test drives `nextCallback()` by
 * calling `deliver`. Buffers a delivery that arrives before `nextCallback()`
 * is subscribed (mirrors real HTTP: the request can race the subscriber),
 * so callers can fire `deliver` from inside a same-tick `openBrowser` fake
 * without a lost-wakeup hang.
 */
function createFakeServer(port = 51234) {
  let pendingResolve: ((callback: LoopbackCallback) => void) | null = null;
  let buffered: LoopbackCallback | null = null;
  const finishCalls: string[] = [];
  let closeCalls = 0;

  const server: LoopbackServer = {
    port,
    nextCallback: () => {
      if (buffered) {
        const callback = buffered;
        buffered = null;
        return Promise.resolve(callback);
      }
      return new Promise<LoopbackCallback>((resolve) => {
        pendingResolve = resolve;
      });
    },
    finish: async (html: string) => {
      finishCalls.push(html);
    },
    close: async () => {
      closeCalls += 1;
    },
  };

  return {
    server,
    deliver(query: Record<string, string>) {
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve({ query });
      } else {
        buffered = { query };
      }
    },
    get finishCalls() {
      return finishCalls;
    },
    get closeCalls() {
      return closeCalls;
    },
  };
}

/** A `waitMs` that never resolves — used so the callback always wins the race. */
function neverTimeout() {
  return () => new Promise<void>(() => {});
}

/** A `waitMs` that resolves immediately — used to force the timeout branch. */
function instantTimeout() {
  return () => Promise.resolve();
}

function baseDeps(overrides: Partial<LoopbackLoginDeps> = {}): { deps: LoopbackLoginDeps; store: Map<string, HostCredential>; capturedUrls: string[] } {
  const store = new Map<string, HostCredential>();
  const capturedUrls: string[] = [];

  const fake = createFakeServer();

  const deps: LoopbackLoginDeps = {
    host: 'https://pagespace.ai',
    clientId: 'pagespace-cli',
    scope: 'account offline_access',
    randomBytes: fixedRandomBytes,
    discoverMetadata: async () => METADATA,
    startServer: async () => fake.server,
    maxPortAttempts: 5,
    openBrowser: async (url) => {
      capturedUrls.push(url);
      return true;
    },
    onBrowserOpenFailed: () => {},
    waitMs: neverTimeout(),
    timeoutMs: 5000,
    exchangeCode: async () => TOKENS,
    confirmIdentity: async () => IDENTITY,
    credentialStore: {
      set: async (host, credential) => {
        store.set(host, credential);
      },
    },
    now: () => Date.parse('2026-07-03T00:00:00.000Z'),
    ...overrides,
  };

  return { deps, store, capturedUrls };
}

function stateFromAuthorizeUrl(url: string): string {
  const parsed = new URL(url);
  const state = parsed.searchParams.get('state');
  if (!state) throw new Error('authorize URL missing state');
  return state;
}

describe('runLoopbackLogin — happy path', () => {
  it('discovers, opens the browser, exchanges the code, persists the refresh token, and confirms identity', async () => {
    const { deps, store, capturedUrls } = baseDeps();
    const fake = createFakeServer();

    const result = await runLoopbackLogin({
      ...deps,
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        capturedUrls.push(url);
        const state = stateFromAuthorizeUrl(url);
        queueMicrotask(() => fake.deliver({ code: 'auth-code-123', state }));
        return true;
      },
    });

    expect(result).toEqual({ outcome: 'success', identity: IDENTITY, scope: TOKENS.scope });
    expect(store.get('https://pagespace.ai')).toEqual({
      kind: 'oauth',
      refreshToken: TOKENS.refreshToken,
      clientId: 'pagespace-cli',
      scopes: ['account', 'offline_access'],
      createdAt: '2026-07-03T00:00:00.000Z',
    });
    expect(fake.finishCalls).toHaveLength(1);
    expect(fake.finishCalls[0]).toMatch(/logged in/i);
    expect(fake.closeCalls).toBe(1);

    const authorizeUrl = new URL(capturedUrls[0]!);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(METADATA.authorizationEndpoint);
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl.searchParams.get('client_id')).toBe('pagespace-cli');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it('persists the credential under deps.profile when given, defaulting to "default" when omitted', async () => {
    const setCalls: Array<{ host: string; profile: string | undefined }> = [];
    const { deps } = baseDeps({
      credentialStore: {
        set: async (host, _credential, profile) => {
          setCalls.push({ host, profile });
        },
      },
    });
    const fake = createFakeServer();

    await runLoopbackLogin({
      ...deps,
      profile: 'work',
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        const state = stateFromAuthorizeUrl(url);
        queueMicrotask(() => fake.deliver({ code: 'auth-code-123', state }));
        return true;
      },
    });

    expect(setCalls).toEqual([{ host: 'https://pagespace.ai', profile: 'work' }]);
  });

  it('persists the credential under the "default" profile when no profile is given', async () => {
    const setCalls: Array<{ host: string; profile: string | undefined }> = [];
    const { deps } = baseDeps({
      credentialStore: {
        set: async (host, _credential, profile) => {
          setCalls.push({ host, profile });
        },
      },
    });
    const fake = createFakeServer();

    await runLoopbackLogin({
      ...deps,
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        const state = stateFromAuthorizeUrl(url);
        queueMicrotask(() => fake.deliver({ code: 'auth-code-123', state }));
        return true;
      },
    });

    expect(setCalls).toEqual([{ host: 'https://pagespace.ai', profile: 'default' }]);
  });

  it('never exposes the access or refresh token anywhere in the returned result', async () => {
    const { deps } = baseDeps();
    const fake = createFakeServer();
    const result = await runLoopbackLogin({
      ...deps,
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        const state = stateFromAuthorizeUrl(url);
        queueMicrotask(() => fake.deliver({ code: 'auth-code-123', state }));
        return true;
      },
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TOKENS.accessToken);
    expect(serialized).not.toContain(TOKENS.refreshToken);
  });

  it('still succeeds (with a null identity) when identity confirmation fails after tokens are already persisted', async () => {
    const { deps, store } = baseDeps({
      confirmIdentity: async () => {
        throw new Error('whoami unreachable');
      },
    });
    const fake = createFakeServer();

    const result = await runLoopbackLogin({
      ...deps,
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        const state = stateFromAuthorizeUrl(url);
        queueMicrotask(() => fake.deliver({ code: 'auth-code-123', state }));
        return true;
      },
    });

    expect(result).toEqual({ outcome: 'success', identity: null, scope: TOKENS.scope });
    expect(credentialSecret(store.get('https://pagespace.ai')!)).toBe(TOKENS.refreshToken);
  });

  it('prints the authorize URL via onBrowserOpenFailed when openBrowser fails, but still completes login', async () => {
    const failedUrls: string[] = [];
    const { deps } = baseDeps({ onBrowserOpenFailed: (url) => failedUrls.push(url) });
    const fake = createFakeServer();

    const result = await runLoopbackLogin({
      ...deps,
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        const state = stateFromAuthorizeUrl(url);
        queueMicrotask(() => fake.deliver({ code: 'auth-code-123', state }));
        return false;
      },
    });

    expect(result.outcome).toBe('success');
    expect(failedUrls).toHaveLength(1);
    expect(failedUrls[0]).toMatch(/^https:\/\/pagespace\.ai\/api\/oauth\/authorize/);
  });

  it('persists a static credential (no refresh token, no clientId) when the exchange returns an mcp-kind token, and confirms identity using that token directly — this is pagespace keys create\'s pure drive:* grant path', async () => {
    const mcpTokens: ExchangedTokens = { kind: 'mcp', token: 'mcp_abc123', scope: 'drive:d1:member offline_access' };
    let confirmIdentityAccessToken: string | undefined;
    const { deps, store } = baseDeps({
      exchangeCode: async () => mcpTokens,
      confirmIdentity: async ({ accessToken }) => {
        confirmIdentityAccessToken = accessToken;
        return IDENTITY;
      },
    });
    const fake = createFakeServer();

    const result = await runLoopbackLogin({
      ...deps,
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        const state = stateFromAuthorizeUrl(url);
        queueMicrotask(() => fake.deliver({ code: 'auth-code-123', state }));
        return true;
      },
    });

    expect(result).toEqual({ outcome: 'success', identity: IDENTITY, scope: mcpTokens.scope });
    expect(store.get('https://pagespace.ai')).toEqual({
      kind: 'static',
      token: 'mcp_abc123',
      scopes: ['drive:d1:member', 'offline_access'],
      createdAt: '2026-07-03T00:00:00.000Z',
    });
    expect(confirmIdentityAccessToken).toBe('mcp_abc123');
  });

  it('invokes onMintedStaticToken exactly once with the raw token for an mcp-kind mint, while the result stays token-free', async () => {
    const mcpTokens: ExchangedTokens = { kind: 'mcp', token: 'mcp_abc123', scope: 'drive:d1:member offline_access' };
    const surfaced: string[] = [];
    const { deps } = baseDeps({
      exchangeCode: async () => mcpTokens,
      onMintedStaticToken: (token) => {
        surfaced.push(token);
      },
    });
    const fake = createFakeServer();

    const result = await runLoopbackLogin({
      ...deps,
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        const state = stateFromAuthorizeUrl(url);
        queueMicrotask(() => fake.deliver({ code: 'auth-code-123', state }));
        return true;
      },
    });

    expect(surfaced).toEqual(['mcp_abc123']);
    expect(JSON.stringify(result)).not.toContain('mcp_abc123');
  });

  it('never invokes onMintedStaticToken for an oauth-kind exchange — pagespace login cannot surface a secret even if it wired the callback', async () => {
    const surfaced: string[] = [];
    const { deps } = baseDeps({
      onMintedStaticToken: (token) => {
        surfaced.push(token);
      },
    });
    const fake = createFakeServer();

    const result = await runLoopbackLogin({
      ...deps,
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        const state = stateFromAuthorizeUrl(url);
        queueMicrotask(() => fake.deliver({ code: 'auth-code-123', state }));
        return true;
      },
    });

    expect(result.outcome).toBe('success');
    expect(surfaced).toEqual([]);
  });

  it('persists NOTHING and skips confirmIdentity for an mcp_update exchange — the existing key keeps its secret; only the granted scope + token id come back', async () => {
    let confirmIdentityCalled = false;
    const surfaced: string[] = [];
    const { deps, store } = baseDeps({
      exchangeCode: async () => ({ kind: 'mcp_update', tokenId: 'tok123', scope: 'update_key:tok123 drive:d1:member' }),
      confirmIdentity: async () => {
        confirmIdentityCalled = true;
        return IDENTITY;
      },
      onMintedStaticToken: (token) => {
        surfaced.push(token);
      },
    });
    const fake = createFakeServer();

    const result = await runLoopbackLogin({
      ...deps,
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        const state = stateFromAuthorizeUrl(url);
        queueMicrotask(() => fake.deliver({ code: 'auth-code-123', state }));
        return true;
      },
    });

    expect(result).toEqual({
      outcome: 'success',
      identity: null,
      scope: 'update_key:tok123 drive:d1:member',
      updatedTokenId: 'tok123',
    });
    expect(store.size).toBe(0);
    expect(confirmIdentityCalled).toBe(false);
    expect(surfaced).toEqual([]);
  });
});

describe('runLoopbackLogin — failure branches', () => {
  it('fails closed on discovery errors without ever starting a server', async () => {
    let serverStarted = false;
    const { deps } = baseDeps({
      discoverMetadata: async () => {
        throw new Error('offline');
      },
      startServer: async () => {
        serverStarted = true;
        return createFakeServer().server;
      },
    });

    const result = await runLoopbackLogin(deps);

    expect(result).toEqual({ outcome: 'discovery_failed', message: 'offline' });
    expect(serverStarted).toBe(false);
  });

  it('gives up after exhausting maxPortAttempts port-bind retries', async () => {
    let attempts = 0;
    const { deps } = baseDeps({
      maxPortAttempts: 3,
      startServer: async () => {
        attempts += 1;
        throw new Error('EADDRINUSE');
      },
    });

    const result = await runLoopbackLogin(deps);

    expect(result).toEqual({ outcome: 'port_bind_failed' });
    expect(attempts).toBe(3);
  });

  it('recovers from transient port-bind failures and succeeds once a later attempt binds', async () => {
    let attempts = 0;
    const fake = createFakeServer();
    const { deps } = baseDeps({
      maxPortAttempts: 5,
      startServer: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('EADDRINUSE');
        return fake.server;
      },
      openBrowser: async (url) => {
        const state = stateFromAuthorizeUrl(url);
        queueMicrotask(() => fake.deliver({ code: 'auth-code-123', state }));
        return true;
      },
    });

    const result = await runLoopbackLogin(deps);

    expect(result.outcome).toBe('success');
    expect(attempts).toBe(3);
  });

  it('times out and closes the server if no callback arrives within timeoutMs', async () => {
    const fake = createFakeServer();
    const { deps } = baseDeps({
      startServer: async () => fake.server,
      waitMs: instantTimeout(),
    });

    const result = await runLoopbackLogin(deps);

    expect(result).toEqual({ outcome: 'timeout' });
    expect(fake.closeCalls).toBe(1);
    expect(fake.finishCalls).toHaveLength(0);
  });

  it('hard-fails on state mismatch without retrying the same state', async () => {
    const fake = createFakeServer();
    const { deps } = baseDeps({
      startServer: async () => fake.server,
      openBrowser: async () => {
        queueMicrotask(() => fake.deliver({ code: 'auth-code-123', state: 'not-the-real-state' }));
        return true;
      },
    });

    const result = await runLoopbackLogin(deps);

    expect(result).toEqual({ outcome: 'state_mismatch' });
    expect(fake.finishCalls).toHaveLength(1);
    expect(fake.closeCalls).toBe(1);
  });

  it('maps error=access_denied to a dedicated outcome', async () => {
    const fake = createFakeServer();
    const { deps } = baseDeps({
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        const state = stateFromAuthorizeUrl(url);
        queueMicrotask(() => fake.deliver({ error: 'access_denied', state }));
        return true;
      },
    });

    const result = await runLoopbackLogin(deps);

    expect(result).toEqual({ outcome: 'access_denied' });
  });

  it('maps any other authorize error param to a distinct authorize_error outcome', async () => {
    const fake = createFakeServer();
    const { deps } = baseDeps({
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        const state = stateFromAuthorizeUrl(url);
        queueMicrotask(() => fake.deliver({ error: 'invalid_scope', state }));
        return true;
      },
    });

    const result = await runLoopbackLogin(deps);

    expect(result).toEqual({ outcome: 'authorize_error', error: 'invalid_scope' });
  });

  it('reports a token-exchange failure without persisting anything to the credential store', async () => {
    const fake = createFakeServer();
    const { deps, store } = baseDeps({
      startServer: async () => fake.server,
      exchangeCode: async () => {
        throw new Error('invalid_grant');
      },
      openBrowser: async (url) => {
        const state = stateFromAuthorizeUrl(url);
        queueMicrotask(() => fake.deliver({ code: 'auth-code-123', state }));
        return true;
      },
    });

    const result = await runLoopbackLogin(deps);

    expect(result).toEqual({ outcome: 'token_exchange_failed', message: 'invalid_grant' });
    expect(store.size).toBe(0);
  });

  it('treats a callback missing a code as a token-exchange failure', async () => {
    const fake = createFakeServer();
    const { deps } = baseDeps({
      startServer: async () => fake.server,
      openBrowser: async (url) => {
        const state = stateFromAuthorizeUrl(url);
        queueMicrotask(() => fake.deliver({ state }));
        return true;
      },
    });

    const result = await runLoopbackLogin(deps);

    expect(result.outcome).toBe('token_exchange_failed');
  });
});

describe('runLoopbackLogin — PKCE + params', () => {
  it('sends a code_verifier at exchange time whose S256 challenge matches the one sent to the authorize endpoint', async () => {
    const fake = createFakeServer();
    let exchangeParams: ExchangeCodeParams | undefined;
    const { deps, capturedUrls } = baseDeps({
      startServer: async () => fake.server,
      exchangeCode: async (params) => {
        exchangeParams = params;
        return TOKENS;
      },
      openBrowser: async (url) => {
        capturedUrls.push(url);
        const state = stateFromAuthorizeUrl(url);
        queueMicrotask(() => fake.deliver({ code: 'auth-code-123', state }));
        return true;
      },
    });

    await runLoopbackLogin(deps);

    const authorizeUrl = new URL(capturedUrls[0]!);
    const sentChallenge = authorizeUrl.searchParams.get('code_challenge');
    expect(sentChallenge).toBeTruthy();
    expect(exchangeParams?.codeVerifier).toBeTruthy();

    const { deriveCodeChallenge } = await import('@pagespace/lib/auth/oauth/pkce');
    expect(deriveCodeChallenge(exchangeParams!.codeVerifier)).toBe(sentChallenge);
  });
});
