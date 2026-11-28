/**
 * `exchangeAgentAssertion` — the auth.md "Exchange" step (ADR 0008 Decisions
 * 4-6): an AI agent trades its opaque `ps_agent_*` secret (the
 * `identity_assertion` it received at signup — not a JWT) for a short-lived
 * `ps_at_` access token and a `ps_rt_` refresh token, over the RFC 7523
 * jwt-bearer URN, as the public `pagespace-agent` client.
 *
 * Sits beside `oauth.ts` because its result is exactly the `OAuthTokens` an
 * `OAuthTokenProvider` is built from; and like that module's refresh edge it
 * is a plain form-encoded POST to the token endpoint rather than a registry
 * operation, because it runs before any access token exists. Failures are
 * classified with `classifyHttpError`, so `classifyRefreshFailure` tells a
 * transient failure (network, 429, 5xx) from a refused secret (400
 * `invalid_grant`) the same way it does for a refresh.
 *
 * The grant URNs and the client id are inlined rather than imported from
 * `@pagespace/lib` (the published SDK never runtime-imports it); a drift-guard
 * test pins them to the server's registration.
 */
import { classifyHttpError, isValidationError, NetworkError } from '../errors.js';
import type { OAuthTokens } from './oauth.js';

/** RFC 7523 §2.1 — the URN the agent secret is presented under. */
export const AGENT_ASSERTION_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** The grant an agent polls, with its own access token, while a human approves its claim (auth.md "Fund"; `pollAgentClaim`). */
export const AGENT_CLAIM_GRANT_TYPE = 'urn:pagespace:agent-auth:grant-type:claim';

/** The static public OAuth client every agent grant is redeemed as. */
export const PAGESPACE_AGENT_CLIENT_ID = 'pagespace-agent';

/**
 * Nominal client-side bookkeeping only, as in the CLI's refresh edge: the
 * server returns no refresh-token expiry, so whether the refresh token still
 * works is decided by the next refresh's response, never by this value.
 */
const NOMINAL_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface ExchangeAgentAssertionOptions {
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Injected clock for the absolute expiries; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Optional narrower scope; the server's default is `account offline_access` and nothing wider is ever issued. */
  readonly scope?: string;
}

interface BearerTokenBody {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function isBearerTokenBody(value: unknown): value is BearerTokenBody {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    body.token_type === 'Bearer' &&
    typeof body.access_token === 'string' &&
    body.access_token.length > 0 &&
    typeof body.refresh_token === 'string' &&
    body.refresh_token.length > 0 &&
    typeof body.expires_in === 'number' &&
    Number.isFinite(body.expires_in) &&
    typeof body.scope === 'string'
  );
}

/**
 * Parses a token-endpoint response that should carry a Bearer pair (the
 * exchange; the CLI's refresh edge). Throws the classified error otherwise.
 * The claim grant never carries a pair — see `pollAgentClaim`.
 */
export function parseBearerTokenResponse(
  status: number,
  headers: Headers,
  json: unknown,
  operation: string,
  now: () => number = Date.now,
): OAuthTokens {
  if (status < 200 || status > 299 || !isBearerTokenBody(json)) {
    // A 2xx of the wrong shape classifies as a terminal HttpError (fail
    // closed), exactly as the CLI's refresh edge treats one.
    throw classifyHttpError(status, headers, json, operation);
  }
  const issuedAt = now();
  return {
    accessToken: json.access_token,
    accessExpiresAt: issuedAt + json.expires_in * 1000,
    refreshToken: json.refresh_token,
    refreshExpiresAt: issuedAt + NOMINAL_REFRESH_TTL_MS,
    scope: json.scope,
  };
}

export async function exchangeAgentAssertion(
  tokenEndpoint: string,
  secret: string,
  clientId: string,
  options: ExchangeAgentAssertionOptions = {},
): Promise<OAuthTokens> {
  const fetchImpl = options.fetch ?? fetch;
  const form = new URLSearchParams({
    grant_type: AGENT_ASSERTION_GRANT_TYPE,
    assertion: secret,
    client_id: clientId,
  });
  if (options.scope !== undefined) form.set('scope', options.scope);

  let response: Response;
  try {
    response = await fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch (error) {
    // Never the request: its body is the secret.
    throw new NetworkError('Agent assertion exchange request failed', { cause: error, operation: 'auth.agentAssertion' });
  }

  const text = await response.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
  }
  return parseBearerTokenResponse(response.status, response.headers, json, 'auth.agentAssertion', options.now);
}

/** True for the token endpoint's one refusal of a credential: HTTP 400 `{"error":"invalid_grant"}`. */
export function isInvalidGrantError(error: unknown): boolean {
  return isValidationError(error) && error.message === 'invalid_grant';
}
