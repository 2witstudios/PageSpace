/**
 * OAuthTokenProvider (ADR 0003; Phase 2 task 4).
 *
 * Pure core (decide.ts) + I/O edges (clock, and the refresh HTTP call
 * itself) constructor-injected — the "pure core, I/O edges" design law for
 * this phase. `refreshAccessToken` is the injection point for task 3's
 * transport against the token endpoint (form-encoded per Phase 1); this
 * module deliberately contains no bespoke fetch of its own; the
 * PageSpaceClient facade (task 6) wires the real transport in once it
 * exists.
 *
 * Tokens live in a private class field only. Errors thrown by this class
 * never embed a token value, and the class has no enumerable fields, so
 * JSON.stringify/util.inspect on a provider instance never leaks a
 * credential.
 */
import { AuthenticationError } from '../errors.js';
import { classifyRefreshFailure, decideTokenAction, type OAuthTokenState } from './decide.js';
import type { AuthProvider } from './provider.js';

/** The opaque ps_at_* / ps_rt_* pair per ADR 0003 §3.1, plus their absolute expiries. */
export interface OAuthTokens {
  accessToken: string;
  /** Epoch ms. */
  accessExpiresAt: number;
  refreshToken: string;
  /** Epoch ms. */
  refreshExpiresAt: number;
}

/**
 * Performs the refresh-grant HTTP call and resolves the new token pair, or
 * throws a PageSpaceError (see errors.ts) classifying the failure. This is
 * the sole I/O edge of OAuthTokenProvider — implemented by the caller using
 * the SDK's transport (task 3), never by this module.
 */
export type RefreshAccessToken = (refreshToken: string) => Promise<OAuthTokens>;

export interface OAuthTokenProviderOptions {
  initialTokens: OAuthTokens;
  refreshAccessToken: RefreshAccessToken;
  /** Injected clock; defaults to Date.now. */
  now?: () => number;
  /** Proactive-refresh skew window in ms; defaults to 60_000 per ADR 0003 §3.2. */
  skewMs?: number;
  /** Invoked with the full new token pair after every successful refresh, so the caller (CLI) can persist it. The SDK itself never touches disk. */
  onTokensUpdated?: (tokens: OAuthTokens) => void;
}

const DEFAULT_SKEW_MS = 60_000;

export class OAuthTokenProvider implements AuthProvider {
  #tokens: OAuthTokens;
  #status: 'authenticated' | 'unauthenticated' = 'authenticated';
  readonly #now: () => number;
  readonly #skewMs: number;
  readonly #refreshAccessToken: RefreshAccessToken;
  readonly #onTokensUpdated: ((tokens: OAuthTokens) => void) | undefined;
  #inFlightRefresh: Promise<string> | null = null;

  constructor(options: OAuthTokenProviderOptions) {
    this.#tokens = options.initialTokens;
    this.#refreshAccessToken = options.refreshAccessToken;
    this.#now = options.now ?? Date.now;
    this.#skewMs = options.skewMs ?? DEFAULT_SKEW_MS;
    this.#onTokensUpdated = options.onTokensUpdated;
  }

  async getAccessToken(): Promise<string> {
    // A refresh already in flight owns the authoritative outcome — join it
    // rather than re-deciding against `this.#tokens`, which is still the
    // pre-refresh snapshot until that flight resolves. Without this, a
    // concurrent caller arriving after `refreshExpiresAt` (measured against
    // the stale snapshot) would fail closed even though the in-flight
    // refresh is about to succeed and produce a fresh token pair.
    if (this.#inFlightRefresh) {
      return this.#inFlightRefresh;
    }

    const state: OAuthTokenState =
      this.#status === 'unauthenticated'
        ? { status: 'unauthenticated' }
        : {
            status: 'authenticated',
            accessExpiresAt: this.#tokens.accessExpiresAt,
            refreshExpiresAt: this.#tokens.refreshExpiresAt,
          };

    const action = decideTokenAction(state, this.#now(), this.#skewMs);

    if (action === 'unauthenticated') {
      // Reached either because a prior refresh was already terminal, or
      // because refreshExpiresAt has now passed — either way, fail closed
      // for good rather than re-deciding the same outcome on every call.
      this.#status = 'unauthenticated';
      throw new AuthenticationError('OAuth credential is unauthenticated; re-login required');
    }
    if (action === 'use-cached') {
      return this.#tokens.accessToken;
    }
    return this.#refresh();
  }

  invalidate(): void {
    if (this.#status === 'unauthenticated') {
      return;
    }
    // Force the next getAccessToken() through the refresh path instead of
    // replaying a token the caller just told us was rejected.
    this.#tokens = { ...this.#tokens, accessExpiresAt: Number.NEGATIVE_INFINITY };
  }

  #refresh(): Promise<string> {
    if (this.#inFlightRefresh) {
      return this.#inFlightRefresh;
    }
    const flight = this.#performRefresh().finally(() => {
      this.#inFlightRefresh = null;
    });
    this.#inFlightRefresh = flight;
    return flight;
  }

  async #performRefresh(): Promise<string> {
    try {
      const tokens = await this.#refreshAccessToken(this.#tokens.refreshToken);
      this.#tokens = tokens;
      this.#onTokensUpdated?.(tokens);
      return tokens.accessToken;
    } catch (error) {
      if (classifyRefreshFailure(error) === 'terminal') {
        this.#status = 'unauthenticated';
        throw new AuthenticationError('OAuth refresh rejected; re-login required');
      }
      throw error;
    }
  }
}
