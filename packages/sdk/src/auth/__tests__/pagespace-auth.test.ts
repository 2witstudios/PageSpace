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

  it('rejects a base URL with surrounding whitespace (it would end up inside every endpoint URL)', () => {
    expect(isAcceptableBaseUrl(' https://pagespace.example ')).toBe(false);
    expect(isAcceptableBaseUrl('https://pagespace.example\n')).toBe(false);
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

  it('a rotated pair that cannot be stored is revoked and the provider fails closed — no token lives on outside storage', async () => {
    const server = rotatingServer();
    const world = sharedWorld(server.fetch);
    const provider = await world.signIn(world.make(), 'carol');
    world.storage.setItem = () => {
      throw new Error('QuotaExceededError');
    };

    world.advance(900 * 1000);
    const first = await captureError(() => provider.getAccessToken());
    const second = await captureError(() => provider.getAccessToken());

    expect(isAuthenticationError(first)).toBe(true);
    expect(isAuthenticationError(second)).toBe(true);
    expect(server.refreshCalls).toEqual(['ps_rt_carol~1']);
    expect(server.revoked).toEqual(['ps_rt_carol~2']);
    expect(world.storage.items.size).toBe(0);
  });

  it('a one-off failed write is retried; signOut then revokes the newest token and nothing comes back', async () => {
    const server = rotatingServer();
    const world = sharedWorld(server.fetch);
    const auth = world.make();
    const provider = await world.signIn(auth, 'hal');
    const realSetItem = world.storage.setItem.bind(world.storage);
    let failNext = true;
    world.storage.setItem = (key, value) => {
      if (failNext && key.startsWith('pagespace.auth.session')) {
        failNext = false;
        throw new Error('QuotaExceededError');
      }
      realSetItem(key, value);
    };

    world.advance(900 * 1000);
    await expect(provider.getAccessToken()).resolves.toBe('ps_at_hal~2');
    await auth.signOut();
    world.advance(900 * 1000);
    const afterSignOut = await captureError(() => provider.getAccessToken());

    expect(server.revoked).toEqual(['ps_rt_hal~2']);
    expect(isAuthenticationError(afterSignOut)).toBe(true);
    expect(server.refreshCalls).toEqual(['ps_rt_hal~1']);
    expect(world.make().restore()).toBeNull();
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
      const error = await captureError(() => gus.getAccessToken());

      expect(isAuthenticationError(error)).toBe(true);
      expect(world.storage.getItem(`pagespace.auth.session:${CLIENT_ID}`)).toBe(otherRealmRecord);
      expect(server.revoked).toEqual(['ps_rt_gus~2']); // the replaced sign-in's fresh pair is ended, not left alive
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
    await captureError(() => a.getAccessToken());
    const error = await captureError(async () => b?.getAccessToken());

    expect(isAuthenticationError(error)).toBe(true);
    expect(server.refreshCalls).toEqual(['ps_rt_carol~1']);
  });

  it('a sign-in whose session cannot be stored fails with storage_unavailable and is revoked, as is the sign-in it replaced', async () => {
    const server = rotatingServer();
    const world = sharedWorld(server.fetch);
    await world.signIn(world.make(), 'dan');
    const realSetItem = world.storage.setItem.bind(world.storage);
    world.storage.setItem = (key, value) => {
      if (key.startsWith('pagespace.auth.session')) throw new Error('QuotaExceededError');
      realSetItem(key, value);
    };

    const error = await captureError(() => world.signIn(world.make(), 'erin'));

    expect(isSignInError(error) && error.reason).toBe('storage_unavailable');
    expect(server.revoked).toEqual(['ps_rt_dan~1', 'ps_rt_erin~2']);
    expect(world.storage.items.size).toBe(0);
  });

  it('a new sign-in in the same storage revokes the sign-in it replaces', async () => {
    const server = rotatingServer();
    const world = sharedWorld(server.fetch);
    await world.signIn(world.make(), 'ivy');
    await world.signIn(world.make(), 'jay');

    expect(server.revoked).toEqual(['ps_rt_ivy~1']);
  });

  it('a rotation whose record was signed out of by another realm mid-call revokes what it received and does not write it back', async () => {
    vi.stubGlobal('navigator', {});
    try {
      const server = rotatingServer();
      let world!: ReturnType<typeof sharedWorld>;
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body === 'string' && init.body.includes('grant_type=refresh_token')) {
          world.storage.removeItem(`pagespace.auth.session:${CLIENT_ID}`); // another tab signed out
        }
        return server.fetch(input, init);
      }) as typeof fetch;
      world = sharedWorld(fetchImpl);
      const kim = await world.signIn(world.make(), 'kim');

      world.advance(900 * 1000);
      const error = await captureError(() => kim.getAccessToken());

      expect(isAuthenticationError(error)).toBe(true);
      expect(server.revoked).toEqual(['ps_rt_kim~2']);
      expect(world.storage.items.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a network failure while picking up another provider\'s newer rotation never leads to replaying a spent token', async () => {
    const server = rotatingServer();
    let refreshAttempts = 0;
    const flakyFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === 'string' && init.body.includes('grant_type=refresh_token')) {
        refreshAttempts += 1;
        if (refreshAttempts === 2) throw new TypeError('network down'); // never reaches the server
      }
      return server.fetch(input, init);
    }) as typeof fetch;
    const world = sharedWorld(flakyFetch);
    const auth = world.make();
    const p1 = await world.signIn(auth, 'lou');
    const p2 = auth.restore();

    world.advance(900 * 1000);
    await p1.getAccessToken(); // rotation 1 stored
    world.advance(900 * 1000); // stored access token now stale for p2 too
    await captureError(async () => p2?.getAccessToken()); // picks up rotation 1, network fails
    const retried = await p2?.getAccessToken();

    expect(retried).toBe('ps_at_lou~3');
    expect(server.refreshCalls).toEqual(['ps_rt_lou~1', 'ps_rt_lou~2']); // no replay of a spent token
  });

  it('a signOut whose revocation fails can be retried: the next signOut revokes it', async () => {
    const server = rotatingServer();
    let revokeFailures = 1;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/revoke') && revokeFailures > 0) {
        revokeFailures -= 1;
        return jsonResponse(503, {});
      }
      return server.fetch(input, init);
    }) as typeof fetch;
    const world = sharedWorld(fetchImpl);
    const auth = world.make();
    await world.signIn(auth, 'max');

    const first = await auth.signOut();
    const second = await world.make().signOut();
    const third = await auth.signOut();

    expect(first).toMatchObject({ outcome: 'failed', retryable: true });
    expect(second).toEqual({ outcome: 'revoked' });
    expect(server.revoked).toEqual(['ps_rt_max~1']);
    expect(third).toBeNull();
    expect(world.storage.items.size).toBe(0);
  });

  it('after signOut, a provider this instance created stops serving its cached access token', async () => {
    const server = rotatingServer();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith('/revoke') ? jsonResponse(503, {}) : server.fetch(input, init)) as typeof fetch;
    const world = sharedWorld(fetchImpl);
    const auth = world.make();
    const provider = await world.signIn(auth, 'ned');

    await auth.signOut(); // revocation fails, so the server would still honour the access token
    const error = await captureError(() => provider.getAccessToken());

    expect(isAuthenticationError(error)).toBe(true);
    expect(server.refreshCalls).toEqual([]);
  });

  it('a storage read that throws once is a retryable hiccup, not the end of the session', async () => {
    const server = rotatingServer();
    const world = sharedWorld(server.fetch);
    const provider = await world.signIn(world.make(), 'oli');
    const realGetItem = world.storage.getItem.bind(world.storage);
    let sessionReads = 0;
    world.storage.getItem = (key) => {
      // Read 1 is the provider's "still stored?" check; read 2 is the refresh's own read — the one that throws.
      if (key.startsWith('pagespace.auth.session') && ++sessionReads === 2) throw new Error('SecurityError');
      return realGetItem(key);
    };

    world.advance(900 * 1000);
    const hiccup = await captureError(() => provider.getAccessToken());
    const retried = await provider.getAccessToken();

    expect(isAuthenticationError(hiccup)).toBe(false);
    expect(retried).toBe('ps_at_oli~2');
    expect(server.revoked).toEqual([]);
  });

  it('a storage read that throws right after the rotation still persists the new pair (and revokes nothing)', async () => {
    const server = rotatingServer();
    const world = sharedWorld(server.fetch);
    const provider = await world.signIn(world.make(), 'pat');
    const realGetItem = world.storage.getItem.bind(world.storage);
    let sessionReads = 0;
    world.storage.getItem = (key) => {
      if (key.startsWith('pagespace.auth.session')) {
        sessionReads += 1;
        if (sessionReads === 3) throw new Error('SecurityError'); // after the "still stored?" check and the refresh's first read: the read after the network call
      }
      return realGetItem(key);
    };

    world.advance(900 * 1000);
    await expect(provider.getAccessToken()).resolves.toBe('ps_at_pat~2');

    expect(server.revoked).toEqual([]);
    expect(world.storage.dump()).toContain('ps_rt_pat~2');
  });

  it('never deletes a record written for another PageSpace deployment that shares the client id', async () => {
    const server = rotatingServer();
    const world = sharedWorld(server.fetch);
    await world.signIn(world.make(), 'pam');
    const prodRecord = world.storage.dump();
    const staging = new PageSpaceAuth({ baseUrl: 'https://staging.example', clientId: CLIENT_ID, redirectUri: REDIRECT_URI, storage: world.storage, now: () => 1_000_000 });

    expect(staging.restore()).toBeNull();
    await expect(staging.signOut()).resolves.toBeNull();
    expect(world.storage.dump()).toBe(prodRecord);
  });

  it('a new sign-in does not wait for revoking the session it replaces', async () => {
    const server = rotatingServer();
    let releaseRevoke!: () => void;
    const revokeGate = new Promise<void>((resolve) => {
      releaseRevoke = resolve;
    });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/revoke')) await revokeGate;
      return server.fetch(input, init);
    }) as typeof fetch;
    const world = sharedWorld(fetchImpl);
    await world.signIn(world.make(), 'quinn');

    const second = await world.signIn(world.make(), 'rae'); // would hang if the revoke were awaited

    expect(second).toBeInstanceOf(OAuthTokenProvider);
    releaseRevoke();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.revoked).toEqual(['ps_rt_quinn~1']);
  });

  it('a replaced sign-in whose background revocation fails is kept for the next signOut to retry', async () => {
    const server = rotatingServer();
    let failRevokes = 1;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/revoke') && failRevokes > 0) {
        failRevokes -= 1;
        throw new TypeError('network down');
      }
      return server.fetch(input, init);
    }) as typeof fetch;
    const world = sharedWorld(fetchImpl);
    await world.signIn(world.make(), 'sam');
    const auth = world.make();
    await world.signIn(auth, 'tia');
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the background revocation settle

    const result = await auth.signOut();

    expect(result).toEqual({ outcome: 'revoked' });
    expect(server.revoked.sort()).toEqual(['ps_rt_sam~1', 'ps_rt_tia~2']);
  });

  it('signOut with unreadable storage reports a retryable failure instead of "nobody signed in"', async () => {
    const server = rotatingServer();
    const world = sharedWorld(server.fetch);
    const auth = world.make();
    await world.signIn(auth, 'uma');
    const realGetItem = world.storage.getItem.bind(world.storage);
    world.storage.getItem = () => {
      throw new Error('SecurityError');
    };

    const result = await auth.signOut();
    world.storage.getItem = realGetItem;

    expect(result).toMatchObject({ outcome: 'failed', retryable: true });
    await expect(auth.signOut()).resolves.toEqual({ outcome: 'revoked' });
  });

  it('overlapping signOuts never lose a pending revocation (merge, not overwrite)', async () => {
    const server = rotatingServer();
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/revoke')) {
        const token = new URLSearchParams(typeof init?.body === 'string' ? init.body : '').get('token') ?? '';
        if (token.startsWith('ps_rt_vic')) {
          await gateA;
          return jsonResponse(503, {}); // A's revocation fails
        }
        await gateB; // B's revocation succeeds
      }
      return server.fetch(input, init);
    }) as typeof fetch;
    const world = sharedWorld(fetchImpl);
    const a = world.make();
    await world.signIn(a, 'vic');
    const aOut = a.signOut(); // reads an empty pending list, removes vic's record, revocation in flight
    await new Promise((resolve) => setTimeout(resolve, 0));
    const b = world.make();
    await world.signIn(b, 'wes');
    const bOut = b.signOut(); // also reads an empty pending list
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseA();
    await aOut; // A records vic~1 as pending
    releaseB();
    await bOut; // B must not overwrite A's pending entry

    expect(server.revoked).toEqual(['ps_rt_wes~2']);
    const pendingKeys = [...world.storage.items.keys()].filter((key) => key.startsWith('pagespace.auth.revoke-pending'));
    expect(pendingKeys).toHaveLength(1);
    expect(world.storage.getItem(pendingKeys[0])).toContain('ps_rt_vic~1');
  });

  it('a pending-revocation read that throws once never wipes the list', async () => {
    const server = rotatingServer();
    let failRevoke = true;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/revoke') && failRevoke) {
        failRevoke = false;
        return jsonResponse(503, {});
      }
      return server.fetch(input, init);
    }) as typeof fetch;
    const world = sharedWorld(fetchImpl);
    const auth = world.make();
    await world.signIn(auth, 'xia');
    await auth.signOut(); // pending [xia~1]
    const realGetItem = world.storage.getItem.bind(world.storage);
    let throwPendingOnce = true;
    world.storage.getItem = (key) => {
      if (throwPendingOnce && key.startsWith('pagespace.auth.revoke-pending')) {
        throwPendingOnce = false;
        throw new Error('SecurityError');
      }
      return realGetItem(key);
    };
    await world.signIn(auth, 'yan');
    await auth.signOut(); // pending read throws: must not overwrite the list

    await auth.signOut(); // now retries xia~1
    expect(server.revoked).toContain('ps_rt_xia~1');
  });

  it('a signOut that cannot read the pending list never overwrites it, even when it has a failure of its own to record', async () => {
    const server = rotatingServer();
    const failing = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith('/revoke') ? jsonResponse(503, {}) : server.fetch(input, init)) as typeof fetch;
    const world = sharedWorld(failing);
    const auth = world.make();
    await world.signIn(auth, 'bea');
    await auth.signOut(); // pending [bea~1]
    await world.signIn(auth, 'cal');
    const realGetItem = world.storage.getItem.bind(world.storage);
    world.storage.getItem = (key) => {
      if (key.startsWith('pagespace.auth.revoke-pending')) throw new Error('SecurityError');
      return realGetItem(key);
    };

    await auth.signOut(); // cal~2's revocation fails too, but the list cannot be read

    world.storage.getItem = realGetItem;
    const pendingKey = [...world.storage.items.keys()].find((key) => key.startsWith('pagespace.auth.revoke-pending')) ?? '';
    expect(world.storage.getItem(pendingKey)).toContain('ps_rt_bea~1');
  });

  it('signOut also covers a storage this instance restored a session from', async () => {
    const server = rotatingServer();
    const world = sharedWorld(server.fetch);
    await world.signIn(world.make(), 'zed');
    const elsewhere = new PageSpaceAuth({ baseUrl: BASE_URL, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, storage: new MemoryStorage(), fetch: server.fetch, now: () => 1_000_000 });
    const provider = elsewhere.restore(world.storage);
    expect(provider).not.toBeNull();

    await expect(elsewhere.signOut()).resolves.toEqual({ outcome: 'revoked' });
    expect(server.revoked).toEqual(['ps_rt_zed~1']);
    expect(world.storage.items.size).toBe(0);
  });

  it('pending revocations are kept per deployment: one deployment never wipes another\'s', async () => {
    const server = rotatingServer();
    const prodFails = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input) === `${BASE_URL}/api/oauth/revoke` ? jsonResponse(503, {}) : server.fetch(input, init)) as typeof fetch;
    const world = sharedWorld(prodFails);
    const prod = world.make();
    await world.signIn(prod, 'amy');
    await prod.signOut(); // prod's revocation fails: pending for BASE_URL

    const stagingAssigned: string[] = [];
    const staging = new PageSpaceAuth({
      baseUrl: 'https://staging.example',
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      storage: world.storage,
      fetch: prodFails,
      assign: (url) => {
        stagingAssigned.push(url);
      },
      now: () => 1_000_000,
      randomBytes: countingRandomBytes(),
    });
    await staging.signInWithRedirect();
    const state = new URL(stagingAssigned[0]).searchParams.get('state') ?? '';
    await staging.handleRedirectCallback(`${REDIRECT_URI}?code=stg&state=${state}`);
    await expect(staging.signOut()).resolves.toEqual({ outcome: 'revoked' });

    const prodRetry = new PageSpaceAuth({ baseUrl: BASE_URL, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, storage: world.storage, fetch: server.fetch, now: () => 1_000_000 });
    await expect(prodRetry.signOut()).resolves.toEqual({ outcome: 'revoked' });
    expect(server.revoked).toContain('ps_rt_amy~1');
  });

  it('signOut reports a retryable failure when one storage is unreadable, even if another storage signed out fine', async () => {
    const server = rotatingServer();
    const world = sharedWorld(server.fetch);
    const auth = world.make();
    await world.signIn(auth, 'dee'); // configured storage
    const other = sharedWorld(server.fetch);
    await other.signIn(other.make(), 'eve');
    expect(auth.restore(other.storage)).not.toBeNull();
    const realGetItem = world.storage.getItem.bind(world.storage);
    world.storage.getItem = () => {
      throw new Error('SecurityError');
    };

    const result = await auth.signOut();
    world.storage.getItem = realGetItem;

    expect(result).toMatchObject({ outcome: 'failed', retryable: true });
    await expect(auth.signOut()).resolves.toEqual({ outcome: 'revoked' });
    expect(server.revoked).toContain('ps_rt_dee~1');
  });

  it('the token being revoked is queued BEFORE the request goes out, so leaving mid-revocation loses nothing', async () => {
    const server = rotatingServer();
    const hang = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith('/revoke') ? new Promise<Response>(() => undefined) : server.fetch(input, init)) as typeof fetch;
    const world = sharedWorld(hang);
    const auth = world.make();
    await world.signIn(auth, 'fin');

    void auth.signOut(); // the revocation never answers (the page navigates away)
    await new Promise((resolve) => setTimeout(resolve, 0));

    const pendingKey = [...world.storage.items.keys()].find((key) => key.startsWith('pagespace.auth.revoke-pending')) ?? '';
    expect(world.storage.getItem(pendingKey)).toContain('ps_rt_fin~1');
  });

  it('a replaced sign-in is queued for revocation before its background request goes out', async () => {
    const server = rotatingServer();
    const hang = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith('/revoke') ? new Promise<Response>(() => undefined) : server.fetch(input, init)) as typeof fetch;
    const world = sharedWorld(hang);
    await world.signIn(world.make(), 'gil');

    await world.signIn(world.make(), 'hana'); // then the callback page navigates away

    const pendingKey = [...world.storage.items.keys()].find((key) => key.startsWith('pagespace.auth.revoke-pending')) ?? '';
    expect(world.storage.getItem(pendingKey)).toContain('ps_rt_gil~1');
  });

  it('a replaced sign-in whose write-ahead queue entry could not be written is still queued when its revocation fails', async () => {
    const server = rotatingServer();
    let revokeFails = true;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/revoke') && revokeFails) {
        revokeFails = false;
        return jsonResponse(503, {});
      }
      return server.fetch(input, init);
    }) as typeof fetch;
    const world = sharedWorld(fetchImpl);
    await world.signIn(world.make(), 'kai');
    const realSetItem = world.storage.setItem.bind(world.storage);
    let pendingWritesFail = true;
    world.storage.setItem = (key, value) => {
      if (pendingWritesFail && key.startsWith('pagespace.auth.revoke-pending')) throw new Error('QuotaExceededError');
      realSetItem(key, value);
    };
    const auth = world.make();
    const signingIn = world.signIn(auth, 'lia');
    await signingIn;
    pendingWritesFail = false; // storage recovers before the background revocation answers
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await auth.signOut();

    expect(server.revoked).toContain('ps_rt_kai~1');
  });

  it('a queued revocation is cleared once the server accepts it', async () => {
    const server = rotatingServer();
    const world = sharedWorld(server.fetch);
    const auth = world.make();
    await world.signIn(world.make(), 'ian');
    await world.signIn(auth, 'joy');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await auth.signOut();

    expect([...world.storage.items.keys()]).toEqual([]);
    expect(server.revoked.sort()).toEqual(['ps_rt_ian~1', 'ps_rt_joy~2']);
  });

  it('a definitively rejected refresh removes the record and revokes the rejected token, so nothing replays it later', async () => {
    const server = rotatingServer();
    let malformed = true;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === 'string' && init.body.includes('grant_type=refresh_token') && malformed) {
        malformed = false;
        await server.fetch(input, init); // the server rotates…
        return new Response('<html>proxy error</html>', { status: 200 }); // …but the answer is unreadable
      }
      return server.fetch(input, init);
    }) as typeof fetch;
    const world = sharedWorld(fetchImpl);
    const provider = await world.signIn(world.make(), 'mia');

    world.advance(900 * 1000);
    const error = await captureError(() => provider.getAccessToken());

    expect(isAuthenticationError(error)).toBe(true);
    expect(world.make().restore()).toBeNull();
    expect(server.revoked).toEqual(['ps_rt_mia~1']); // ends the family whose new pair was lost
    expect(server.refreshCalls).toEqual(['ps_rt_mia~1']);
  });

  it('a rejected refresh never erases a newer rotation another realm stored meanwhile', async () => {
    vi.stubGlobal('navigator', {});
    try {
      let world!: ReturnType<typeof sharedWorld>;
      let winner = '';
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
        if (body.get('grant_type') === 'authorization_code') {
          return jsonResponse(200, { access_token: 'ps_at_ora~1', token_type: 'Bearer', expires_in: 900, refresh_token: 'ps_rt_ora~1', scope: 'profile offline_access' });
        }
        if (body.get('grant_type') === 'refresh_token') {
          // Another tab (no shared lock) rotated first and stored its pair…
          const record = JSON.parse(world.storage.getItem(`pagespace.auth.session:${CLIENT_ID}`) ?? '{}') as Record<string, unknown>;
          winner = JSON.stringify({ ...record, rotation: 1, accessToken: 'ps_at_ora~2', refreshToken: 'ps_rt_ora~2', accessExpiresAt: 99_999_999_999 });
          world.storage.setItem(`pagespace.auth.session:${CLIENT_ID}`, winner);
          return jsonResponse(400, { error: 'invalid_grant' }); // …so this presentation is refused
        }
        return new Response(null, { status: 200 });
      }) as typeof fetch;
      world = sharedWorld(fetchImpl);
      const provider = await world.signIn(world.make(), 'ora');

      world.advance(900 * 1000);
      await captureError(() => provider.getAccessToken());

      expect(world.storage.getItem(`pagespace.auth.session:${CLIENT_ID}`)).toBe(winner);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a provider in ANOTHER instance stops serving its cached access token once the sign-in is signed out', async () => {
    const server = rotatingServer();
    const failingRevoke = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith('/revoke') ? jsonResponse(503, {}) : server.fetch(input, init)) as typeof fetch;
    const world = sharedWorld(failingRevoke);
    const provider = await world.signIn(world.make(), 'noa');
    await expect(provider.getAccessToken()).resolves.toBe('ps_at_noa~1');

    await world.make().signOut(); // another tab; revocation fails, so the server still honours the token

    const error = await captureError(() => provider.getAccessToken());
    expect(isAuthenticationError(error)).toBe(true);
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

  it('forgets the session locally even when revocation fails, keeping only the pending revocation to retry', async () => {
    const harness = makeAuth({ fetch: scriptedFetch([bearer(), () => jsonResponse(503, {})]).fetch });
    const { callbackUrl } = await startSignIn(harness);
    await harness.auth.handleRedirectCallback(callbackUrl);

    const result = await harness.auth.signOut();

    expect(result).toMatchObject({ outcome: 'failed', retryable: true });
    expect(harness.auth.restore()).toBeNull();
    expect([...harness.storage.items.keys()]).toEqual([`pagespace.auth.revoke-pending:${CLIENT_ID}:${BASE_URL}`]);
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
