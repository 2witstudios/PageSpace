/**
 * `decideRefreshEndpoint` — where the refresh worker may send a refresh token
 * (RFC 9700 §4.4 mix-up; threat model A10 "fixed provider endpoints"). Pure.
 *
 * The endpoint returned is ALWAYS the pinned registry's, never the one stored
 * beside the material. The stored issuer and token endpoint must equal the
 * registry's exactly — our enrollment writes them from the registry — so a
 * record that disagrees was written by something else, and the refresh token
 * goes nowhere (`endpoint_mismatch`). A generic provider (`null`) or one the
 * registry does not name is `unknown_provider`; the lookup is own-property
 * only, so `__proto__`/`constructor` are unknown too.
 */
export type OAuthProviderEndpoints = {
  /** The authorization server's issuer identifier (RFC 8414), exact string. */
  readonly issuer: string;
  readonly tokenEndpoint: string;
  /** RFC 7009 revocation endpoint, or null when the provider has none usable with the token alone. */
  readonly revocationEndpoint: string | null;
  readonly clientAuth: 'client_secret_basic' | 'client_secret_post';
};

export type OAuthEndpointRegistry = Readonly<Record<string, OAuthProviderEndpoints>>;

export type RefreshEndpointDecision =
  | { readonly ok: true; readonly tokenEndpoint: string; readonly clientAuth: OAuthProviderEndpoints['clientAuth'] }
  | { readonly ok: false; readonly reason: 'unknown_provider' | 'endpoint_mismatch' };

export function decideRefreshEndpoint({
  providerSlug,
  material,
  registry,
}: {
  readonly providerSlug: string | null;
  readonly material: { readonly issuer: string; readonly tokenEndpoint: string };
  readonly registry: OAuthEndpointRegistry;
}): RefreshEndpointDecision {
  if (providerSlug === null || !Object.hasOwn(registry, providerSlug)) return { ok: false, reason: 'unknown_provider' };
  const pinned = registry[providerSlug];
  if (material.issuer !== pinned.issuer || material.tokenEndpoint !== pinned.tokenEndpoint) return { ok: false, reason: 'endpoint_mismatch' };
  return { ok: true, tokenEndpoint: pinned.tokenEndpoint, clientAuth: pinned.clientAuth };
}
