export type OAuthProviderEndpoints = {
  readonly issuer: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint: string | null;
  readonly clientAuth: 'client_secret_basic' | 'client_secret_post';
};

export type OAuthEndpointRegistry = Readonly<Record<string, OAuthProviderEndpoints>>;

export type RefreshEndpointDecision =
  | { readonly ok: true; readonly tokenEndpoint: string; readonly clientAuth: OAuthProviderEndpoints['clientAuth'] }
  | { readonly ok: false; readonly reason: 'unknown_provider' | 'endpoint_mismatch' };

export function decideRefreshEndpoint(_input: {
  readonly providerSlug: string | null;
  readonly material: { readonly issuer: string; readonly tokenEndpoint: string };
  readonly registry: OAuthEndpointRegistry;
}): RefreshEndpointDecision {
  throw new Error('decideRefreshEndpoint: not implemented (RED)');
}
