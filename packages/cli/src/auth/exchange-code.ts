/**
 * The authorization_code + PKCE token exchange (Phase 4 task 3) against the
 * OAuth 2.1 token endpoint (`apps/web/src/app/api/oauth/token/route.ts`).
 * Deliberately NOT routed through `PageSpaceClient.invoke` — that pipeline
 * always attaches a Bearer `Authorization` header from an already-issued
 * `AuthProvider` and always serializes bodies as JSON, but the token
 * endpoint is unauthenticated (public client, no secret; RFC 6749 §5.1
 * requires `application/x-www-form-urlencoded`), which is exactly the
 * pre-authentication step no `AuthProvider` can exist for yet. The response
 * shape is still validated with zod rather than trusted blind.
 *
 * The four possible response shapes are discriminated by `parseTokenResponse`
 * (`token-response.ts`), shared with the device-grant poller so both grants
 * read the same wire contract.
 */
import type { ExchangeCode, ExchangeCodeParams, ExchangedTokens } from './loopback-flow.js';
import { parseTokenResponse } from './token-response.js';

export class TokenExchangeError extends Error {
  constructor(public readonly code: string) {
    super(`Token exchange failed: ${code}`);
    this.name = 'TokenExchangeError';
  }
}

function extractErrorCode(json: unknown, status: number): string {
  if (json !== null && typeof json === 'object' && 'error' in json && typeof (json as Record<string, unknown>).error === 'string') {
    return (json as Record<string, unknown>).error as string;
  }
  return `http_${status}`;
}

export function createExchangeCode(fetchImpl: typeof fetch = fetch): ExchangeCode {
  return async (params: ExchangeCodeParams): Promise<ExchangedTokens> => {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.codeVerifier,
    });

    let response: Response;
    try {
      response = await fetchImpl(params.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (error) {
      throw new TokenExchangeError(`network_error: ${error instanceof Error ? error.message : String(error)}`);
    }

    const json: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      throw new TokenExchangeError(extractErrorCode(json, response.status));
    }

    const tokens = parseTokenResponse(json);
    if (tokens === null) {
      throw new TokenExchangeError('invalid_response');
    }
    return tokens;
  };
}
