/**
 * The refresh_token grant (Phase 4 task 5) against the OAuth 2.1 token
 * endpoint — same endpoint and unauthenticated form-encoded shape as
 * `exchange-code.ts`'s authorization_code grant, different grant params.
 * `pagespace whoami` uses this to mint a short-lived access token from the
 * stored refresh token, since no access token is cached between CLI
 * invocations. Refresh tokens rotate on every use (ADR 0003 §3.3) — the
 * caller MUST persist the returned pair before using the access token
 * (ADR 0003 §3.5 persist-before-use), never after.
 */
import { z } from 'zod';

export interface RefreshTokenParams {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly refreshToken: string;
}

export interface RefreshedTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly scope: string;
}

export type RefreshToken = (params: RefreshTokenParams) => Promise<RefreshedTokens>;

export class RefreshTokenError extends Error {
  constructor(public readonly code: string) {
    super(`Token refresh failed: ${code}`);
    this.name = 'RefreshTokenError';
  }
}

const tokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  refresh_token: z.string(),
  scope: z.string(),
});

function extractErrorCode(json: unknown, status: number): string {
  if (json !== null && typeof json === 'object' && 'error' in json && typeof (json as Record<string, unknown>).error === 'string') {
    return (json as Record<string, unknown>).error as string;
  }
  return `http_${status}`;
}

export function createRefreshToken(fetchImpl: typeof fetch = fetch): RefreshToken {
  return async (params: RefreshTokenParams): Promise<RefreshedTokens> => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
      client_id: params.clientId,
    });

    let response: Response;
    try {
      response = await fetchImpl(params.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (error) {
      throw new RefreshTokenError(`network_error: ${error instanceof Error ? error.message : String(error)}`);
    }

    const json: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      throw new RefreshTokenError(extractErrorCode(json, response.status));
    }

    const parsed = tokenResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new RefreshTokenError('invalid_response');
    }

    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresIn: parsed.data.expires_in,
      scope: parsed.data.scope,
    };
  };
}
