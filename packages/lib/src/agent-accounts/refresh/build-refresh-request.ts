import type { OutboundRequest } from '../build-outbound-request';
import type { OAuthProviderEndpoints } from './decide-refresh-endpoint';

export type OAuthClientCredentials = { readonly clientId: string; readonly clientSecret: string };

export type RefreshRequestVerdict =
  | { readonly ok: true; readonly request: OutboundRequest }
  | { readonly ok: false; readonly reason: 'endpoint_invalid' | 'credential_invalid' };

export function buildRefreshRequest(_input: {
  readonly tokenEndpoint: string;
  readonly clientAuth: OAuthProviderEndpoints['clientAuth'];
  readonly client: OAuthClientCredentials;
  readonly refreshToken: string;
}): RefreshRequestVerdict {
  throw new Error('buildRefreshRequest: not implemented (RED)');
}
