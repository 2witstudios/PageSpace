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
 * The response is one of two shapes, discriminated by `token_type`
 * (`oauth-repository.ts`'s `exchangeAuthorizationCode`): `'Bearer'` is the
 * classic OAuth refresh/access-token pair `pagespace login` uses, feeding
 * `PageSpaceClient`/`OAuthTokenProvider`. `'mcp'` is a pure drive:* grant
 * (`pagespace keys create`) — the server minted a real `mcp_*` token instead
 * of an OAuth grant (see that file's `ok_mcp_token` outcome), so there is no
 * `refresh_token`/`expires_in` to report: an `mcp_*` token doesn't expire
 * and has no refresh cycle. `loopback-flow.ts` persists each shape
 * differently (an `OAuthHostCredential` vs a `StaticHostCredential`).
 */
import { z } from 'zod';
import type { ExchangeCode, ExchangeCodeParams, ExchangedTokens } from './loopback-flow.js';

export class TokenExchangeError extends Error {
  constructor(public readonly code: string) {
    super(`Token exchange failed: ${code}`);
    this.name = 'TokenExchangeError';
  }
}

const oauthTokenResponseSchema = z.object({
  token_type: z.literal('Bearer'),
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string(),
  scope: z.string(),
});

const mcpTokenResponseSchema = z.object({
  token_type: z.literal('mcp'),
  access_token: z.string(),
  scope: z.string(),
});

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

    const mcpParsed = mcpTokenResponseSchema.safeParse(json);
    if (mcpParsed.success) {
      return { kind: 'mcp', token: mcpParsed.data.access_token, scope: mcpParsed.data.scope };
    }

    const oauthParsed = oauthTokenResponseSchema.safeParse(json);
    if (!oauthParsed.success) {
      throw new TokenExchangeError('invalid_response');
    }

    return {
      kind: 'oauth',
      accessToken: oauthParsed.data.access_token,
      refreshToken: oauthParsed.data.refresh_token,
      expiresIn: oauthParsed.data.expires_in,
      scope: oauthParsed.data.scope,
    };
  };
}
