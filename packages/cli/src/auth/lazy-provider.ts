/**
 * Defers credential resolution until the first `getAccessToken()` call —
 * built for `pagespace mcp`, whose stdio transport must connect and answer
 * `initialize`/`tools/list` immediately even when the credential store or
 * network is broken (run.ts's `lazyAuth` route wiring). Resolution effects
 * (keychain read, OAuth discovery + refresh) move from process startup to
 * the first tool call, where a failure surfaces as that call's `isError`
 * result instead of a dead process the MCP client can only see as a hang.
 *
 * Concurrency contract mirrors `OAuthTokenProvider.#inFlightRefresh`
 * (packages/sdk/src/auth/oauth.ts): concurrent callers join the in-flight
 * resolution rather than racing duplicate keychain/network effects. A
 * rejected resolution clears the memo so the next tool call retries — a
 * transient keychain lock or network outage recovers without restarting
 * the server.
 */
import type { AuthProvider } from '@pagespace/sdk';

export function createLazyAuthProvider(resolve: () => Promise<AuthProvider>): AuthProvider {
  let inner: AuthProvider | null = null;
  let inFlight: Promise<AuthProvider> | null = null;

  const materialize = async (): Promise<AuthProvider> => {
    if (inner !== null) return inner;
    if (inFlight === null) {
      inFlight = resolve().then(
        (provider) => {
          inner = provider;
          inFlight = null;
          return provider;
        },
        (error: unknown) => {
          inFlight = null;
          throw error;
        },
      );
    }
    return inFlight;
  };

  return {
    async getAccessToken(): Promise<string> {
      const provider = await materialize();
      return provider.getAccessToken();
    },
    invalidate(): void {
      // Nothing to forward to until resolution has succeeded; a pending or
      // failed resolution has issued no token that could need invalidating.
      inner?.invalidate();
    },
  };
}
