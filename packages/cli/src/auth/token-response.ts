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
/**
 * One schema, discriminated on the `token_type` the server always sends.
 * Zod dispatches to the single matching member rather than trying each in
 * turn, so a body of the RIGHT shape that fails validation can never be
 * silently mistaken for a body of a different shape.
 */
const tokenResponseSchema = z.discriminatedUnion('token_type', [
  oauthTokenResponseSchema,
  mcpTokenResponseSchema,
  mcpUpdateResponseSchema,
  mcpActivateResponseSchema,
]);

export function parseTokenResponse(json: unknown): ExchangedTokens | null {
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) return null;

  switch (parsed.data.token_type) {
    case 'mcp':
      return { kind: 'mcp', token: parsed.data.access_token, scope: parsed.data.scope };
    case 'mcp_update':
      return { kind: 'mcp_update', tokenId: parsed.data.token_id, scope: parsed.data.scope };
    case 'mcp_activate':
      return { kind: 'mcp_activate', tokenId: parsed.data.token_id, scope: parsed.data.scope };
    case 'Bearer':
      return {
        kind: 'oauth',
        accessToken: parsed.data.access_token,
        refreshToken: parsed.data.refresh_token,
        expiresIn: parsed.data.expires_in,
        scope: parsed.data.scope,
      };
  }
}
