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
}
