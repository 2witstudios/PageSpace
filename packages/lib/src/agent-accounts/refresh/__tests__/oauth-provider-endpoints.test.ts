/**
 * L3·G3 — the pinned endpoint registry is well-formed: every token endpoint
 * is a clean https URL `buildRefreshRequest` accepts, and every revocation
 * endpoint is https. A typo here would otherwise surface only as refreshes
 * that silently never happen.
 */
import { describe, expect, it } from 'vitest';
import { OAUTH_PROVIDER_ENDPOINTS } from '../oauth-provider-endpoints';
import { buildRefreshRequest } from '../build-refresh-request';

describe('OAUTH_PROVIDER_ENDPOINTS', () => {
  it('given each pinned provider, should name a token endpoint the refresh request builder accepts and https revocation', () => {
    const actual = Object.entries(OAUTH_PROVIDER_ENDPOINTS).map(([slug, entry]) => ({
      slug,
      buildable: buildRefreshRequest({ tokenEndpoint: entry.tokenEndpoint, clientAuth: entry.clientAuth, client: { clientId: 'c', clientSecret: 's' }, refreshToken: 'r' }).ok,
      revocationHttps: entry.revocationEndpoint === null || entry.revocationEndpoint.startsWith('https://'),
      issuerHttps: entry.issuer.startsWith('https://'),
    }));
    const expected = [
      { slug: 'google', buildable: true, revocationHttps: true, issuerHttps: true },
      { slug: 'zoom', buildable: true, revocationHttps: true, issuerHttps: true },
    ];
    expect(actual).toEqual(expected);
  });
});
