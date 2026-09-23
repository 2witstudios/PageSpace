/**
 * The pinned OAuth endpoint registry (L3·G3; threat model A10 "fixed provider
 * endpoints"). Data only: `decideRefreshEndpoint` compares a stored account's
 * issuer and token endpoint against these exact strings and sends a refresh
 * token nowhere else. Only providers whose access tokens EXPIRE are listed —
 * GitHub, Slack and Notion connections hold non-expiring tokens and never
 * reach the refresh worker (`planConnectionAccount`).
 *
 * Values are the endpoints PageSpace's current code already calls
 * (`google-auth-library`'s token endpoint with `client_secret_post`; Zoom's
 * token endpoint with Basic client auth). A change here is a security review.
 */
import type { OAuthEndpointRegistry } from './decide-refresh-endpoint';

export const OAUTH_PROVIDER_ENDPOINTS: OAuthEndpointRegistry = {
  google: {
    issuer: 'https://accounts.google.com',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
    clientAuth: 'client_secret_post',
  },
  zoom: {
    issuer: 'https://zoom.us',
    tokenEndpoint: 'https://zoom.us/oauth/token',
    revocationEndpoint: 'https://zoom.us/oauth/revoke',
    clientAuth: 'client_secret_basic',
  },
};
