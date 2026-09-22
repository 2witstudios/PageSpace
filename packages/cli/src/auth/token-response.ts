/**
 * The token endpoint's response contract, as the CLI stores it.
 *
 * The wire contract itself — the four shapes
 * `apps/web/src/app/api/oauth/token/route.ts` renders, discriminated on
 * `token_type` — lives in `@pagespace/sdk`'s `parseTokenResponse` (ADR 0004
 * Decision 11: one implementation). Both `exchange-code.ts` and
 * `poll-device-token.ts` read it through this adapter, so a change to the
 * contract can't be applied to one grant and forgotten on the other.
 *
 * - `'Bearer'` → `kind: 'oauth'` — the refresh/access pair `pagespace login`
 *   feeds `OAuthTokenProvider`.
 * - `'mcp'` — a pure drive:* grant (`pagespace keys create`): a real `mcp_*`
 *   token, no refresh cycle.
 * - `'mcp_update'` — an `update_key:<id>` grant: an existing key re-scoped in
 *   place, no secret returned.
 * - `'mcp_activate'` — an `activate_key:<id>` approval: nothing minted.
 *
 * The one CLI-specific rule: every CLI grant requests `offline_access`, so a
 * Bearer answer WITHOUT a refresh token (which the SDK accepts, for apps that
 * sign in identity-only) is not something the CLI can persist — it reads as
 * no known shape (`null`), exactly as it did before the move.
 */
import { parseTokenResponse as parseSdkTokenResponse, type TokenResponse } from '@pagespace/sdk';
import type { ExchangedTokens } from './loopback-flow.js';

/** Pure: the SDK's parsed token response → the CLI's union, or `null` for a Bearer answer with no refresh token. */
export function toExchangedTokens(tokens: TokenResponse): ExchangedTokens | null {
  if (tokens.kind !== 'oauth') return tokens;
  if (tokens.refreshToken === undefined) return null;
  return {
    kind: 'oauth',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
    scope: tokens.scope,
  };
}

/** Pure: a successful token-endpoint body → the CLI's typed union, or `null` when the CLI cannot use it. */
export function parseTokenResponse(json: unknown): ExchangedTokens | null {
  const tokens = parseSdkTokenResponse(json);
  return tokens === null ? null : toExchangedTokens(tokens);
}
