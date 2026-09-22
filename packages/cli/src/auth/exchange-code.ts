/**
 * The authorization_code + PKCE token exchange — the CLI adapter over
 * `@pagespace/sdk`'s `exchangeAuthorizationCode` (ADR 0004 Decision 11). The
 * SDK sends the form-encoded grant (public client, no secret; RFC 6749
 * §4.1.3) and classifies failures; this module keeps the CLI's contract:
 * the result is mapped through `token-response.ts` (so a refresh-less Bearer
 * answer is refused, as before) and every failure is a `TokenExchangeError`
 * whose `code` is the server's RFC 6749 error code, `http_<status>` when it
 * sent none the SDK recognises, `invalid_response` for a malformed body, or
 * `network_error: …` when the server was never reached.
 */
import { exchangeAuthorizationCode, isNetworkError, isResponseValidationError, readOAuthErrorCode } from '@pagespace/sdk';
import type { ExchangeCode, ExchangeCodeParams, ExchangedTokens } from './loopback-flow.js';
import { toExchangedTokens } from './token-response.js';

export class TokenExchangeError extends Error {
  constructor(public readonly code: string) {
    super(`Token exchange failed: ${code}`);
    this.name = 'TokenExchangeError';
  }
}

function toExchangeErrorCode(error: unknown): string {
  if (isNetworkError(error)) {
    const cause = error.cause;
    return `network_error: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  if (isResponseValidationError(error)) return 'invalid_response';
  const oauthCode = readOAuthErrorCode(error);
  if (oauthCode !== null) return oauthCode;
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
    return `http_${error.status}`;
  }
  return 'invalid_response';
}

export function createExchangeCode(fetchImpl: typeof fetch = fetch): ExchangeCode {
  return async (params: ExchangeCodeParams): Promise<ExchangedTokens> => {
    let wire;
    try {
      wire = await exchangeAuthorizationCode(params, { fetch: fetchImpl });
    } catch (error) {
      throw new TokenExchangeError(toExchangeErrorCode(error));
    }
    const tokens = toExchangedTokens(wire);
    if (tokens === null) {
      throw new TokenExchangeError('invalid_response');
    }
    return tokens;
  };
}
