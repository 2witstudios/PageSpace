/**
 * The token endpoint's response contract, in one place.
 *
 * `apps/web/src/app/api/oauth/token/route.ts` renders the same four response
 * shapes no matter which grant produced them — the authorization_code exchange
 * and the RFC 8628 device poll both go through one `keyGrantSuccessResponse`
 * helper server-side. This module is the client-side counterpart: both
 * `exchange-code.ts` and `poll-device-token.ts` discriminate through it, so a
 * change to the wire contract can't be applied to one grant and forgotten on
 * the other.
 *
 * The four shapes, discriminated by `token_type`:
 *
 * - `'Bearer'` — the classic OAuth refresh/access-token pair `pagespace login`
 *   uses, feeding `PageSpaceClient`/`OAuthTokenProvider`.
 * - `'mcp'` — a pure drive:* grant (`pagespace keys create`): the server
 *   minted a real `mcp_*` token instead of an OAuth grant, so there is no
 *   `refresh_token`/`expires_in` to report — an `mcp_*` token doesn't expire
 *   and has no refresh cycle.
 * - `'mcp_update'` — an `update_key:<id>` grant (the wizard's Edit): the
 *   server re-scoped an EXISTING `mcp_*` token in place and deliberately
 *   returns no secret at all, only the verified success signal + granted
 *   scope + which token changed.
 * - `'mcp_activate'` — an `activate_key:<id>` approval (`pagespace keys
 *   use`): nothing minted, nothing re-scoped, no secret returned.
 *
 * Callers persist these differently — an `OAuthHostCredential` vs a
 * `StaticHostCredential` vs nothing at all — which is why the discrimination
 * is worth doing once, precisely, rather than being re-derived per flow.
 */
import { z } from 'zod';
import type { ExchangedTokens } from './loopback-flow.js';

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

const mcpUpdateResponseSchema = z.object({
  token_type: z.literal('mcp_update'),
  token_id: z.string(),
  scope: z.string(),
});

const mcpActivateResponseSchema = z.object({
  token_type: z.literal('mcp_activate'),
  token_id: z.string(),
  scope: z.string(),
});

/**
 * Discriminate a successful token-endpoint body into the typed union, or
 * `null` when it matches no known shape (the caller decides whether that is a
 * thrown `TokenExchangeError` or a `request_failed` poll result). Pure.
 */
export function parseTokenResponse(json: unknown): ExchangedTokens | null {
  // Dispatch on the discriminant the server always sends, rather than trying
  // each schema in turn — otherwise the overwhelmingly common `Bearer`
  // response pays three failed parses first, and a validation failure on the
  // RIGHT shape would be silently indistinguishable from the wrong shape.
  const tokenType = (json as { token_type?: unknown } | null)?.token_type;

  switch (tokenType) {
    case 'mcp': {
      const parsed = mcpTokenResponseSchema.safeParse(json);
      return parsed.success ? { kind: 'mcp', token: parsed.data.access_token, scope: parsed.data.scope } : null;
    }
    case 'mcp_update': {
      const parsed = mcpUpdateResponseSchema.safeParse(json);
      return parsed.success ? { kind: 'mcp_update', tokenId: parsed.data.token_id, scope: parsed.data.scope } : null;
    }
    case 'mcp_activate': {
      const parsed = mcpActivateResponseSchema.safeParse(json);
      return parsed.success ? { kind: 'mcp_activate', tokenId: parsed.data.token_id, scope: parsed.data.scope } : null;
    }
    case 'Bearer': {
      const parsed = oauthTokenResponseSchema.safeParse(json);
      return parsed.success
        ? {
            kind: 'oauth',
            accessToken: parsed.data.access_token,
            refreshToken: parsed.data.refresh_token,
            expiresIn: parsed.data.expires_in,
            scope: parsed.data.scope,
          }
        : null;
    }
    default:
      return null;
  }
}
