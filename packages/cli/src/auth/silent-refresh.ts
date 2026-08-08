/**
 * The refresh_token grant against the OAuth 2.1 token endpoint
 * (`apps/web/src/app/api/oauth/token/route.ts`) — the sole I/O edge
 * `OAuthTokenProvider.refreshAccessToken` needs (Phase 4 task 7; ADR 0003
 * §3.3-3.4). Not routed through `PageSpaceClient.invoke`, same reasoning as
 * `exchange-code.ts`: this call happens *before* any access token exists.
 *
 * Failures are classified with the SDK's own `classifyHttpError` so
 * `classifyRefreshFailure` (packages/sdk/src/auth/decide.ts) can tell a
 * transient failure (network/timeout/429/5xx — retry) from a definitive
 * rejection (400 invalid_grant — purge and re-login) exactly the way it
 * already does for every other SDK call, instead of a bespoke error type
 * that would always classify as terminal regardless of cause.
 */
import { z } from 'zod';
import { classifyHttpError, NetworkError, TimeoutError } from '@pagespace/sdk';
import type { OAuthTokens, RefreshAccessToken } from '@pagespace/sdk';

const refreshResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  refresh_token: z.string(),
  scope: z.string(),
});

/**
 * Nominal client-side bookkeeping only — the server never returns a refresh
 * token expiry on this grant (§3.2's 30-day/90-day caps are enforced
 * server-side). `classifyRefreshFailure` decides validity from the HTTP
 * response of the *next* refresh attempt, never from this value.
 */
const NOMINAL_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * This grant can run before ANY transport is connected (`pagespace mcp`
 * resolves auth lazily on the first tool call), so an unreachable token
 * endpoint must become a typed error, never an unbounded hang. The SDK's
 * `TimeoutError` — not a bespoke type — so `classifyRefreshFailure` treats
 * it as transient (retry next call), never as a purge-worthy rejection.
 */
const DEFAULT_REFRESH_TIMEOUT_MS = 10_000;

export interface RefreshAccessTokenOptions {
  readonly timeoutMs?: number;
  /** Injected so tests can control abort deterministically without real timers/network. */
  readonly abortFactory?: () => AbortController;
}

export function createRefreshAccessToken(
  tokenEndpoint: string,
  clientId: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
  options: RefreshAccessTokenOptions = {},
): RefreshAccessToken {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
  const abortFactory = options.abortFactory ?? (() => new AbortController());

  return async (refreshToken: string): Promise<OAuthTokens> => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    });

    const controller = abortFactory();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new TimeoutError(`Refresh token request timed out after ${timeoutMs}ms`, {
          operation: 'auth.refresh',
          timeoutMs,
        });
      }
      throw new NetworkError('Refresh token request failed', { cause: error, operation: 'auth.refresh' });
    } finally {
      clearTimeout(timer);
    }

    const bodyText = await response.text();
    let json: unknown = null;
    if (bodyText.length > 0) {
      try {
        json = JSON.parse(bodyText) as unknown;
      } catch {
        json = null;
      }
    }

    if (!response.ok) {
      throw classifyHttpError(response.status, response.headers, json, 'auth.refresh');
    }

    const parsed = refreshResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw classifyHttpError(response.status, response.headers, json, 'auth.refresh');
    }

    const issuedAt = now();
    return {
      accessToken: parsed.data.access_token,
      accessExpiresAt: issuedAt + parsed.data.expires_in * 1000,
      refreshToken: parsed.data.refresh_token,
      refreshExpiresAt: issuedAt + NOMINAL_REFRESH_TTL_MS,
      scope: parsed.data.scope,
    };
  };
}
