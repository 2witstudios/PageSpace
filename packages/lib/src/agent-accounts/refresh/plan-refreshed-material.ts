/**
 * `planRefreshedMaterial` — the next `oauth2` material from a provider's
 * token-endpoint response (RFC 6749 §5.1, §6; RFC 9700 §4.14). Pure; the
 * refresh worker hands it the parsed JSON body and rotates `next` into the
 * plane under CAS.
 *
 * - A refresh never widens authority: a `scope` naming anything the stored
 *   grant lacked is `scope_widened` (RFC 6749 §6). A narrower scope is
 *   recorded; an absent one keeps the stored scopes.
 * - Where the next refresh goes is never read from a response: `issuer` and
 *   `tokenEndpoint` are carried from `previous` (fixed provider endpoints).
 * - The stored refresh token is kept only when the provider did not issue a
 *   new one; a non-empty `refresh_token` is a rotation (`rotated: true`).
 * - Only bearer tokens are placed by the executor: any other `token_type` is
 *   refused; an absent one is bearer (several providers omit it on refresh).
 * - A missing `expires_in` means the default lifetime, never "no expiry".
 */
import type { SecretMaterialByKind } from '../store/store-adapter';

/** Lifetime assumed for an access token whose response carried no `expires_in`. */
export const DEFAULT_ACCESS_TTL_MS = 3_600_000;

export type RefreshedMaterialPlan =
  | { readonly ok: true; readonly rotated: boolean; readonly next: SecretMaterialByKind['oauth2'] }
  | { readonly ok: false; readonly reason: 'malformed' | 'token_type' | 'scope_widened' };

const MALFORMED = { ok: false, reason: 'malformed' } as const;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function planRefreshedMaterial({
  previous,
  response,
  now,
}: {
  readonly previous: SecretMaterialByKind['oauth2'];
  readonly response: unknown;
  readonly now: number;
}): RefreshedMaterialPlan {
  if (!isRecord(response)) return MALFORMED;
  const { access_token: accessToken, token_type: tokenType, expires_in: expiresIn, refresh_token: refreshToken, scope } = response;
  if (typeof accessToken !== 'string' || accessToken === '') return MALFORMED;
  if (expiresIn !== undefined && (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0)) return MALFORMED;
  if (refreshToken !== undefined && (typeof refreshToken !== 'string' || refreshToken === '')) return MALFORMED;
  if (scope !== undefined && typeof scope !== 'string') return MALFORMED;
  if (tokenType !== undefined && (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer')) return { ok: false, reason: 'token_type' };

  const scopes = scope === undefined ? previous.scopes : scope.split(' ').filter((entry) => entry !== '');
  if (scopes.some((entry) => !previous.scopes.includes(entry))) return { ok: false, reason: 'scope_widened' };

  return {
    ok: true,
    rotated: refreshToken !== undefined,
    next: {
      accessToken,
      accessExpiresAt: now + (expiresIn === undefined ? DEFAULT_ACCESS_TTL_MS : expiresIn * 1000),
      refreshToken: refreshToken ?? previous.refreshToken,
      scopes,
      issuer: previous.issuer,
      tokenEndpoint: previous.tokenEndpoint,
    },
  };
}
