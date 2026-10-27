/**
 * AuthProvider abstraction (ADR 0003; Phase 2 task 4).
 *
 * The one interface every credential source implements: static tokens
 * (mcp_*, PAGESPACE_TOKEN — CI/agents) and OAuth-issued tokens (CLI login,
 * ps_at_* / ps_rt_* per ADR 0003). Callers never branch on credential kind —
 * they call getAccessToken() before every request and invalidate() when a
 * request comes back 401.
 */
export interface AuthProvider {
  /** Resolves the current access token, refreshing it first if the provider decides it needs to. */
  getAccessToken(): Promise<string>;
  /** Signals that the last token this provider returned was rejected; discard it. */
  invalidate(): void;
  /**
   * Whether `invalidate()` can actually produce a DIFFERENT credential on the
   * next `getAccessToken()`. `false` means this provider holds one fixed
   * secret with no refresh grant behind it, so re-sending it after a 401 is
   * guaranteed to reproduce the same 401.
   *
   * The client's single auth retry exists to recover an EXPIRED access token
   * through a refresh. Running it against a provider that cannot refresh
   * doesn't just waste a round trip: the second attempt fails inside the
   * provider, so the provider's own "I have nothing left to give you" error
   * replaces the server's — which is how a route refusing a credential CLASS
   * ("MCP tokens are not permitted for this endpoint") used to reach the user
   * as "Static token was invalidated", reporting a perfectly live key as dead
   * (issue #2464). Gating the retry on this flag keeps the server's own
   * refusal intact.
   *
   * Optional, and an omitted value is read as `true` — every provider written
   * before this field existed had a refresh path, and third-party
   * implementations (and test doubles) keep the historical retry behaviour
   * without having to declare anything.
   */
  readonly canRefresh?: boolean;
}
