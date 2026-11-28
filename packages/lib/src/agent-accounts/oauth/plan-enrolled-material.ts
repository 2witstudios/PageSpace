/**
 * `planEnrolledMaterial` — the authorization-code exchange's token response
 * (RFC 6749 §5.1, OpenID Connect Core §3.1.3.3) → the `oauth2` material the
 * plane stores, and which Google account it is. Pure; runs inside the plane.
 *
 * Refused unless the response is complete for an agent that works unattended:
 * an access token, a REFRESH token (`access_type=offline`), a positive
 * lifetime, a Bearer type, and granted scopes that include at least one
 * service asked for. The id token came straight from the pinned token endpoint
 * over TLS, so its claims are read without a signature check (OIDC Core
 * §3.1.3.7 item 6) — but still checked: issuer is the provider's, audience is
 * OUR client, it has not expired, and the email is verified. Granted scopes the
 * person unticked on Google's screen are simply not stored. The stored issuer
 * and token endpoint are the pinned registry's, so the refresh worker sends
 * the refresh token nowhere else (`decideRefreshEndpoint`).
 */
import type { SecretMaterialByKind } from '../store/store-adapter';
import type { OAuthProviderEndpoints } from '../refresh/decide-refresh-endpoint';

export type EnrolledMaterialVerdict =
  | { readonly ok: true; readonly material: SecretMaterialByKind['oauth2']; readonly email: string }
  | { readonly ok: false; readonly reason: 'malformed' | 'no_refresh_token' | 'no_service_granted' | 'identity_invalid' };

/** Google writes both forms of its issuer (OIDC Core §3.1.3.7 note). */
const ISSUER_ALIASES: Readonly<Record<string, readonly string[]>> = { 'https://accounts.google.com': ['https://accounts.google.com', 'accounts.google.com'] };
const IDENTITY_SCOPES = new Set(['openid', 'email', 'https://www.googleapis.com/auth/userinfo.email']);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

function claimsOf(idToken: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    return isRecord(claims) ? claims : null;
  } catch {
    return null;
  }
}

export function planEnrolledMaterial({
  body,
  endpoint,
  clientId,
  requestedScopes,
  now,
}: {
  readonly body: unknown;
  readonly endpoint: OAuthProviderEndpoints;
  readonly clientId: string;
  readonly requestedScopes: readonly string[];
  readonly now: number;
}): EnrolledMaterialVerdict {
  if (!isRecord(body)) return { ok: false, reason: 'malformed' };
  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn, token_type: tokenType, scope } = body;
  if (typeof accessToken !== 'string' || accessToken.length === 0 || typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return { ok: false, reason: 'malformed' };
  if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') return { ok: false, reason: 'malformed' };
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) return { ok: false, reason: 'no_refresh_token' };

  const requested = new Set(requestedScopes);
  const granted = typeof scope === 'string' ? scope.split(' ').filter((value) => value.length > 0) : [];
  const scopes = [...new Set(granted.filter((value) => requested.has(value) || IDENTITY_SCOPES.has(value)))].sort();
  if (!scopes.some((value) => !IDENTITY_SCOPES.has(value))) return { ok: false, reason: 'no_service_granted' };

  const claims = claimsOf(body.id_token);
  const issuers = ISSUER_ALIASES[endpoint.issuer] ?? [endpoint.issuer];
  const audience = claims?.aud;
  const audienceOk = audience === clientId || (Array.isArray(audience) && audience.includes(clientId));
  const email = claims?.email;
  if (
    claims === null ||
    typeof claims.iss !== 'string' ||
    !issuers.includes(claims.iss) ||
    !audienceOk ||
    typeof claims.exp !== 'number' ||
    claims.exp * 1000 <= now ||
    typeof email !== 'string' ||
    email.length === 0 ||
    claims.email_verified !== true
  ) {
    return { ok: false, reason: 'identity_invalid' };
  }

  return {
    ok: true,
    email,
    material: { accessToken, accessExpiresAt: now + Math.floor(expiresIn) * 1000, refreshToken, scopes, issuer: endpoint.issuer, tokenEndpoint: endpoint.tokenEndpoint },
  };
}
