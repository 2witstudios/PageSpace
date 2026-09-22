/**
 * `PageSpaceAuth` — "Sign in with PageSpace" for a browser app (Phase 3
 * leaf 2; ADR 0004 Decision 11). A thin façade over the pure functions in
 * `sign-in.ts` and the token-endpoint calls in `token-endpoint.ts`:
 *
 *   signInWithRedirect()      → store {state, codeVerifier, redirectUri}, navigate to /api/oauth/authorize
 *   handleRedirectCallback(u) → check state, exchange the code, return an OAuthTokenProvider
 *   restore()                 → the same provider again after a reload
 *   signOut()                 → revoke the refresh token and forget the session
 *
 * Every edge is injected — storage (default `sessionStorage`), navigation
 * (default `location.assign`), `fetch`, the clock and randomness — so the
 * whole flow runs under test with no browser and no network.
 *
 * Public client + PKCE only: there is no secret to configure, and the one
 * value that proves possession — the code verifier — never leaves storage
 * except in the token request itself.
 *
 * Tokens never reach an error or a log. This module builds every error
 * message from constants, never from a token, a code, a URL or a server
 * body; tokens live in storage and in the provider's private fields, and
 * this class holds no token field of its own (so `JSON.stringify` on it
 * shows none).
 */
import { z } from 'zod';
import { AuthenticationError, NetworkError } from '../errors.js';
import { OAuthTokenProvider, type OAuthTokens, type RefreshAccessToken } from './oauth.js';
import { deriveCodeChallenge, generateCodeVerifier } from './pkce.js';
import {
  buildAuthorizeUrl,
  PAGESPACE_CALLBACK_PATH,
  pageSpaceOAuthEndpoints,
  parseCallback,
  type AuthorizationErrorCode,
  type CallbackError,
} from './sign-in.js';
import {
  createTokenEndpointRefresh,
  exchangeAuthorizationCode,
  revokeToken,
  toOAuthTokens,
  type RevokeTokenResult,
} from './token-endpoint.js';

/** The subset of the Web Storage API this module uses — `sessionStorage`, `localStorage`, or anything shaped like them. */
export interface AuthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PageSpaceAuthOptions {
  /** The PageSpace deployment, e.g. `https://pagespace.ai`. Must be https (plain http only for loopback development). */
  readonly baseUrl: string;
  /** The `client_id` PageSpace issued when the app was registered. Public — not a secret. */
  readonly clientId: string;
  /** Must exactly match a redirect URI registered on the client; conventionally `<origin>` + `PAGESPACE_CALLBACK_PATH`. */
  readonly redirectUri: string;
  /** Space-delimited scope for every sign-in; defaults to `"profile offline_access"`. */
  readonly scope?: string;
  /**
   * Where the pending sign-in and the signed-in session are kept. Defaults to
   * `sessionStorage` (per tab, gone when the tab closes). `null` means "none
   * available" and makes every call that needs storage fail closed.
   */
  readonly storage?: AuthStorage | null;
  /** Navigates the browser; defaults to `location.assign`. */
  readonly assign?: (url: string) => void;
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Cryptographically secure random bytes; defaults to `crypto.getRandomValues`. */
  readonly randomBytes?: (length: number) => Uint8Array;
}

export interface SignInOptions {
  /** Overrides the configured scope for this sign-in only. */
  readonly scope?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A PageSpace app configuration that cannot be used safely — thrown before any request is made. */
export class PageSpaceConfigError extends Error {
  readonly code = 'CONFIGURATION_ERROR' as const;
  /** The configuration fields (or environment variables) that are missing or invalid. */
  readonly fields: readonly string[];

  constructor(message: string, fields: readonly string[]) {
    super(message);
    this.name = 'PageSpaceConfigError';
    this.fields = fields;
  }
}

export function isPageSpaceConfigError(error: unknown): error is PageSpaceConfigError {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'CONFIGURATION_ERROR';
}

export type SignInErrorReason =
  | CallbackError['reason']
  /** No sign-in was started in this storage, or it was already finished (a replayed callback). */
  | 'no_pending_sign_in'
  /** The sign-in was started more than `PENDING_SIGN_IN_TTL_MS` ago. */
  | 'pending_sign_in_expired'
  /** The token endpoint answered with a first-party key shape instead of a Bearer pair. */
  | 'unexpected_token_type'
  /** No usable storage (none given, none in this environment, or it threw). */
  | 'storage_unavailable'
  /** No way to navigate (no `assign` given and no `location` in this environment). */
  | 'navigation_unavailable';

const SIGN_IN_ERROR_MESSAGES: Readonly<Record<SignInErrorReason, string>> = {
  state_mismatch: 'The sign-in callback does not answer a sign-in this app started (state mismatch).',
  missing_code: 'The sign-in callback carried no authorization code.',
  malformed_callback: 'The sign-in callback is not a valid URL.',
  authorization_error: 'PageSpace did not authorize the sign-in.',
  no_pending_sign_in: 'No sign-in is in progress in this browser session (or it was already completed).',
  pending_sign_in_expired: 'The sign-in took too long to complete; start it again.',
  unexpected_token_type: 'PageSpace answered with a credential type an app sign-in never receives.',
  storage_unavailable: 'No storage is available to keep the sign-in state.',
  navigation_unavailable: 'No way to navigate to PageSpace was provided.',
};

/**
 * A sign-in that could not complete for a reason other than the token
 * endpoint itself (whose failures arrive as the SDK's classified errors —
 * `ValidationError`, `RateLimitError`, `NetworkError`, …).
 */
export class SignInError extends Error {
  readonly code = 'SIGN_IN_ERROR' as const;
  readonly reason: SignInErrorReason;
  /** Set when `reason` is `'authorization_error'`: the RFC 6749 §4.1.2.1 code, e.g. `'access_denied'`. */
  readonly authorizationError: AuthorizationErrorCode | 'unrecognized' | null;
  /** Set when `reason` is `'authorization_error'` and the server sent a well-formed description. */
  readonly errorDescription: string | null;

  constructor(reason: SignInErrorReason, details: { authorizationError?: AuthorizationErrorCode | 'unrecognized'; errorDescription?: string | null } = {}) {
    super(SIGN_IN_ERROR_MESSAGES[reason]);
    this.name = 'SignInError';
    this.reason = reason;
    this.authorizationError = details.authorizationError ?? null;
    this.errorDescription = details.errorDescription ?? null;
  }
}

export function isSignInError(error: unknown): error is SignInError {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'SIGN_IN_ERROR';
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export const DEFAULT_SIGN_IN_SCOPE = 'profile offline_access';

/**
 * How long a started sign-in (its state + verifier) stays redeemable. It spans
 * the whole trip through PageSpace — which can include signing up, waiting
 * for a magic-link email and a step-up check — so it is deliberately longer
 * than the authorization code itself, which the provider expires 60 seconds
 * after consent regardless of this value.
 */
export const PENDING_SIGN_IN_TTL_MS = 30 * 60 * 1000;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Pure: https anywhere; plain http only on loopback, where there is no network for a code to cross. */
export function isAcceptableBaseUrl(baseUrl: string): boolean {
  // A query or fragment would silently become part of every endpoint URL
  // (`https://host#` + `/api/oauth/token` posts to `/`). Checked on the raw
  // string: `new URL('https://host#').hash` is empty.
  if (baseUrl.includes('?') || baseUrl.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const pendingSchema = z.object({
  v: z.literal(1),
  state: z.string().min(1),
  codeVerifier: z.string().min(43).max(128),
  redirectUri: z.string().min(1),
  createdAt: z.number(),
});
type PendingSignIn = z.infer<typeof pendingSchema>;

const sessionSchema = z.object({
  v: z.literal(1),
  baseUrl: z.string(),
  /** Minted at sign-in and kept through every rotation: which sign-in this record belongs to. */
  lineage: z.string().min(1),
  /** 0 at sign-in, +1 per rotation: how new this pair is within its lineage. */
  rotation: z.number().int().nonnegative(),
  accessToken: z.string().min(1),
  accessExpiresAt: z.number(),
  refreshToken: z.string().min(1).nullable(),
  refreshExpiresAt: z.number(),
  scope: z.string(),
});
type StoredSession = z.infer<typeof sessionSchema>;

/** Tokens a signOut() could not get the server to revoke: kept (and retried by the next signOut) rather than lost. */
const pendingRevocationSchema = z.object({
  v: z.literal(1),
  baseUrl: z.string(),
  tokens: z.array(z.string().min(1)).min(1),
});

/** Pure: parse-and-validate a stored JSON record, or null for anything absent, unparseable or the wrong shape. */
function parseStored<T>(raw: string | null, schema: z.ZodType<T>): T | null {
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Pure: whether two base URLs name the same deployment (a trailing slash is not a different server). */
function sameDeployment(a: string, b: string): boolean {
  return trimTrailingSlashes(a) === trimTrailingSlashes(b);
}

/** Pure: whether a stored session can still yield an access token at `now`. */
function isSessionUsable(session: StoredSession, now: number): boolean {
  return session.refreshToken === null ? now < session.accessExpiresAt : now < session.refreshExpiresAt;
}

/**
 * Pure: the two environment variables + the page origin → the three values
 * `PageSpaceAuth` needs, or a `PageSpaceConfigError` naming every one that
 * is missing or unusable. Values are trimmed; a blank value is missing. The
 * message names variables, never their values.
 */
export function resolveEnvironmentConfig(
  env: Readonly<Record<string, string | undefined>>,
  origin: string | undefined,
): { readonly baseUrl: string; readonly clientId: string; readonly redirectUri: string } {
  const baseUrl = env.PAGESPACE_URL?.trim() ?? '';
  const clientId = env.PAGESPACE_CLIENT_ID?.trim() ?? '';
  const appOrigin = origin?.trim() ?? '';
  const invalid = [
    ...(isAcceptableBaseUrl(baseUrl) ? [] : ['PAGESPACE_URL']),
    ...(clientId.length > 0 ? [] : ['PAGESPACE_CLIENT_ID']),
    // `location.origin` is the string "null" for an opaque origin (file:, sandboxed iframe) — nothing can redirect back there.
    ...(appOrigin.length > 0 && appOrigin !== 'null' ? [] : ['origin']),
  ];
  if (invalid.length > 0) {
    throw new PageSpaceConfigError(
      `Sign in with PageSpace is not configured: ${invalid.join(', ')} missing or invalid (PAGESPACE_URL must be https, or http on localhost/127.0.0.1)`,
      invalid,
    );
  }
  return { baseUrl, clientId, redirectUri: `${trimTrailingSlashes(appOrigin)}${PAGESPACE_CALLBACK_PATH}` };
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

// ---------------------------------------------------------------------------
// Ambient defaults (resolved lazily, so constructing on a server never throws)
// ---------------------------------------------------------------------------

function ambientSessionStorage(): AuthStorage | null {
  try {
    const storage = (globalThis as { sessionStorage?: AuthStorage }).sessionStorage;
    return storage ?? null;
  } catch {
    // Accessing sessionStorage throws a SecurityError when site data is blocked.
    return null;
  }
}

function ambientAssign(): ((url: string) => void) | null {
  const location = (globalThis as { location?: { assign?: (url: string) => void } }).location;
  return typeof location?.assign === 'function' ? (url: string) => location.assign?.(url) : null;
}

function ambientRandomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

// ---------------------------------------------------------------------------
// PageSpaceAuth
// ---------------------------------------------------------------------------

/** A stored pair is adopted without a network call only if its access token has more than this left (OAuthTokenProvider's own skew). */
const ADOPT_FRESH_SKEW_MS = 60_000;

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/** In-realm fallback queue per lock name, for environments without Web Locks (Node, older browsers). */
const localLockTails = new Map<string, Promise<unknown>>();

function withLocalLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const previous = localLockTails.get(name) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => undefined);
  localLockTails.set(name, tail);
  void tail.then(() => {
    if (localLockTails.get(name) === tail) localLockTails.delete(name);
  });
  return run;
}

/**
 * Runs `task` exclusively per `name`: under a Web Lock when the environment
 * has one (serialising this origin's tabs and instances), else in an in-realm
 * queue (serialising this JS realm only — separate processes are not
 * coordinated).
 */
function withSessionLock<T>(name: string, task: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  return typeof locks?.request === 'function' ? locks.request(name, task) : withLocalLock(name, task);
}

const VERIFIER_BYTES = 32;
const LINEAGE_BYTES = 16;
const STATE_BYTES = 32;

export class PageSpaceAuth {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly #storage: AuthStorage | null | undefined;
  readonly #assign: ((url: string) => void) | undefined;
  readonly #fetch: typeof fetch | undefined;
  readonly #now: () => number;
  readonly #randomBytes: (length: number) => Uint8Array;
  /** Providers this instance created, so signOut() can stop them serving a cached access token. */
  readonly #providers = new Set<OAuthTokenProvider>();

  constructor(options: PageSpaceAuthOptions) {
    const invalid = [
      ...(isAcceptableBaseUrl(options.baseUrl) ? [] : ['baseUrl']),
      ...(options.clientId.length > 0 ? [] : ['clientId']),
      ...(options.redirectUri.length > 0 ? [] : ['redirectUri']),
    ];
    if (invalid.length > 0) {
      throw new PageSpaceConfigError(
        `PageSpaceAuth configuration is invalid: ${invalid.join(', ')} (baseUrl must be https, or http on localhost/127.0.0.1)`,
        invalid,
      );
    }
    this.baseUrl = options.baseUrl;
    this.clientId = options.clientId;
    this.redirectUri = options.redirectUri;
    this.scope = options.scope ?? DEFAULT_SIGN_IN_SCOPE;
    this.#storage = options.storage;
    this.#assign = options.assign;
    this.#fetch = options.fetch;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? ambientRandomBytes;
  }

  get #pendingKey(): string {
    return `pagespace.auth.pending:${this.clientId}`;
  }

  get #sessionKey(): string {
    return `pagespace.auth.session:${this.clientId}`;
  }

  /** The configured storage, else `sessionStorage`; `null` when neither exists. */
  #resolveStorage(): AuthStorage | null {
    if (this.#storage === null) return null;
    return this.#storage ?? ambientSessionStorage();
  }

  #requireStorage(): AuthStorage {
    const storage = this.#resolveStorage();
    if (storage === null) throw new SignInError('storage_unavailable');
    return storage;
  }

  /**
   * Starts a sign-in and returns the authorize URL without navigating — for
   * a popup, a native in-app browser, or a server that issues its own
   * redirect. `signInWithRedirect` is this plus the navigation.
   */
  async createSignInUrl(options: SignInOptions = {}): Promise<string> {
    const storage = this.#requireStorage();
    const codeVerifier = generateCodeVerifier(this.#randomBytes(VERIFIER_BYTES));
    const state = toBase64Url(this.#randomBytes(STATE_BYTES));
    const pending: PendingSignIn = { v: 1, state, codeVerifier, redirectUri: this.redirectUri, createdAt: this.#now() };
    try {
      storage.setItem(this.#pendingKey, JSON.stringify(pending));
    } catch {
      throw new SignInError('storage_unavailable');
    }
    return buildAuthorizeUrl({
      baseUrl: this.baseUrl,
      clientId: this.clientId,
      redirectUri: this.redirectUri,
      scope: options.scope ?? this.scope,
      state,
      codeChallenge: await deriveCodeChallenge(codeVerifier),
    });
  }

  /** Starts a sign-in and sends the browser to PageSpace's consent screen. */
  async signInWithRedirect(options: SignInOptions = {}): Promise<void> {
    const assign = this.#assign ?? ambientAssign();
    if (assign === null) throw new SignInError('navigation_unavailable');
    assign(await this.createSignInUrl(options));
  }

  /**
   * Finishes a sign-in on the callback page. The pending entry is removed
   * before anything else happens, whatever the outcome — a callback can be
   * redeemed at most once. The state is compared before the code is read;
   * a forged callback never reaches the token endpoint.
   */
  async handleRedirectCallback(url: string | URL): Promise<OAuthTokenProvider> {
    const storage = this.#requireStorage();
    let raw: string | null;
    try {
      raw = storage.getItem(this.#pendingKey);
      storage.removeItem(this.#pendingKey);
    } catch {
      throw new SignInError('storage_unavailable');
    }
    const pending = parseStored(raw, pendingSchema);
    if (pending === null) throw new SignInError('no_pending_sign_in');
    if (this.#now() - pending.createdAt > PENDING_SIGN_IN_TTL_MS) throw new SignInError('pending_sign_in_expired');

    const callback = parseCallback(url, pending.state);
    if (!callback.ok) {
      const { error } = callback;
      throw error.reason === 'authorization_error'
        ? new SignInError('authorization_error', { authorizationError: error.error, errorDescription: error.errorDescription })
        : new SignInError(error.reason);
    }

    const tokens = await exchangeAuthorizationCode(
      {
        tokenEndpoint: pageSpaceOAuthEndpoints(this.baseUrl).tokenEndpoint,
        clientId: this.clientId,
        code: callback.code,
        redirectUri: pending.redirectUri,
        codeVerifier: pending.codeVerifier,
      },
      { fetch: this.#fetch },
    );
    if (tokens.kind !== 'oauth') throw new SignInError('unexpected_token_type');

    const issuedAt = this.#now();
    const lineage = toBase64Url(this.#randomBytes(LINEAGE_BYTES));
    const session: StoredSession =
      tokens.refreshToken === undefined
        ? {
            v: 1,
            baseUrl: this.baseUrl,
            lineage,
            rotation: 0,
            accessToken: tokens.accessToken,
            accessExpiresAt: issuedAt + tokens.expiresIn * 1000,
            refreshToken: null,
            refreshExpiresAt: issuedAt + tokens.expiresIn * 1000,
            scope: tokens.scope,
          }
        : {
            v: 1,
            baseUrl: this.baseUrl,
            lineage,
            rotation: 0,
            ...toOAuthTokens({ ...tokens, refreshToken: tokens.refreshToken }, issuedAt),
            scope: tokens.scope,
          };
    // Under the refresh lock: an older sign-in's refresh already in flight
    // persists first, so this newer sign-in is the record that remains.
    const outcome = await withSessionLock(this.#lockName, async () => {
      const previous = this.#readStoredSession(storage);
      return {
        replaced:
          previous.kind === 'foreign' || (previous.kind === 'present' && previous.session.lineage !== lineage) ? previous.session : null,
        persisted: this.#persistSession(storage, session),
      };
    });
    // One session per app and storage: the sign-in this one replaces is ended on the server, not just
    // forgotten — in the background (revokeToken never throws), so a slow endpoint does not delay sign-in.
    if (outcome.replaced !== null) void this.#revokeSession(outcome.replaced);
    if (!outcome.persisted) {
      // A session exists only while its record is stored — that is what lets signOut() end it.
      // Tokens that could not be stored are revoked rather than left alive in memory.
      await this.#revokeSession(session);
      throw new SignInError('storage_unavailable');
    }
    return this.#track(this.#providerFor(session, storage));
  }

  /**
   * The signed-in session kept in `storage` (default: this instance's
   * storage) as a provider again — e.g. after a page reload. Never throws:
   * nothing stored, a record for another deployment, a malformed record, an
   * expired session, or storage that throws all mean `null`. A record that
   * cannot be used is removed.
   */
  restore(storage: AuthStorage | null = this.#resolveStorage()): OAuthTokenProvider | null {
    if (storage === null) return null;
    let raw: string | null;
    try {
      raw = storage.getItem(this.#sessionKey);
    } catch {
      return null;
    }
    if (raw === null) return null;
    const session = parseStored(raw, sessionSchema);
    // Another deployment's record (same client id) is not ours to delete: its session stays revocable by its own signOut().
    if (session !== null && !sameDeployment(session.baseUrl, this.baseUrl)) return null;
    if (session === null || !isSessionUsable(session, this.#now())) {
      this.#forget(storage);
      return null;
    }
    return this.#track(this.#providerFor(session, storage));
  }

  /**
   * Revokes the stored refresh token (or, for an access-only session, the
   * access token) and forgets the session. The local session is forgotten
   * even when revocation fails; the result says whether the server accepted
   * it. `null` when nobody is signed in.
   */
  async signOut(): Promise<RevokeTokenResult | null> {
    const storage = this.#resolveStorage();
    // Providers this instance handed out stop serving their cached access token at once; their next
    // refresh finds no record and fails closed. (Providers in other tabs learn it from the server's revocation.)
    for (const provider of this.#providers) provider.invalidate();
    this.#providers.clear();
    if (storage === null) return null;
    // Under the refresh lock: a refresh already in flight (in any instance or
    // tab sharing this lock) finishes and persists first, so the token revoked
    // below is the newest one — revoking it ends the whole sign-in family.
    const toRevoke = await withSessionLock(this.#lockName, async () => {
      const tokens = this.#readPendingRevocations(storage);
      const read = this.#readStoredSession(storage);
      if (read.kind === 'present') {
        this.#forget(storage);
        tokens.unshift(read.session.refreshToken ?? read.session.accessToken);
      }
      return tokens;
    });
    if (toRevoke.length === 0) return null;

    const results = await Promise.all(
      toRevoke.map(async (token) => ({ token, result: await this.#revokeAt(this.baseUrl, token) })),
    );
    const failed = results.filter(({ result }) => result.outcome === 'failed');
    // A revocation the server did not accept is kept, not lost: the next signOut() retries it.
    await withSessionLock(this.#lockName, async () => this.#writePendingRevocations(storage, failed.map(({ token }) => token)));
    return failed.length === 0 ? { outcome: 'revoked' } : failed[0].result;
  }

  #readPendingRevocations(storage: AuthStorage): string[] {
    try {
      const pending = parseStored(storage.getItem(this.#pendingRevocationKey), pendingRevocationSchema);
      return pending !== null && sameDeployment(pending.baseUrl, this.baseUrl) ? [...pending.tokens] : [];
    } catch {
      return [];
    }
  }

  #writePendingRevocations(storage: AuthStorage, tokens: readonly string[]): void {
    try {
      if (tokens.length === 0) {
        storage.removeItem(this.#pendingRevocationKey);
      } else {
        storage.setItem(this.#pendingRevocationKey, JSON.stringify({ v: 1, baseUrl: this.baseUrl, tokens }));
      }
    } catch {
      // Best effort: the failure was already reported to the caller as the signOut() result.
    }
  }

  get #pendingRevocationKey(): string {
    return `pagespace.auth.revoke-pending:${this.clientId}`;
  }

  #track(provider: OAuthTokenProvider): OAuthTokenProvider {
    this.#providers.add(provider);
    return provider;
  }

  /** Revokes a stored session's refresh token (its whole family), or its access token when it has none. Never throws. */
  #revokeSession(session: StoredSession): Promise<RevokeTokenResult> {
    return this.#revokeAt(session.baseUrl, session.refreshToken ?? session.accessToken);
  }

  /** Revocation goes to the deployment that issued the token — never anywhere a stored value could point that is not an acceptable base URL. */
  #revokeAt(baseUrl: string, token: string): Promise<RevokeTokenResult> {
    const target = isAcceptableBaseUrl(baseUrl) ? baseUrl : this.baseUrl;
    return revokeToken(
      { revocationEndpoint: pageSpaceOAuthEndpoints(target).revocationEndpoint, token, clientId: this.clientId },
      { fetch: this.#fetch },
    );
  }

  #writeSession(storage: AuthStorage, session: StoredSession): boolean {
    try {
      storage.setItem(this.#sessionKey, JSON.stringify(session));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Writes the session record; on failure removes the stale record (which
   * frees its space — a quota error does not block removal) and tries once
   * more. Returns whether the record is now stored. When it is not, no
   * record remains at all, so no provider can replay a spent token from it;
   * the caller must revoke the tokens it could not store.
   */
  #persistSession(storage: AuthStorage, session: StoredSession): boolean {
    if (this.#writeSession(storage, session)) return true;
    this.#forget(storage);
    if (this.#writeSession(storage, session)) return true;
    this.#forget(storage);
    return false;
  }

  get #lockName(): string {
    return `pagespace.auth.refresh:${this.clientId}`;
  }

  #forget(storage: AuthStorage): void {
    try {
      storage.removeItem(this.#sessionKey);
    } catch {
      // Nothing more to do: a storage that cannot remove cannot be read either.
    }
  }

  /** The stored session record as this deployment sees it: unreadable (storage threw), absent, or present. */
  /** The stored record as this deployment sees it: unreadable (storage threw), absent, another deployment's, or ours. */
  #readStoredSession(
    storage: AuthStorage,
  ):
    | { readonly kind: 'unreadable' }
    | { readonly kind: 'absent' }
    | { readonly kind: 'foreign'; readonly session: StoredSession }
    | { readonly kind: 'present'; readonly session: StoredSession } {
    let raw: string | null;
    try {
      raw = storage.getItem(this.#sessionKey);
    } catch {
      return { kind: 'unreadable' };
    }
    const session = parseStored(raw, sessionSchema);
    if (session === null) return { kind: 'absent' };
    return sameDeployment(session.baseUrl, this.baseUrl) ? { kind: 'present', session } : { kind: 'foreign', session };
  }

  #providerFor(session: StoredSession, storage: AuthStorage): OAuthTokenProvider {
    const initialTokens: OAuthTokens = {
      accessToken: session.accessToken,
      accessExpiresAt: session.accessExpiresAt,
      // An access-only grant has no refresh token; the refresh below never sends this value.
      refreshToken: session.refreshToken ?? '',
      refreshExpiresAt: session.refreshExpiresAt,
      scope: session.scope,
    };
    if (session.refreshToken === null) {
      const noRefresh: RefreshAccessToken = async () => {
        throw new AuthenticationError('This sign-in has no refresh token (the grant had no offline_access); sign in again.', 'auth.refresh');
      };
      // Skew 0: with nothing to refresh to, the token is used for its whole lifetime, then fails closed.
      return new OAuthTokenProvider({ initialTokens, refreshAccessToken: noRefresh, now: this.#now, skewMs: 0 });
    }
    const tokenEndpointRefresh = createTokenEndpointRefresh({
      tokenEndpoint: pageSpaceOAuthEndpoints(this.baseUrl).tokenEndpoint,
      clientId: this.clientId,
      fetch: this.#fetch,
      now: this.#now,
    });
    const lineage = session.lineage;
    let heldRotation = session.rotation;

    const signedOutOrReplaced = (): AuthenticationError =>
      new AuthenticationError('This sign-in was signed out or replaced by another sign-in; sign in again.', 'auth.refresh');

    // The invariant: a session exists only while its record is in storage.
    // That is what lets signOut() — which removes the record and revokes its
    // token under the same lock — end a session everywhere. Refresh tokens
    // are single-use (presenting a spent one revokes the whole sign-in), so
    // every refresh runs under that lock and:
    //   1. requires this sign-in's record: absent, unreadable, or another
    //      sign-in's → signed out or replaced; fail closed, no network call;
    //   2. adopts a newer rotation another provider already stored (as-is
    //      while its access token is fresh), never presenting anything older;
    //   3. persists the rotated pair before releasing the lock — and if the
    //      record vanished or was replaced during the call, or cannot be
    //      stored, revokes the pair it just received and fails closed, so no
    //      token lives on where signOut() cannot reach it.
    const refreshAccessToken: RefreshAccessToken = () =>
      withSessionLock(this.#lockName, async () => {
        const read = this.#readStoredSession(storage);
        // A storage read that throws is a hiccup, not a verdict: retryable, and nothing is revoked.
        if (read.kind === 'unreadable') throw new NetworkError('The stored session could not be read; try again.', { operation: 'auth.refresh' });
        if (read.kind !== 'present' || read.session.lineage !== lineage) throw signedOutOrReplaced();
        const stored = read.session;
        if (stored.refreshToken === null) throw signedOutOrReplaced();
        if (stored.rotation > heldRotation && this.#now() + ADOPT_FRESH_SKEW_MS < stored.accessExpiresAt) {
          heldRotation = stored.rotation;
          return {
            accessToken: stored.accessToken,
            accessExpiresAt: stored.accessExpiresAt,
            refreshToken: stored.refreshToken,
            refreshExpiresAt: stored.refreshExpiresAt,
            scope: stored.scope,
          };
        }

        // The stored record is the newest rotation of this sign-in, so its token is the one to present —
        // never the one held in memory, which another provider may already have spent.
        const tokens = await tokenEndpointRefresh(stored.refreshToken);
        const next: StoredSession = {
          v: 1,
          baseUrl: this.baseUrl,
          lineage,
          rotation: stored.rotation + 1,
          accessToken: tokens.accessToken,
          accessExpiresAt: tokens.accessExpiresAt,
          refreshToken: tokens.refreshToken,
          refreshExpiresAt: tokens.refreshExpiresAt,
          scope: tokens.scope ?? session.scope,
        };
        // Storage shared without a common lock (another realm) may have been
        // signed out of, or given a newer sign-in, during the network call.
        // An unreadable storage is not proof of either: still try to persist.
        const current = this.#readStoredSession(storage);
        const stillOurs = current.kind === 'unreadable' || (current.kind === 'present' && current.session.lineage === lineage);
        if (!stillOurs || !this.#persistSession(storage, next)) {
          await this.#revokeSession(next);
          throw stillOurs
            ? new AuthenticationError('The refreshed session could not be stored, so it was revoked; sign in again.', 'auth.refresh')
            : signedOutOrReplaced();
        }
        heldRotation = next.rotation;
        return tokens;
      });
    return new OAuthTokenProvider({ initialTokens, refreshAccessToken, now: this.#now });
  }
}
