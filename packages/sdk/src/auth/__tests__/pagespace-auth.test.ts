/**
 * Phase 3 leaf 2 — `PageSpaceAuth`, the browser façade over leaf 1: start a
 * sign-in by redirect, finish it on the callback page, restore it after a
 * reload, sign out. Storage, navigation, fetch, clock and randomness are all
 * injected; nothing here touches a real network or a real browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthenticationError, isValidationError } from '../../errors.js';
import { OAuthTokenProvider, type OAuthTokenProviderOptions } from '../oauth.js';
import {
  isAcceptableBaseUrl,
  isPageSpaceConfigError,
  isSignInError,
  PageSpaceAuth,
  PENDING_SIGN_IN_TTL_MS,
  type AuthStorage,
  type PageSpaceAuthOptions,
} from '../pagespace-auth.js';
import { deriveCodeChallenge } from '../pkce.js';
import { PAGESPACE_CALLBACK_PATH } from '../sign-in.js';

const BASE_URL = 'https://pagespace.example';
const APP_ORIGIN = 'https://app.example.com';
const REDIRECT_URI = `${APP_ORIGIN}${PAGESPACE_CALLBACK_PATH}`;
const CLIENT_ID = 'app_123';
const TOKEN_ENDPOINT = `${BASE_URL}/api/oauth/token`;

/** Distinctive secrets: if any of these appears in an error, a log line or a serialized object, it leaked. */
const SECRETS = {
  code: 'ps_ac_SECRET_CODE_1',
  accessToken: 'ps_at_SECRET_ACCESS_1',
  refreshToken: 'ps_rt_SECRET_REFRESH_1',
  rotatedAccessToken: 'ps_at_SECRET_ACCESS_2',
  rotatedRefreshToken: 'ps_rt_SECRET_REFRESH_2',
  mcpToken: 'mcp_SECRET_STATIC_1',
};

class MemoryStorage implements AuthStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  /** Every value currently stored, concatenated — for "is X still in storage" assertions. */
  dump(): string {
    return [...this.items.values()].join('\n');
  }
}

interface FetchCall {
  readonly url: string;
  readonly body: URLSearchParams;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function scriptedFetch(responses: Array<() => Response>): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: new URLSearchParams(typeof init?.body === 'string' ? init.body : '') });
    const next = responses.shift();
    if (!next) throw new TypeError('no scripted response left');
    return next();
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const bearer = (overrides: Record<string, unknown> = {}) => () =>
  jsonResponse(200, {
    access_token: SECRETS.accessToken,
    token_type: 'Bearer',
    expires_in: 900,
    refresh_token: SECRETS.refreshToken,
    scope: 'profile offline_access',
    ...overrides,
  });

/** Deterministic "randomness": byte i of every draw is (seed + i) mod 256. */
function countingRandomBytes(): (length: number) => Uint8Array {
  let seed = 0;
  return (length: number) => {
    seed += 1;
    return Uint8Array.from({ length }, (_, i) => (seed + i) % 256);
  };
}

function makeAuth(overrides: Partial<PageSpaceAuthOptions> = {}) {
  const storage = new MemoryStorage();
  const assigned: string[] = [];
  let clock = 1_000_000;
  const options: PageSpaceAuthOptions = {
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    storage,
    assign: (url: string) => {
      assigned.push(url);
    },
    now: () => clock,
    randomBytes: countingRandomBytes(),
    ...overrides,
  };
  return {
    auth: new PageSpaceAuth(options),
    storage,
    assigned,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** Starts a sign-in and returns the callback URL the provider would redirect back to. */
async function startSignIn(harness: ReturnType<typeof makeAuth>, query: (state: string) => string = (state) => `code=${SECRETS.code}&state=${state}`) {
  await harness.auth.signInWithRedirect();
  const authorizeUrl = new URL(harness.assigned[harness.assigned.length - 1]);
  const state = authorizeUrl.searchParams.get('state') ?? '';
  return { authorizeUrl, state, callbackUrl: `${REDIRECT_URI}?${query(state)}` };
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

function everythingVisible(value: unknown): string {
  if (!(value instanceof Error)) return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const cause = (value as { cause?: unknown }).cause;
  return [value.name, value.message, String(value.stack ?? ''), JSON.stringify(value), cause === undefined ? '' : everythingVisible(cause)].join('\n');
}

function expectNoSecret(text: string): void {
  for (const secret of Object.values(SECRETS)) {
    expect(text).not.toContain(secret);
  }
}

describe('PageSpaceAuth constructor', () => {
  it('rejects a base URL that is not https (except loopback http for local development)', () => {
    expect(() => makeAuth({ baseUrl: 'http://pagespace.example' })).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
    expect(() => makeAuth({ baseUrl: 'not a url' })).toThrowError(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
    expect(() => makeAuth({ baseUrl: 'http://localhost:3000' })).not.toThrow();
    expect(() => makeAuth({ baseUrl: 'http://127.0.0.1:3000' })).not.toThrow();
  });

  it('rejects a base URL carrying a query or fragment (it would move the token endpoint)', () => {
    expect(isAcceptableBaseUrl('https://pagespace.example#')).toBe(false);
    expect(isAcceptableBaseUrl('https://pagespace.example/?x=1')).toBe(false);
    expect(isAcceptableBaseUrl('https://pagespace.example/sub')).toBe(true);
  });

  it('rejects an empty client id or redirect URI', () => {
    const empty = [() => makeAuth({ clientId: '' }), () => makeAuth({ redirectUri: '' })];
    for (const build of empty) {
      let thrown: unknown;
      try {
        build();
      } catch (error) {
        thrown = error;
      }
      expect(isPageSpaceConfigError(thrown)).toBe(true);
    }
  });

  it('defaults the scope to identity plus refresh ("profile offline_access")', () => {
    expect(makeAuth().auth.scope).toBe('profile offline_access');
  });
});

describe('signInWithRedirect', () => {
  it('stores {state, codeVerifier, redirectUri} and navigates to the S256 authorize URL', async () => {
    const harness = makeAuth({ scope: 'profile drive:abc123:member offline_access' });

    const { authorizeUrl, state } = await startSignIn(harness);

    expect(harness.assigned).toHaveLength(1);
    expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(`${BASE_URL}/api/oauth/authorize`);
    expect(authorizeUrl.searchParams.get('response_type')).toBe('code');
    expect(authorizeUrl.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(authorizeUrl.searchParams.get('scope')).toBe('profile drive:abc123:member offline_access');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(state.length).toBeGreaterThanOrEqual(43);

    const [pending] = [...harness.storage.items.values()].map((raw) => JSON.parse(raw) as Record<string, unknown>);
    expect(pending).toMatchObject({ state, redirectUri: REDIRECT_URI });
    expect(typeof pending.codeVerifier).toBe('string');
    // The challenge sent is the S256 of the verifier kept — and the verifier itself never leaves storage.
    expect(authorizeUrl.searchParams.get('code_challenge')).toBe(await deriveCodeChallenge(pending.codeVerifier as string));
    expect(authorizeUrl.toString()).not.toContain(pending.codeVerifier as string);
  });

  it('lets one call widen or narrow the scope for that sign-in only', async () => {
    const harness = makeAuth();
    await harness.auth.signInWithRedirect({ scope: 'profile' });

    expect(new URL(harness.assigned[0]).searchParams.get('scope')).toBe('profile');
  });

  it('draws a fresh state and verifier for every sign-in', async () => {
    const harness = makeAuth();
    const first = await startSignIn(harness);
    const second = await startSignIn(harness);

    expect(second.state).not.toBe(first.state);
    expect(second.authorizeUrl.searchParams.get('code_challenge')).not.toBe(first.authorizeUrl.searchParams.get('code_challenge'));
  });

  it('fails closed with a typed error when no storage is available (and never navigates)', async () => {
    const assign = vi.fn();
    const auth = new PageSpaceAuth({ baseUrl: BASE_URL, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, storage: null, assign });

    const error = await captureError(() => auth.signInWithRedirect());

    expect(isSignInError(error) && error.reason).toBe('storage_unavailable');
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('handleRedirectCallback', () => {
  it('exchanges the code with the stored verifier and redirect URI, then returns a working OAuthTokenProvider', async () => {
    const { fetch, calls } = scriptedFetch([bearer()]);
    const harness = makeAuth({ fetch });
    const { callbackUrl } = await startSignIn(harness);
    const pendingVerifier = (JSON.parse([...harness.storage.items.values()][0]) as { codeVerifier: string }).codeVerifier;

    const provider = await harness.auth.handleRedirectCallback(callbackUrl);

    expect(provider).toBeInstanceOf(OAuthTokenProvider);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TOKEN_ENDPOINT);
    expect(Object.fromEntries(calls[0].body)).toEqual({
      grant_type: 'authorization_code',
      code: SECRETS.code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: pendingVerifier,
    });
    await expect(provider.getAccessToken()).resolves.toBe(SECRETS.accessToken);
  });

  it('clears the pending entry — a replayed callback finds nothing to finish', async () => {
    const { fetch } = scriptedFetch([bearer()]);
    const harness = makeAuth({ fetch });
    const { callbackUrl } = await startSignIn(harness);

    await harness.auth.handleRedirectCallback(callbackUrl);
    const replay = await captureError(() => harness.auth.handleRedirectCallback(callbackUrl));

    expect(isSignInError(replay) && replay.reason).toBe('no_pending_sign_in');
    expect(harness.storage.dump()).not.toContain('codeVerifier');
  });

  it('clears the pending entry even when the callback is rejected', async () => {
    const harness = makeAuth({ fetch: scriptedFetch([]).fetch });
    await startSignIn(harness);

    const error = await captureError(() => harness.auth.handleRedirectCallback(`${REDIRECT_URI}?code=x&state=forged`));

    expect(isSignInError(error) && error.reason).toBe('state_mismatch');
    expect(harness.storage.dump()).not.toContain('codeVerifier');
  });

  it('never calls the token endpoint for a forged state', async () => {
    const { fetch, calls } = scriptedFetch([bearer()]);
    const harness = makeAuth({ fetch });
    await startSignIn(harness);

    await captureError(() => harness.auth.handleRedirectCallback(`${REDIRECT_URI}?code=${SECRETS.code}&state=forged`));

    expect(calls).toHaveLength(0);
  });

  it('reports a declined consent as authorization_error / access_denied', async () => {
    const harness = makeAuth({ fetch: scriptedFetch([]).fetch });
    const { callbackUrl } = await startSignIn(harness, (state) => `error=access_denied&state=${state}`);

    const error = await captureError(() => harness.auth.handleRedirectCallback(callbackUrl));

    expect(isSignInError(error) && error.reason).toBe('authorization_error');
    expect(isSignInError(error) && error.authorizationError).toBe('access_denied');
  });

  it('reports a callback with no code as missing_code', async () => {
    const harness = makeAuth({ fetch: scriptedFetch([]).fetch });
    const { callbackUrl } = await startSignIn(harness, (state) => `state=${state}`);

    const error = await captureError(() => harness.auth.handleRedirectCallback(callbackUrl));

    expect(isSignInError(error) && error.reason).toBe('missing_code');
  });

  it('refuses a callback with no sign-in in progress', async () => {
    const harness = makeAuth();

    const error = await captureError(() => harness.auth.handleRedirectCallback(`${REDIRECT_URI}?code=c&state=s`));

    expect(isSignInError(error) && error.reason).toBe('no_pending_sign_in');
  });

  it('keeps a pending sign-in redeemable for 30 minutes (magic-link sign-up plus a step-up can take a while)', async () => {
    expect(PENDING_SIGN_IN_TTL_MS).toBe(30 * 60 * 1000);
    const harness = makeAuth({ fetch: scriptedFetch([bearer()]).fetch });
    const { callbackUrl } = await startSignIn(harness);
    harness.advance(29 * 60 * 1000);

    await expect(harness.auth.handleRedirectCallback(callbackUrl)).resolves.toBeInstanceOf(OAuthTokenProvider);
  });

  it('refuses a pending sign-in older than thirty minutes', async () => {
    const harness = makeAuth({ fetch: scriptedFetch([bearer()]).fetch });
    const { callbackUrl } = await startSignIn(harness);
    harness.advance(30 * 60 * 1000 + 1);

    const error = await captureError(() => harness.auth.handleRedirectCallback(callbackUrl));

    expect(isSignInError(error) && error.reason).toBe('pending_sign_in_expired');
  });

  it('treats a tampered pending entry as no sign-in at all', async () => {
    const harness = makeAuth();
    const { callbackUrl } = await startSignIn(harness);
    for (const key of harness.storage.items.keys()) harness.storage.setItem(key, '{"state": 42}');

    const error = await captureError(() => harness.auth.handleRedirectCallback(callbackUrl));

    expect(isSignInError(error) && error.reason).toBe('no_pending_sign_in');
  });

  it('refuses a first-party key response (token_type mcp) — a third-party sign-in only ever yields a Bearer pair', async () => {
    const harness = makeAuth({
      fetch: scriptedFetch([() => jsonResponse(200, { token_type: 'mcp', access_token: SECRETS.mcpToken, scope: 'drive:d1:member' })]).fetch,
    });
    const { callbackUrl } = await startSignIn(harness);

    const error = await captureError(() => harness.auth.handleRedirectCallback(callbackUrl));

    expect(isSignInError(error) && error.reason).toBe('unexpected_token_type');
    expect(harness.storage.dump()).not.toContain(SECRETS.mcpToken);
  });

  it('passes a token-endpoint rejection through as the classified SDK error', async () => {
    const harness = makeAuth({ fetch: scriptedFetch([() => jsonResponse(400, { error: 'invalid_grant' })]).fetch });
    const { callbackUrl } = await startSignIn(harness);

    const error = await captureError(() => harness.auth.handleRedirectCallback(callbackUrl));

    expect(isValidationError(error)).toBe(true);
    expect((error as Error).message).toBe('invalid_grant');
  });

  it('wires the default refresh: an expiring access token is rotated through the token endpoint and persisted', async () => {
    const { fetch, calls } = scriptedFetch([
      bearer(),
      bearer({ access_token: SECRETS.rotatedAccessToken, refresh_token: SECRETS.rotatedRefreshToken }),
    ]);
    const harness = makeAuth({ fetch });
    const { callbackUrl } = await startSignIn(harness);
    const provider = await harness.auth.handleRedirectCallback(callbackUrl);

    harness.advance(900 * 1000);
    await expect(provider.getAccessToken()).resolves.toBe(SECRETS.rotatedAccessToken);

    expect(calls[1].url).toBe(TOKEN_ENDPOINT);
    expect(Object.fromEntries(calls[1].body)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: SECRETS.refreshToken,
      client_id: CLIENT_ID,
    });
    expect(harness.storage.dump()).toContain(SECRETS.rotatedRefreshToken);
    expect(harness.storage.dump()).not.toContain(SECRETS.refreshToken);
  });

  it('uses an access-only token for its whole lifetime — no early refresh attempt in the last minute', async () => {
    const { fetch, calls } = scriptedFetch([bearer({ refresh_token: undefined, scope: 'profile' })]);
    const harness = makeAuth({ fetch, scope: 'profile' });
    const { callbackUrl } = await startSignIn(harness);
    const provider = await harness.auth.handleRedirectCallback(callbackUrl);

    harness.advance(850 * 1000);
    await expect(provider.getAccessToken()).resolves.toBe(SECRETS.accessToken);
    expect(harness.auth.restore()).not.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('signs in with an access-only grant (no offline_access) and fails closed, without a network call, once it expires', async () => {
    const { fetch, calls } = scriptedFetch([bearer({ refresh_token: undefined, scope: 'profile' })]);
    const harness = makeAuth({ fetch, scope: 'profile' });
    const { callbackUrl } = await startSignIn(harness);
    const provider = await harness.auth.handleRedirectCallback(callbackUrl);

    await expect(provider.getAccessToken()).resolves.toBe(SECRETS.accessToken);
    harness.advance(900 * 1000);
    const error = await captureError(() => provider.getAccessToken());

    expect(isAuthenticationError(error)).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

describe('OAuthTokenProvider default refresh (tokenEndpoint + clientId instead of an injected refreshAccessToken)', () => {
  it('rotates through the token endpoint and hands the new pair to onTokensUpdated', async () => {
    const { fetch, calls } = scriptedFetch([bearer({ access_token: SECRETS.rotatedAccessToken, refresh_token: SECRETS.rotatedRefreshToken })]);
    const updated: string[] = [];
    const provider = new OAuthTokenProvider({
      initialTokens: { accessToken: SECRETS.accessToken, accessExpiresAt: 0, refreshToken: SECRETS.refreshToken, refreshExpiresAt: 10_000_000 },
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: CLIENT_ID,
      fetch,
      now: () => 1_000_000,
      onTokensUpdated: (tokens) => {
        updated.push(tokens.refreshToken);
      },
    });

    await expect(provider.getAccessToken()).resolves.toBe(SECRETS.rotatedAccessToken);
    expect(calls.map((call) => [call.url, Object.fromEntries(call.body)])).toEqual([
      [TOKEN_ENDPOINT, { grant_type: 'refresh_token', refresh_token: SECRETS.refreshToken, client_id: CLIENT_ID }],
    ]);
    expect(updated).toEqual([SECRETS.rotatedRefreshToken]);
  });

  it('treats a definitive rejection from the token endpoint as terminal (re-login required)', async () => {
    const provider = new OAuthTokenProvider({
      initialTokens: { accessToken: SECRETS.accessToken, accessExpiresAt: 0, refreshToken: SECRETS.refreshToken, refreshExpiresAt: 10_000_000 },
      tokenEndpoint: TOKEN_ENDPOINT,
      clientId: CLIENT_ID,
      fetch: scriptedFetch([() => jsonResponse(400, { error: 'invalid_grant' })]).fetch,
      now: () => 1_000_000,
    });

    const error = await captureError(() => provider.getAccessToken());

    expect(isAuthenticationError(error)).toBe(true);
  });
});

describe('several providers over one stored session', () => {
  it('a provider whose refresh token was already rotated by another adopts the stored pair instead of replaying the spent token', async () => {
    const { fetch, calls } = scriptedFetch([
      bearer(),
      bearer({ access_token: SECRETS.rotatedAccessToken, refresh_token: SECRETS.rotatedRefreshToken }),
    ]);
    const harness = makeAuth({ fetch });
    const { callbackUrl } = await startSignIn(harness);
    const first = await harness.auth.handleRedirectCallback(callbackUrl);
    const second = harness.auth.restore();
    expect(second).not.toBeNull();

    harness.advance(900 * 1000);
    await expect(first.getAccessToken()).resolves.toBe(SECRETS.rotatedAccessToken);
    await expect(second?.getAccessToken()).resolves.toBe(SECRETS.rotatedAccessToken);

    // One refresh on the wire, with the original token; the second provider never presented the spent one.
    expect(calls.slice(1).map((call) => call.body.get('refresh_token'))).toEqual([SECRETS.refreshToken]);
  });

  it('serialises refreshes through navigator.locks when the environment has Web Locks', async () => {
    const lockNames: string[] = [];
    vi.stubGlobal('navigator', {
      locks: {
        request: async <T,>(name: string, callback: () => Promise<T>): Promise<T> => {
          lockNames.push(name);
          return callback();
        },
      },
    });
    try {
      const harness = makeAuth({ fetch: scriptedFetch([bearer(), bearer({ refresh_token: SECRETS.rotatedRefreshToken })]).fetch });
      const { callbackUrl } = await startSignIn(harness);
      const provider = await harness.auth.handleRedirectCallback(callbackUrl);
      harness.advance(900 * 1000);
      await provider.getAccessToken();

      // Once for the sign-in's write, once for the refresh — the same lock serialises both.
      expect(lockNames).toEqual([`pagespace.auth.refresh:${CLIENT_ID}`, `pagespace.auth.refresh:${CLIENT_ID}`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('signOut wins over a refresh already in flight: the session is gone afterwards, not written back', async () => {
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
      calls.push(body.get('grant_type') ?? `revoke:${String(input)}`);
      if (body.get('grant_type') === 'authorization_code') return bearer()();
      if (body.get('grant_type') === 'refresh_token') {
        await refreshGate;
        return bearer({ access_token: SECRETS.rotatedAccessToken, refresh_token: SECRETS.rotatedRefreshToken })();
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const harness = makeAuth({ fetch: fetchImpl });
    const { callbackUrl } = await startSignIn(harness);
    const provider = await harness.auth.handleRedirectCallback(callbackUrl);

    harness.advance(900 * 1000);
    const inFlight = provider.getAccessToken();
    await Promise.resolve();
    // signOut takes the refresh lock, so it completes only after the in-flight refresh has persisted.
    const signingOut = harness.auth.signOut();
    releaseRefresh();
    await inFlight.catch(() => undefined);
    await signingOut;

    expect(harness.storage.items.size).toBe(0);
    expect(harness.auth.restore()).toBeNull();
  });
});

/** A token server where every refresh token works exactly once, like the real rotation. */
function rotatingServer() {
  const spent = new Set<string>();
  let counter = 0;
  const refreshCalls: string[] = [];
  const revoked: string[] = [];
  const codes: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    if (String(input).endsWith('/revoke')) {
      revoked.push(body.get('token') ?? '');
      return new Response(null, { status: 200 });
    }
    const grant = body.get('grant_type');
    if (grant === 'authorization_code') codes.push(body.get('code') ?? '');
    if (grant === 'refresh_token') {
      const token = body.get('refresh_token') ?? '';
      refreshCalls.push(token);
      if (spent.has(token) || revoked.includes(token)) return jsonResponse(400, { error: 'invalid_grant' });
      spent.add(token);
    }
    counter += 1;
    const owner = grant === 'authorization_code' ? (body.get('code') ?? 'x') : (body.get('refresh_token') ?? 'x').split('~')[0].replace('ps_rt_', '');
    return jsonResponse(200, {
      access_token: `ps_at_${owner}~${counter}`,
      token_type: 'Bearer',
      expires_in: 900,
      refresh_token: `ps_rt_${owner}~${counter}`,
      scope: 'profile offline_access',
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, refreshCalls, revoked, codes };
}

/** Shares one storage and one clock across several PageSpaceAuth instances (tabs, re-renders). */
function sharedWorld(fetchImpl: typeof fetch) {
  const storage = new MemoryStorage();
  let clock = 1_000_000;
  const assigned: string[] = [];
  // One random source for the whole world, like a real CSPRNG: every draw in every instance differs.
  const randomBytes = countingRandomBytes();
  const make = () =>
    new PageSpaceAuth({
      baseUrl: BASE_URL,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      storage,
      fetch: fetchImpl,
      assign: (url) => {
        assigned.push(url);
      },
      now: () => clock,
      randomBytes,
    });
  const signIn = async (auth: PageSpaceAuth, user: string) => {
    await auth.signInWithRedirect();
    const state = new URL(assigned[assigned.length - 1]).searchParams.get('state') ?? '';
    return auth.handleRedirectCallback(`${REDIRECT_URI}?code=${user}&state=${state}`);
  };
  return { storage, make, signIn, advance: (ms: number) => { clock += ms; } };
}

describe('refresh coordination across providers and sign-ins', () => {
  it('a provider from an earlier sign-in never takes over a later sign-in in the same storage', async () => {
    const server = rotatingServer();
    const world = sharedWorld(server.fetch);
    const tab = world.make();
    const alice = await world.signIn(tab, 'alice');
    await tab.signOut();
    const bob = await world.signIn(world.make(), 'bob');
    const bobStoredBefore = world.storage.dump();

    world.advance(900 * 1000);
    const error = await captureError(() => alice.getAccessToken());

    expect(isAuthenticationError(error)).toBe(true);
    expect(server.refreshCalls).toEqual([]); // never touched bob's refresh token
    expect(world.storage.dump()).toBe(bobStoredBefore);
    await expect(bob.getAccessToken()).resolves.toMatch(/^ps_at_bob~/);
  });

  it('...including when the other sign-in happened in another tab with no signOut here', async () => {
    const server = rotatingServer();
    const world = sharedWorld(server.fetch);
    const alice = await world.signIn(world.make(), 'alice');
    await world.signIn(world.make(), 'bob');

    world.advance(900 * 1000);
    const error = await captureError(() => alice.getAccessToken());

    expect(isAuthenticationError(error)).toBe(true);
    expect(server.refreshCalls).toEqual([]);
  });

  it('keeps working in memory when storage writes start failing — it never replays the stale stored token', async () => {
    const server = rotatingServer();
    const world = sharedWorld(server.fetch);
    const provider = await world.signIn(world.make(), 'carol');
    world.storage.setItem = () => {
      throw new Error('QuotaExceededError');
    };

    world.advance(900 * 1000);
    const second = await provider.getAccessToken();
    world.advance(900 * 1000);
    const third = await provider.getAccessToken();

    expect(second).not.toBe(third);
    expect(server.refreshCalls).toEqual(['ps_rt_carol~1', 'ps_rt_carol~2']);
  });

  it('two providers refreshing at the same moment spend the refresh token once and both get the new pair', async () => {
    const server = rotatingServer();
    const world = sharedWorld(server.fetch);
    const auth = world.make();
    const first = await world.signIn(auth, 'dan');
    const second = auth.restore();

    world.advance(900 * 1000);
    const [a, b] = await Promise.all([first.getAccessToken(), second?.getAccessToken()]);

    expect(server.refreshCalls).toEqual(['ps_rt_dan~1']);
    expect(a).toBe('ps_at_dan~2');
    expect(b).toBe('ps_at_dan~2');
  });

  it('serialises the same way without Web Locks (in-realm queue fallback, e.g. older runtimes)', async () => {
    vi.stubGlobal('navigator', {});
    try {
      const server = rotatingServer();
      const world = sharedWorld(server.fetch);
      const auth = world.make();
      const first = await world.signIn(auth, 'fay');
      const second = auth.restore();

      world.advance(900 * 1000);
      const [a, b] = await Promise.all([first.getAccessToken(), second?.getAccessToken()]);

      expect(server.refreshCalls).toEqual(['ps_rt_fay~1']);
      expect([a, b]).toEqual(['ps_at_fay~2', 'ps_at_fay~2']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a sign-in that completes while an older sign-in is refreshing is not overwritten by it', async () => {
    const server = rotatingServer();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gatedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === 'string' && init.body.includes('grant_type=refresh_token')) await gate;
      return server.fetch(input, init);
    }) as typeof fetch;
    const world = sharedWorld(gatedFetch);
    const alice = await world.signIn(world.make(), 'alice');

    world.advance(900 * 1000);
    const aliceRefresh = alice.getAccessToken();
    await Promise.resolve();
    const bobSignIn = world.signIn(world.make(), 'bob');
    // Let bob's code exchange finish while alice's refresh is still on the wire, so the two writes overlap.
    while (!server.codes.includes('bob')) await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await aliceRefresh;
    const bob = await bobSignIn;

    const restored = world.make().restore();
    await expect(restored?.getAccessToken()).resolves.toMatch(/^ps_at_bob~/);
    world.advance(900 * 1000);
    await expect(bob.getAccessToken()).resolves.toMatch(/^ps_at_bob~/);
  });

  it('never overwrites a newer sign-in that another realm (no shared lock) wrote while the refresh was on the wire', async () => {
    vi.stubGlobal('navigator', {});
    try {
      const server = rotatingServer();
      let world!: ReturnType<typeof sharedWorld>;
      let otherRealmRecord = '';
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body === 'string' && init.body.includes('grant_type=refresh_token')) {
          // Another tab, outside this realm's queue, completes a different sign-in meanwhile.
          const record = JSON.parse(world.storage.getItem(`pagespace.auth.session:${CLIENT_ID}`) ?? '{}') as Record<string, unknown>;
          otherRealmRecord = JSON.stringify({ ...record, lineage: 'other-realm-sign-in', rotation: 0, accessToken: 'ps_at_other~1', refreshToken: 'ps_rt_other~1' });
          world.storage.setItem(`pagespace.auth.session:${CLIENT_ID}`, otherRealmRecord);
        }
        return server.fetch(input, init);
      }) as typeof fetch;
      world = sharedWorld(fetchImpl);
      const gus = await world.signIn(world.make(), 'gus');

      world.advance(900 * 1000);
      await gus.getAccessToken();

      expect(world.storage.getItem(`pagespace.auth.session:${CLIENT_ID}`)).toBe(otherRealmRecord);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('when one provider cannot persist its rotation, another provider over the same storage fails closed instead of replaying the spent token', async () => {
    const server = rotatingServer();
    const world = sharedWorld(server.fetch);
    const auth = world.make();
    const a = await world.signIn(auth, 'carol');
    const b = auth.restore();
    world.storage.setItem = () => {
      throw new Error('QuotaExceededError');
    };

    world.advance(900 * 1000);
    await a.getAccessToken();
    const error = await captureError(async () => b?.getAccessToken());

    expect(isAuthenticationError(error)).toBe(true);
    expect(server.refreshCalls).toEqual(['ps_rt_carol~1']);
  });

  it('a new sign-in whose first write fails still works in memory (it is not mistaken for a replaced sign-in)', async () => {
    const server = rotatingServer();
    const world = sharedWorld(server.fetch);
    await world.signIn(world.make(), 'dan');
    const realSetItem = world.storage.setItem.bind(world.storage);
    world.storage.setItem = (key, value) => {
      if (key.startsWith('pagespace.auth.session')) throw new Error('QuotaExceededError');
      realSetItem(key, value);
    };
    const erin = await world.signIn(world.make(), 'erin');

    world.advance(900 * 1000);
    await expect(erin.getAccessToken()).resolves.toMatch(/^ps_at_erin~/);
    expect(server.refreshCalls).toEqual(['ps_rt_erin~2']);
  });

  it('signOut from ANOTHER instance waits for an in-flight refresh, then revokes the rotated token; the old provider is dead', async () => {
    const server = rotatingServer();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gatedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === 'string' && init.body.includes('grant_type=refresh_token')) await gate;
      return server.fetch(input, init);
    }) as typeof fetch;
    const world = sharedWorld(gatedFetch);
    const provider = await world.signIn(world.make(), 'erin');

    world.advance(900 * 1000);
    const inFlight = provider.getAccessToken();
    await Promise.resolve();
    const signingOut = world.make().signOut();
    release();
    await inFlight;
    await signingOut;

    expect(world.storage.items.size).toBe(0);
    expect(server.revoked).toEqual(['ps_rt_erin~2']); // the newest token, so the whole family dies
    world.advance(900 * 1000);
    const error = await captureError(() => provider.getAccessToken());
    expect(isAuthenticationError(error)).toBe(true);
    expect(server.refreshCalls).toEqual(['ps_rt_erin~1']);
  });
});

describe('restore', () => {
  it('returns null when nothing was signed in', () => {
    expect(makeAuth().auth.restore()).toBeNull();
  });

  it('brings a signed-in session back after a reload, without a network call', async () => {
    const { fetch, calls } = scriptedFetch([bearer()]);
    const first = makeAuth({ fetch });
    const { callbackUrl } = await startSignIn(first);
    await first.auth.handleRedirectCallback(callbackUrl);

    const reloaded = new PageSpaceAuth({ baseUrl: BASE_URL, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, storage: new MemoryStorage(), fetch, now: () => 1_000_000 });
    const provider = reloaded.restore(first.storage);

    expect(provider).toBeInstanceOf(OAuthTokenProvider);
    await expect(provider?.getAccessToken()).resolves.toBe(SECRETS.accessToken);
    expect(calls).toHaveLength(1);
  });

  it('treats a base URL that differs only by a trailing slash as the same deployment', async () => {
    const first = makeAuth({ fetch: scriptedFetch([bearer()]).fetch });
    const { callbackUrl } = await startSignIn(first);
    await first.auth.handleRedirectCallback(callbackUrl);

    const reloaded = new PageSpaceAuth({ baseUrl: `${BASE_URL}/`, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, storage: first.storage, now: () => 1_000_000 });

    expect(reloaded.restore()).not.toBeNull();
  });

  it('ignores a session stored for a different PageSpace deployment', async () => {
    const first = makeAuth({ fetch: scriptedFetch([bearer()]).fetch });
    const { callbackUrl } = await startSignIn(first);
    await first.auth.handleRedirectCallback(callbackUrl);

    const sameClock = { clientId: CLIENT_ID, redirectUri: REDIRECT_URI, storage: first.storage, now: () => 1_000_000 };
    // Control: the same record IS restorable by the deployment that wrote it, at this clock.
    expect(new PageSpaceAuth({ ...sameClock, baseUrl: BASE_URL }).restore()).not.toBeNull();
    expect(new PageSpaceAuth({ ...sameClock, baseUrl: 'https://other.example' }).restore()).toBeNull();
  });

  it('drops a malformed or tampered session record instead of trusting it', () => {
    const harness = makeAuth();
    harness.storage.setItem(`pagespace.auth.session:${CLIENT_ID}`, '{"accessToken": 1}');

    expect(harness.auth.restore()).toBeNull();
    expect(harness.storage.items.size).toBe(0);
  });

  it('drops an access-only session whose access token has expired', async () => {
    const harness = makeAuth({ fetch: scriptedFetch([bearer({ refresh_token: undefined })]).fetch });
    const { callbackUrl } = await startSignIn(harness);
    await harness.auth.handleRedirectCallback(callbackUrl);
    harness.advance(900 * 1000);

    expect(harness.auth.restore()).toBeNull();
  });

  it('returns null rather than throwing when storage itself throws (e.g. blocked site data)', () => {
    const hostile: AuthStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };

    expect(makeAuth().auth.restore(hostile)).toBeNull();
  });
});

describe('signOut', () => {
  it('revokes the refresh token and forgets the session', async () => {
    const { fetch, calls } = scriptedFetch([bearer(), () => new Response(null, { status: 200 })]);
    const harness = makeAuth({ fetch });
    const { callbackUrl } = await startSignIn(harness);
    await harness.auth.handleRedirectCallback(callbackUrl);

    const result = await harness.auth.signOut();

    expect(result).toEqual({ outcome: 'revoked' });
    expect(calls[1].url).toBe(`${BASE_URL}/api/oauth/revoke`);
    expect(Object.fromEntries(calls[1].body)).toEqual({ token: SECRETS.refreshToken, client_id: CLIENT_ID });
    expect(harness.auth.restore()).toBeNull();
    expect(harness.storage.items.size).toBe(0);
  });

  it('forgets the session locally even when revocation fails', async () => {
    const harness = makeAuth({ fetch: scriptedFetch([bearer(), () => jsonResponse(503, {})]).fetch });
    const { callbackUrl } = await startSignIn(harness);
    await harness.auth.handleRedirectCallback(callbackUrl);

    const result = await harness.auth.signOut();

    expect(result).toMatchObject({ outcome: 'failed', retryable: true });
    expect(harness.storage.items.size).toBe(0);
  });

  it('is a no-op returning null when nobody is signed in', async () => {
    await expect(makeAuth().auth.signOut()).resolves.toBeNull();
  });
});

describe('no token value ever reaches an error or a log', () => {
  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  let spies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    spies = consoleMethods.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  it('inspects every error thrown across every failure path, and every console call', async () => {
    const errors: unknown[] = [];
    const collect = async (run: () => Promise<unknown>) => {
      errors.push(await captureError(run));
    };
    /** A server that echoes every secret back in its error body. */
    const echo = { error: `${SECRETS.code} ${SECRETS.refreshToken}`, error_description: SECRETS.accessToken };

    // Token endpoint rejects the exchange (4xx, 5xx, malformed 2xx, network).
    for (const respond of [() => jsonResponse(400, echo), () => jsonResponse(500, echo), () => jsonResponse(200, { access_token: SECRETS.accessToken })]) {
      const harness = makeAuth({ fetch: scriptedFetch([respond]).fetch });
      const { callbackUrl } = await startSignIn(harness);
      await collect(() => harness.auth.handleRedirectCallback(callbackUrl));
    }
    {
      const harness = makeAuth({ fetch: scriptedFetch([]).fetch });
      const { callbackUrl } = await startSignIn(harness);
      await collect(() => harness.auth.handleRedirectCallback(callbackUrl));
    }

    // A first-party key response, a forged state, an error redirect carrying a secret, a replay.
    {
      const harness = makeAuth({ fetch: scriptedFetch([() => jsonResponse(200, { token_type: 'mcp', access_token: SECRETS.mcpToken, scope: 's' })]).fetch });
      const { callbackUrl } = await startSignIn(harness);
      await collect(() => harness.auth.handleRedirectCallback(callbackUrl));
      await collect(() => harness.auth.handleRedirectCallback(callbackUrl));
    }
    {
      const harness = makeAuth();
      await startSignIn(harness);
      await collect(() => harness.auth.handleRedirectCallback(`${REDIRECT_URI}?code=${SECRETS.code}&state=${SECRETS.refreshToken}`));
    }
    {
      const harness = makeAuth();
      // `error_description` is carried as data (it is the redirect's own text, not anything this app holds);
      // a non-RFC `error` value is what must never be echoed.
      const { callbackUrl } = await startSignIn(harness, (state) => `error=${SECRETS.accessToken}&state=${state}`);
      await collect(() => harness.auth.handleRedirectCallback(callbackUrl));
    }

    // A signed-in session whose refresh is rejected (terminal), then fails (retryable), then is used after purge.
    {
      const harness = makeAuth({ fetch: scriptedFetch([bearer(), () => jsonResponse(400, echo)]).fetch });
      const { callbackUrl } = await startSignIn(harness);
      const provider = await harness.auth.handleRedirectCallback(callbackUrl);
      harness.advance(900 * 1000);
      await collect(() => provider.getAccessToken());
      await collect(() => provider.getAccessToken());
      expectNoSecret(JSON.stringify(provider));
    }
    {
      const harness = makeAuth({ fetch: scriptedFetch([bearer(), () => jsonResponse(503, echo)]).fetch });
      const { callbackUrl } = await startSignIn(harness);
      const provider = await harness.auth.handleRedirectCallback(callbackUrl);
      harness.advance(900 * 1000);
      await collect(() => provider.getAccessToken());
    }

    // Configuration failures.
    for (const baseUrl of [`http://${SECRETS.accessToken}.example`, SECRETS.refreshToken]) {
      try {
        makeAuth({ baseUrl });
      } catch (error) {
        errors.push(error);
      }
    }

    expect(errors.length).toBeGreaterThanOrEqual(13);
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expectNoSecret(everythingVisible(error));
    }
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('never serializes a secret through the PageSpaceAuth instance itself', async () => {
    const harness = makeAuth({ fetch: scriptedFetch([bearer()]).fetch });
    const { callbackUrl } = await startSignIn(harness);
    await harness.auth.handleRedirectCallback(callbackUrl);

    expectNoSecret(JSON.stringify(harness.auth));
  });
});

// Compile-time: OAuthTokenProviderOptions stays an extendable interface (2.5.0 callers may extend it).
interface LegacyProviderOptions extends OAuthTokenProviderOptions {
  readonly label?: string;
}
const legacyOptions: LegacyProviderOptions = {
  initialTokens: { accessToken: 'a', accessExpiresAt: 0, refreshToken: 'r', refreshExpiresAt: 0 },
  refreshAccessToken: async () => ({ accessToken: 'a', accessExpiresAt: 0, refreshToken: 'r', refreshExpiresAt: 0 }),
};
describe('OAuthTokenProviderOptions compatibility', () => {
  it('still accepts an object typed through an interface that extends it', () => {
    expect(new OAuthTokenProvider(legacyOptions)).toBeInstanceOf(OAuthTokenProvider);
  });
});
