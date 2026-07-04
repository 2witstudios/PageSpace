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
  /**
   * The space-separated scope string the server actually granted on this
   * refresh, when the transport captured it (optional: OAuthTokenProvider
   * itself never reads this field — it exists so a caller like `whoami` can
   * report the server's current, authoritative grant instead of a
   * potentially stale locally-cached value).
   */
  scope?: string;
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
  /**
   * Invoked with the full new token pair after every successful refresh, so
   * the caller (CLI) can persist it. The SDK itself never touches disk. Per
   * ADR 0003 §3.5 (persist-before-use), if this returns a Promise it is
   * awaited before the new access token is handed to the caller — the store
   * write must land before the token is used.
   */
  onTokensUpdated?: (tokens: OAuthTokens) => void | Promise<void>;
}

const DEFAULT_SKEW_MS = 60_000;

export class OAuthTokenProvider implements AuthProvider {
  #tokens: OAuthTokens;
  #status: 'authenticated' | 'unauthenticated' = 'authenticated';
  readonly #now: () => number;
  readonly #skewMs: number;
  readonly #refreshAccessToken: RefreshAccessToken;
  readonly #onTokensUpdated: ((tokens: OAuthTokens) => void | Promise<void>) | undefined;
  #inFlightRefresh: Promise<string> | null = null;

  constructor(options: OAuthTokenProviderOptions) {
    this.#tokens = options.initialTokens;
    this.#refreshAccessToken = options.refreshAccessToken;
    this.#now = options.now ?? Date.now;
    this.#skewMs = options.skewMs ?? DEFAULT_SKEW_MS;
    this.#onTokensUpdated = options.onTokensUpdated;
  }

  async getAccessToken(): Promise<string> {
    const state: OAuthTokenState =
      this.#status === 'unauthenticated'
        ? { status: 'unauthenticated', accessExpiresAt: this.#tokens.accessExpiresAt }
        : { status: 'authenticated', accessExpiresAt: this.#tokens.accessExpiresAt };

    const action = decideTokenAction(state, this.#now(), this.#skewMs);

    if (action === 'unauthenticated') {
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
    let tokens: OAuthTokens;
    try {
      tokens = await this.#refreshAccessToken(this.#tokens.refreshToken);
    } catch (error) {
      if (classifyRefreshFailure(error) === 'terminal') {
        this.#status = 'unauthenticated';
        throw new AuthenticationError('OAuth refresh rejected; re-login required');
      }
      throw error;
    }

    this.#tokens = tokens;
    // Deliberately outside the try/catch above: classifyRefreshFailure
    // classifies refresh-HTTP-call failures (invalid_grant vs. transient
    // network/5xx), not local persistence failures. A disk/keychain error
    // here must propagate as itself — never reclassified into a terminal
    // AuthenticationError, which would force a re-login over what is really
    // just a failed local write of an otherwise-valid rotated token.
    await this.#onTokensUpdated?.(tokens);
    return tokens.accessToken;
  }
}
