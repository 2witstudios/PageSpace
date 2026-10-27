/**
 * Pure validation for `GET /api/oauth/authorize` (ADR 0002 Decisions 1-3).
 *
 * Fail-closed and total: never throws. The two branches carry different
 * blast radii —
 *  - `no_redirect`: the client or redirect_uri itself could not be trusted,
 *    so the caller MUST render an error page and MUST NOT redirect anywhere
 *    (redirecting to an unvalidated URI is the classic OAuth open-redirect).
 *  - `redirect`: the redirect_uri is already validated, so the caller
 *    redirects there with `error=` per RFC 6749 §4.1.2.1.
 *
 * @module @pagespace/lib/auth/oauth/authorize-request
 */

import { parseScopeList, isPureDriveGrant, isAllDrivesGrant, hasNewKeyName, type ScopeSet } from './scopes';
import { validateRedirectUri, type RegisteredClient } from './clients';

export interface AuthorizeRequestParams {
  clientId: string | undefined;
  redirectUri: string | undefined;
  responseType: string | undefined;
  codeChallenge: string | undefined;
  codeChallengeMethod: string | undefined;
  scope: string | undefined;
  state: string | undefined;
}

export type AuthorizeNoRedirectError = 'invalid_client' | 'invalid_redirect_uri';
export type AuthorizeRedirectError = 'unsupported_response_type' | 'invalid_request' | 'invalid_scope';

export type AuthorizeValidationResult =
  | {
      ok: true;
      client: RegisteredClient;
      redirectUri: string;
      scopes: ScopeSet;
      codeChallenge: string;
      state: string | undefined;
    }
  | { ok: false; kind: 'no_redirect'; error: AuthorizeNoRedirectError }
  | { ok: false; kind: 'redirect'; error: AuthorizeRedirectError; redirectUri: string; state: string | undefined };

/**
 * Validate an authorize request against its (already-looked-up) client.
 * Validation order matters: client, then redirect_uri — both no-redirect
 * failures — before any check whose failure is reported via redirect.
 */
export function validateAuthorizeRequest(
  params: AuthorizeRequestParams,
  client: RegisteredClient | null,
): AuthorizeValidationResult {
  if (!client) {
    return { ok: false, kind: 'no_redirect', error: 'invalid_client' };
  }

  if (!params.redirectUri || !validateRedirectUri(client, params.redirectUri)) {
    return { ok: false, kind: 'no_redirect', error: 'invalid_redirect_uri' };
  }

  const redirectUri = params.redirectUri;
  const state = params.state;

  if (params.responseType !== 'code') {
    return { ok: false, kind: 'redirect', error: 'unsupported_response_type', redirectUri, state };
  }

  if (params.codeChallengeMethod !== 'S256' || !params.codeChallenge) {
    return { ok: false, kind: 'redirect', error: 'invalid_request', redirectUri, state };
  }

  if (!params.scope) {
    return { ok: false, kind: 'redirect', error: 'invalid_scope', redirectUri, state };
  }

  const parsedScope = parseScopeList(params.scope);
  if (!parsedScope.ok) {
    return { ok: false, kind: 'redirect', error: 'invalid_scope', redirectUri, state };
  }

  // A pure drive:* or all_drives grant, once exchanged, mints a REAL
  // mcp_tokens row (oauth-repository.ts's isPureDriveGrant/isAllDrivesGrant
  // branch) — unlike update_key/activate_key (re-scope/activate an EXISTING
  // key) or account/manage_keys (no row minted at all), there is no
  // server-side default name to fall back to; the consenting client must
  // supply one via the name:<percent-encoded> scope token. Enforced HERE
  // (not in parseScopeList itself, which is reused by flows — e.g.
  // device-authorization's plain OAuth token pairs — that never mint an
  // mcp_tokens row and legitimately carry no name) rather than in the two
  // callers separately: this is a pure function of the parsed scope set with
  // no DB/auth dependency, so it belongs beside every other scope-shape
  // rejection this function already owns, not duplicated in each caller.
  if ((isPureDriveGrant(parsedScope.scopes) || isAllDrivesGrant(parsedScope.scopes)) && !hasNewKeyName(parsedScope.scopes)) {
    return { ok: false, kind: 'redirect', error: 'invalid_scope', redirectUri, state };
  }

  return {
    ok: true,
    client,
    redirectUri,
    scopes: parsedScope.scopes,
    codeChallenge: params.codeChallenge,
    state,
  };
}
