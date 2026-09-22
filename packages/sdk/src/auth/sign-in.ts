/**
 * "Sign in with PageSpace" — the pure half of the authorization-code + PKCE
 * flow (Phase 3 leaf 1; ADR 0004 Decision 11): the authorize URL an app sends
 * the user to, and the reading of the redirect that comes back.
 *
 * No I/O, no clock, no randomness: `state` and the PKCE challenge arrive as
 * arguments (see `pkce.ts` for the challenge, `pagespace-auth.ts` for where
 * the randomness comes from). Every decision here is a plain value in, a
 * plain value out, and `parseCallback` never throws — a redirect is untrusted
 * input that anyone can craft, so every way it can be wrong is a typed result
 * the caller has to handle rather than an exception it can forget.
 */

/**
 * The standard redirect path for apps signing in with PageSpace ([D-10],
 * ADR 0004 "Decided"). Zero-config apps (`PageSpaceClient.fromEnvironment`)
 * register `<origin>/auth/pagespace/callback`, and the platform-managed env
 * client (Phase 4) derives its redirect URIs with the same path.
 */
export const PAGESPACE_CALLBACK_PATH = '/auth/pagespace/callback';

const AUTHORIZE_PATH = '/api/oauth/authorize';
const TOKEN_PATH = '/api/oauth/token';
const REVOKE_PATH = '/api/oauth/revoke';

export interface PageSpaceOAuthEndpoints {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint: string;
}

/**
 * Trims trailing `/` without a regex — `/\/+$/` is flagged as a
 * polynomial-backtracking risk on caller-influenced input (same helper as
 * `client.ts`).
 */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

/**
 * The provider's endpoints, derived from a PageSpace base URL. Fixed paths
 * rather than a discovery round trip: a browser app signs in with one fewer
 * request, and the endpoints it posts a code and a verifier to are the ones
 * its own configuration names — never whatever a metadata document says.
 * (`discoverMetadata` in `token-endpoint.ts` exists for callers that want it.)
 */
export function pageSpaceOAuthEndpoints(baseUrl: string): PageSpaceOAuthEndpoints {
  const base = trimTrailingSlashes(baseUrl);
  return {
    authorizationEndpoint: `${base}${AUTHORIZE_PATH}`,
    tokenEndpoint: `${base}${TOKEN_PATH}`,
    revocationEndpoint: `${base}${REVOKE_PATH}`,
  };
}

export interface AuthorizeUrlParams {
  /** The PageSpace deployment, e.g. `https://pagespace.ai`. */
  readonly baseUrl: string;
  readonly clientId: string;
  /** Must exactly match a redirect URI registered on the client. */
  readonly redirectUri: string;
  /** Space-delimited (RFC 6749 §3.3), e.g. `"profile offline_access"`. */
  readonly scope: string;
  /** Opaque, unguessable, single-use; compared again by `parseCallback`. */
  readonly state: string;
  /** BASE64URL(SHA256(code_verifier)) — see `deriveCodeChallenge`. */
  readonly codeChallenge: string;
}

/**
 * The RFC 6749 §4.1.1 authorization request, with RFC 7636 S256 PKCE (the
 * only method PageSpace accepts). Values are percent-encoded by
 * `URLSearchParams`, so no argument can smuggle in a second parameter.
 */
export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const url = new URL(pageSpaceOAuthEndpoints(params.baseUrl).authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scope);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** The `error` values RFC 6749 §4.1.2.1 defines for an authorization response. */
export const AUTHORIZATION_ERROR_CODES = [
  'invalid_request',
  'unauthorized_client',
  'access_denied',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
] as const;

export type AuthorizationErrorCode = (typeof AUTHORIZATION_ERROR_CODES)[number];

export type CallbackError =
  /** The callback's `state` is absent, duplicated, or not the one this app issued: a forged or replayed redirect. */
  | { readonly reason: 'state_mismatch' }
  /** The state matched but no (single, non-empty) `code` came with it. */
  | { readonly reason: 'missing_code' }
  /** The callback is not a URL at all. */
  | { readonly reason: 'malformed_callback' }
  /**
   * The authorization server answered with an RFC 6749 §4.1.2.1 error —
   * `access_denied` when the user declined. A value outside the RFC is
   * reported as `'unrecognized'` rather than echoed: the redirect is
   * attacker-craftable, and its text may end up on screen.
   */
  | {
      readonly reason: 'authorization_error';
      readonly error: AuthorizationErrorCode | 'unrecognized';
      readonly errorDescription: string | null;
    };

export type CallbackResult = { readonly ok: true; readonly code: string } | { readonly ok: false; readonly error: CallbackError };

const MAX_ERROR_DESCRIPTION_LENGTH = 256;

/** RFC 6749 §4.1.2.1: `error_description` is `%x20-21 / %x23-5B / %x5D-7E` — printable ASCII minus `"` and `\`. */
function isWellFormedErrorDescription(value: string): boolean {
  if (value.length === 0 || value.length > MAX_ERROR_DESCRIPTION_LENGTH) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e || code === 0x22 || code === 0x5c) return false;
  }
  return true;
}

function isAuthorizationErrorCode(value: string): value is AuthorizationErrorCode {
  return (AUTHORIZATION_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Compares two strings in time that depends only on their lengths, not on
 * where they first differ. An in-browser `state` check is not a realistic
 * timing target, but a native or server-side caller may run this where it
 * is, and there is no reason for the comparison to leak.
 */
function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Exactly one occurrence, or null — a repeated parameter is ambiguous and fails closed. */
function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function toUrl(url: string | URL): URL | null {
  if (url instanceof URL) return url;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Reads an authorization redirect (RFC 6749 §4.1.2). The `state` is compared
 * FIRST, before the code or any error is looked at: nothing in a redirect is
 * believed until it is proven to answer a request this app made. An empty
 * expected state never matches. Never throws.
 */
export function parseCallback(url: string | URL, expectedState: string): CallbackResult {
  const parsed = toUrl(url);
  if (parsed === null) {
    return { ok: false, error: { reason: 'malformed_callback' } };
  }
  const params = parsed.searchParams;

  const state = single(params, 'state');
  if (expectedState.length === 0 || state === null || !constantTimeEqual(state, expectedState)) {
    return { ok: false, error: { reason: 'state_mismatch' } };
  }

  if (params.has('error')) {
    const error = single(params, 'error');
    const description = single(params, 'error_description');
    return {
      ok: false,
      error: {
        reason: 'authorization_error',
        error: error !== null && isAuthorizationErrorCode(error) ? error : 'unrecognized',
        errorDescription: description !== null && isWellFormedErrorDescription(description) ? description : null,
      },
    };
  }

  const code = single(params, 'code');
  if (code === null || code.length === 0) {
    return { ok: false, error: { reason: 'missing_code' } };
  }
  return { ok: true, code };
}
