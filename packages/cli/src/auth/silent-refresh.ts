/**
 * The refresh_token grant — the sole I/O edge `OAuthTokenProvider.refreshAccessToken`
 * needs (ADR 0003 §3.3-3.4). Since ADR 0004 Decision 11 the implementation
 * is `@pagespace/sdk`'s `createTokenEndpointRefresh`: the same form-encoded
 * grant, zod-validated response and ADR 0003 failure classification every
 * SDK app gets (network/timeout/429/5xx retryable; 400 invalid_grant and any
 * malformed 2xx terminal), and never a token in an error. This module keeps
 * the CLI's positional signature.
 */
import { createTokenEndpointRefresh, isNetworkError, NetworkError } from '@pagespace/sdk';
import type { RefreshAccessToken } from '@pagespace/sdk';

/** The CLI's own wording for an unreachable token endpoint, as `enforceAuth` has always printed it. */
const REFRESH_NETWORK_FAILURE_MESSAGE = 'Refresh token request failed';

export function createRefreshAccessToken(
  tokenEndpoint: string,
  clientId: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): RefreshAccessToken {
  const refresh = createTokenEndpointRefresh({ tokenEndpoint, clientId, fetch: fetchImpl, now });
  return async (refreshToken: string) => {
    try {
      return await refresh(refreshToken);
    } catch (error) {
      if (isNetworkError(error)) {
        throw new NetworkError(REFRESH_NETWORK_FAILURE_MESSAGE, { cause: error.cause, operation: 'auth.refresh' });
      }
      throw error;
    }
  };
}
