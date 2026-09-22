/**
 * The OAuth 2.1 token-endpoint calls (Phase 3 leaf 1; ADR 0004 Decision 11):
 * RFC 8414 discovery, the authorization_code exchange, the refresh_token
 * grant, and RFC 7009 revocation — the one implementation the SDK's
 * `PageSpaceAuth`, the CLI, and anyone hand-rolling a flow all share.
 *
 * Deliberately NOT routed through `PageSpaceClient.invoke`: that pipeline
 * attaches a Bearer from an `AuthProvider` and sends JSON, but these calls
 * are the pre-authentication step no provider exists for yet, and RFC 6749
 * §4.1.3 / §6 and RFC 7009 §2.1 require `application/x-www-form-urlencoded`
 * bodies from a public client with no secret.
 *
 * I/O is injected (`fetch`, `now`); everything else is pure. Browser-safe:
 * `fetch`, `URLSearchParams` and zod only — no `node:` import.
 *
 * Zero trust: every response body is validated with zod before a field is
 * read; a body that fails is a typed `ResponseValidationError`, never a
 * guessed default. Failures are classified exactly as ADR 0003 §6 says
 * (`classifyRefreshFailure`, `decide.ts`): network, timeout, 429 and 5xx are
 * transient; every definitive 4xx and every malformed 2xx is terminal.
 *
 * No secret reaches an error: the request's code, verifier and tokens are
 * never interpolated into a message, and the server's `error` field is only
 * carried when it is one of the known OAuth error codes — so a server that
 * echoes a submitted token back in its error body cannot route it into a
 * log line through this module either.
 */
import { z } from 'zod';
import {
  classifyHttpError,
  getHeaderValue,
  isPageSpaceError,
  NetworkError,
  RateLimitError,
  ResponseValidationError,
  TimeoutError,
  type PageSpaceError,
  type ValidationIssue,
} from '../errors.js';
import { classifyRefreshFailure } from './decide.js';
import type { OAuthTokens, RefreshAccessToken } from './oauth.js';

export interface TokenEndpointDeps {
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /**
   * Per-request deadline in ms (default 30s). A hung token request becomes a
   * retryable `TimeoutError` instead of an unbounded wait — which matters
   * because a refresh runs under a lock every other refresh waits on.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export interface TokenEndpointClockDeps extends TokenEndpointDeps {
  /** Defaults to `Date.now`; turns the relative `expires_in` into an absolute expiry. */
  readonly now?: () => number;
}

const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded' } as const;

/**
 * The error codes the token and revocation endpoints can legitimately send
 * (RFC 6749 §5.2, RFC 7009 §2.2.1, RFC 8628 §3.5, and PageSpace's own
 * `rate_limited`). Anything else in a server's `error` field is dropped
 * before classification — see the header.
 */
const KNOWN_OAUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'unsupported_token_type',
  'invalid_scope',
  'invalid_token',
  'insufficient_scope',
  'access_denied',
  'authorization_pending',
  'slow_down',
  'expired_token',
  'server_error',
  'temporarily_unavailable',
  'rate_limited',
]);

const rateLimitBodySchema = z.object({ retryAfter: z.number().int().nonnegative() });

/**
 * Pure: a non-2xx token-endpoint response → the typed SDK error ADR 0003's
 * classification reads. Only a known OAuth error code survives into the
 * message; a 429's retry delay comes from `Retry-After`, or else from the
 * `retryAfter` (seconds) the PageSpace token route puts in its body.
 */
export function classifyTokenEndpointError(
  status: number,
  headers: Headers | undefined,
  body: unknown,
  operation: string,
): PageSpaceError {
  const rawCode = typeof body === 'object' && body !== null && 'error' in body ? (body as { error: unknown }).error : undefined;
  const safeBody = typeof rawCode === 'string' && KNOWN_OAUTH_ERROR_CODES.has(rawCode) ? { error: rawCode } : null;
  const classified = classifyHttpError(status, headers, safeBody, operation);

  if (status === 429 && getHeaderValue(headers, 'Retry-After') === null) {
    const parsed = rateLimitBodySchema.safeParse(body);
    if (parsed.success) {
      return new RateLimitError(classified.message, parsed.data.retryAfter * 1000, operation);
    }
  }
  return classified;
}

/**
 * The RFC 6749 §5.2 error code a token-endpoint rejection carried (e.g.
 * `'invalid_grant'`), or `null` — for a network failure, a malformed
 * response, a server that sent no recognised code, or anything that is not
 * an SDK error at all. Reads only what `classifyTokenEndpointError` already
 * allowlisted, so it can never return server-supplied free text.
 */
export function readOAuthErrorCode(error: unknown): string | null {
  if (!isPageSpaceError(error) || !('status' in error)) return null;
  return KNOWN_OAUTH_ERROR_CODES.has(error.message) ? error.message : null;
}

function toIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.filter((segment): segment is string | number => typeof segment === 'string' || typeof segment === 'number'),
    message: issue.message,
  }));
}

/** `response.json()`, or `null` for an empty or non-JSON body — classification must survive junk. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/** A completed exchange: the response and its body, both read inside the deadline. */
interface Exchange {
  readonly response: Response;
  readonly json: unknown;
}

async function send(url: string, init: RequestInit | undefined, operation: string, deps: TokenEndpointDeps): Promise<Exchange> {
  const fetchImpl = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return { response, json: await readJson(response) };
  } catch (error) {
    if (timedOut) {
      throw new TimeoutError(`The PageSpace authorization server did not answer within ${timeoutMs}ms (${operation})`, { operation, timeoutMs });
    }
    throw new NetworkError(`Could not reach the PageSpace authorization server (${operation})`, { cause: error, operation });
  } finally {
    clearTimeout(timer);
  }
}

function postForm(url: string, form: Record<string, string>, operation: string, deps: TokenEndpointDeps): Promise<Exchange> {
  return send(url, { method: 'POST', headers: FORM_HEADERS, body: new URLSearchParams(form).toString() }, operation, deps);
}

// ---------------------------------------------------------------------------
// Discovery (RFC 8414)
// ---------------------------------------------------------------------------

const WELL_KNOWN_PATH = '/.well-known/oauth-authorization-server';

const metadataSchema = z.object({
  issuer: z.string().optional(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  revocation_endpoint: z.url().optional(),
  device_authorization_endpoint: z.url().optional(),
});

export interface AuthorizationServerMetadata {
  readonly issuer?: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string;
  /** RFC 8628 §4 — present when the server supports the device grant. */
  readonly deviceAuthorizationEndpoint?: string;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

/** Reads `<baseUrl>/.well-known/oauth-authorization-server`. A missing or non-URL endpoint fails closed. */
export async function discoverMetadata(baseUrl: string, deps: TokenEndpointDeps = {}): Promise<AuthorizationServerMetadata> {
  const operation = 'auth.discover';
  const { response, json } = await send(`${trimTrailingSlashes(baseUrl)}${WELL_KNOWN_PATH}`, undefined, operation, deps);
  if (!response.ok) {
    throw classifyTokenEndpointError(response.status, response.headers, json, operation);
  }
  const parsed = metadataSchema.safeParse(json);
  if (!parsed.success) {
    throw new ResponseValidationError(operation, toIssues(parsed.error));
  }
  return {
    issuer: parsed.data.issuer,
    authorizationEndpoint: parsed.data.authorization_endpoint,
    tokenEndpoint: parsed.data.token_endpoint,
    revocationEndpoint: parsed.data.revocation_endpoint,
    deviceAuthorizationEndpoint: parsed.data.device_authorization_endpoint,
  };
}

// ---------------------------------------------------------------------------
// Token responses
// ---------------------------------------------------------------------------

/**
 * The four bodies `apps/web/src/app/api/oauth/token/route.ts` renders,
 * discriminated on `token_type` so a body of the right shape that fails
 * validation can never be mistaken for a different shape. `refresh_token` is
 * absent from a Bearer body when the grant had no `offline_access` (ADR 0003
 * F1). The three `mcp*` shapes are first-party only (`pagespace keys`); a
 * third-party app only ever receives `Bearer`.
 */
const tokenResponseSchema = z.discriminatedUnion('token_type', [
  z.object({
    token_type: z.literal('Bearer'),
    access_token: z.string(),
    expires_in: z.number(),
    refresh_token: z.string().optional(),
    scope: z.string(),
  }),
  z.object({ token_type: z.literal('mcp'), access_token: z.string(), scope: z.string() }),
  z.object({ token_type: z.literal('mcp_update'), token_id: z.string(), scope: z.string() }),
  z.object({ token_type: z.literal('mcp_activate'), token_id: z.string(), scope: z.string() }),
]);

export type TokenResponse =
  | {
      readonly kind: 'oauth';
      readonly accessToken: string;
      /** Absent when the grant had no `offline_access`: the access token is all there is. */
      readonly refreshToken?: string;
      /** Seconds, relative to when the response arrived. */
      readonly expiresIn: number;
      /** The scope the server actually granted (RFC 6749 §5.1 — may be narrower than requested). */
      readonly scope: string;
    }
  | { readonly kind: 'mcp'; readonly token: string; readonly scope: string }
  | { readonly kind: 'mcp_update'; readonly tokenId: string; readonly scope: string }
  | { readonly kind: 'mcp_activate'; readonly tokenId: string; readonly scope: string };

/** Pure: a successful token-endpoint body → the typed union, or `null` when it matches no known shape. */
export function parseTokenResponse(json: unknown): TokenResponse | null {
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) return null;
  const data = parsed.data;
  switch (data.token_type) {
    case 'mcp':
      return { kind: 'mcp', token: data.access_token, scope: data.scope };
    case 'mcp_update':
      return { kind: 'mcp_update', tokenId: data.token_id, scope: data.scope };
    case 'mcp_activate':
      return { kind: 'mcp_activate', tokenId: data.token_id, scope: data.scope };
    case 'Bearer':
      return data.refresh_token === undefined
        ? { kind: 'oauth', accessToken: data.access_token, expiresIn: data.expires_in, scope: data.scope }
        : {
            kind: 'oauth',
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresIn: data.expires_in,
            scope: data.scope,
          };
  }
}

/** A body that answered 2xx but matched no token shape — reported without echoing any of it. */
function malformedTokenResponse(operation: string): ResponseValidationError {
  return new ResponseValidationError(operation, [{ path: [], message: 'Token endpoint response matched no known token shape' }]);
}

function readTokenResponse({ response, json }: Exchange, operation: string): TokenResponse {
  if (!response.ok) {
    throw classifyTokenEndpointError(response.status, response.headers, json, operation);
  }
  const tokens = parseTokenResponse(json);
  if (tokens === null) {
    throw malformedTokenResponse(operation);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// authorization_code exchange (RFC 6749 §4.1.3 + RFC 7636 §4.5)
// ---------------------------------------------------------------------------

export interface ExchangeAuthorizationCodeParams {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly code: string;
  /** The exact redirect URI the authorize request carried. */
  readonly redirectUri: string;
  readonly codeVerifier: string;
}

export async function exchangeAuthorizationCode(
  params: ExchangeAuthorizationCodeParams,
  deps: TokenEndpointDeps = {},
): Promise<TokenResponse> {
  const operation = 'auth.token';
  const exchange = await postForm(
    params.tokenEndpoint,
    {
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: params.clientId,
      code_verifier: params.codeVerifier,
    },
    operation,
    deps,
  );
  return readTokenResponse(exchange, operation);
}

// ---------------------------------------------------------------------------
// refresh_token grant (RFC 6749 §6; ADR 0003 §3.3-3.4)
// ---------------------------------------------------------------------------

/**
 * Nominal client-side bookkeeping only — the server never returns a refresh
 * token expiry (ADR 0003 §3.2's caps are enforced server-side), so validity
 * is decided by the NEXT refresh's response, not by this value.
 */
export const NOMINAL_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Pure: a Bearer token response + the moment it arrived → the absolute-expiry pair `OAuthTokenProvider` holds. */
export function toOAuthTokens(
  tokens: { readonly accessToken: string; readonly refreshToken: string; readonly expiresIn: number; readonly scope: string },
  issuedAt: number,
): OAuthTokens {
  return {
    accessToken: tokens.accessToken,
    accessExpiresAt: issuedAt + tokens.expiresIn * 1000,
    refreshToken: tokens.refreshToken,
    refreshExpiresAt: issuedAt + NOMINAL_REFRESH_TTL_MS,
    scope: tokens.scope,
  };
}

export interface RefreshWithTokenEndpointParams {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly refreshToken: string;
}

/**
 * Rotates a refresh token. A 2xx that carries no rotated refresh token — or
 * any non-Bearer shape — is a terminal `ResponseValidationError`: refresh
 * rotation (ADR 0003 §3.3) means the old token is already spent.
 */
export async function refreshWithTokenEndpoint(
  params: RefreshWithTokenEndpointParams,
  deps: TokenEndpointClockDeps = {},
): Promise<OAuthTokens> {
  const operation = 'auth.refresh';
  const exchange = await postForm(
    params.tokenEndpoint,
    { grant_type: 'refresh_token', refresh_token: params.refreshToken, client_id: params.clientId },
    operation,
    deps,
  );
  const tokens = readTokenResponse(exchange, operation);
  if (tokens.kind !== 'oauth' || tokens.refreshToken === undefined) {
    throw malformedTokenResponse(operation);
  }
  return toOAuthTokens({ ...tokens, refreshToken: tokens.refreshToken }, (deps.now ?? Date.now)());
}

export interface TokenEndpointRefreshOptions extends TokenEndpointClockDeps {
  readonly tokenEndpoint: string;
  readonly clientId: string;
}

/** `refreshWithTokenEndpoint` bound to one endpoint and client — the default `refreshAccessToken` for `OAuthTokenProvider`. */
export function createTokenEndpointRefresh(options: TokenEndpointRefreshOptions): RefreshAccessToken {
  const { tokenEndpoint, clientId, ...deps } = options;
  return (refreshToken: string) => refreshWithTokenEndpoint({ tokenEndpoint, clientId, refreshToken }, deps);
}

// ---------------------------------------------------------------------------
// Revocation (RFC 7009)
// ---------------------------------------------------------------------------

export interface RevokeTokenParams {
  readonly revocationEndpoint: string;
  /** Revoking a refresh token kills its whole family on PageSpace. */
  readonly token: string;
  readonly clientId: string;
}

/**
 * The endpoint answers the SAME 200 for an unknown or already-revoked token
 * as for a live one (RFC 7009 §2.2, no oracle), so `'revoked'` means only
 * "the server accepted the request". A failure is a result, never a throw,
 * with ADR 0003's classification attached: a caller revoking on sign-out
 * decides whether to retry or to discard the credential anyway.
 */
export type RevokeTokenResult =
  | { readonly outcome: 'revoked' }
  | { readonly outcome: 'failed'; readonly retryable: boolean; readonly error: PageSpaceError };

export async function revokeToken(params: RevokeTokenParams, deps: TokenEndpointDeps = {}): Promise<RevokeTokenResult> {
  const operation = 'auth.revoke';
  let exchange: Exchange;
  try {
    exchange = await postForm(params.revocationEndpoint, { token: params.token, client_id: params.clientId }, operation, deps);
  } catch (error) {
    // `send` only ever throws a NetworkError or a TimeoutError (both retryable); the guard keeps that a checked fact, not a cast.
    const transportError = isPageSpaceError(error) ? error : new NetworkError('Revocation request failed', { cause: error, operation });
    return { outcome: 'failed', retryable: true, error: transportError };
  }
  if (exchange.response.ok) {
    return { outcome: 'revoked' };
  }
  const error = classifyTokenEndpointError(exchange.response.status, exchange.response.headers, exchange.json, operation);
  return { outcome: 'failed', retryable: classifyRefreshFailure(error) === 'retryable', error };
}
