/**
 * RFC 7009 token revocation — the CLI adapter over `@pagespace/sdk`'s
 * `revokeToken` (ADR 0004 Decision 11). The SDK posts the form-encoded
 * request to `/api/oauth/revoke` and never throws; the endpoint answers the
 * SAME 200 for an unknown or already-revoked token as for a live one
 * (RFC 7009 §2.2, no oracle), so `'revoked'` only ever means the server
 * accepted the request. This module keeps the CLI's result shape:
 * `pagespace logout --all` reads every host's outcome to decide what to
 * delete, and prints the failure message, which never contains the token.
 */
import { isNetworkError, isRateLimitError, pageSpaceOAuthEndpoints, revokeToken } from '@pagespace/sdk';
import type { PageSpaceError } from '@pagespace/sdk';

export interface RevokeTokenParams {
  readonly host: string;
  readonly refreshToken: string;
  readonly clientId: string;
}

export type RevokeResult = { readonly outcome: 'revoked' } | { readonly outcome: 'failed'; readonly message: string };

export type RevokeToken = (params: RevokeTokenParams) => Promise<RevokeResult>;

function describeFailure(error: PageSpaceError): string {
  if (isNetworkError(error)) {
    const cause = error.cause;
    return `network_error: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  if (isRateLimitError(error)) {
    return error.retryAfterMs ? `rate_limited (retry after ${Math.ceil(error.retryAfterMs / 1000)}s)` : 'rate_limited';
  }
  return 'status' in error && typeof error.status === 'number' ? `http_${error.status}` : error.code.toLowerCase();
}

export function createRevokeToken(fetchImpl: typeof fetch = fetch): RevokeToken {
  return async (params: RevokeTokenParams): Promise<RevokeResult> => {
    const result = await revokeToken(
      {
        revocationEndpoint: pageSpaceOAuthEndpoints(params.host).revocationEndpoint,
        token: params.refreshToken,
        clientId: params.clientId,
      },
      { fetch: fetchImpl },
    );
    return result.outcome === 'revoked' ? { outcome: 'revoked' } : { outcome: 'failed', message: describeFailure(result.error) };
  };
}
