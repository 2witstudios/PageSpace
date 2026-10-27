/**
 * RFC 7009 token revocation (Phase 4 task 5) against the OAuth revocation
 * endpoint (`apps/web/src/app/api/oauth/revoke/route.ts`; Phase 1 task 10).
 * Same shape as `exchange-code.ts`: unauthenticated, form-encoded,
 * deliberately not routed through `PageSpaceClient.invoke`. The endpoint
 * returns the SAME 200 for an unknown/already-revoked token as for a live
 * one (RFC 7009 §2.2, no oracle), so a 2xx round trip is the only "success"
 * signal this module ever reports — it never claims to know whether a
 * token actually existed. Never throws: `pagespace logout` needs the
 * outcome of every host in `--all` to decide what to delete, so failures
 * are a typed result, not an exception.
 */
import { z } from 'zod';

export interface RevokeTokenParams {
  readonly host: string;
  readonly refreshToken: string;
  readonly clientId: string;
}

export type RevokeResult = { readonly outcome: 'revoked' } | { readonly outcome: 'failed'; readonly message: string };

export type RevokeToken = (params: RevokeTokenParams) => Promise<RevokeResult>;

const RATE_LIMITED_STATUS = 429;

const rateLimitedBodySchema = z.object({ retryAfter: z.number().optional() });

export function createRevokeToken(fetchImpl: typeof fetch = fetch): RevokeToken {
  return async (params: RevokeTokenParams): Promise<RevokeResult> => {
    const url = `${params.host.replace(/\/+$/, '')}/api/oauth/revoke`;
    const body = new URLSearchParams({ token: params.refreshToken, client_id: params.clientId });

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (error) {
      return { outcome: 'failed', message: `network_error: ${error instanceof Error ? error.message : String(error)}` };
    }

    if (response.status === RATE_LIMITED_STATUS) {
      const json: unknown = await response.json().catch(() => null);
      const parsed = rateLimitedBodySchema.safeParse(json);
      const retryAfter = parsed.success ? parsed.data.retryAfter : undefined;
      return { outcome: 'failed', message: retryAfter ? `rate_limited (retry after ${retryAfter}s)` : 'rate_limited' };
    }

    if (!response.ok) {
      return { outcome: 'failed', message: `http_${response.status}` };
    }

    return { outcome: 'revoked' };
  };
}
