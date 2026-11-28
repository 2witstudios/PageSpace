/**
 * L3·G3 — `decideRefreshEndpoint`: where the refresh worker may send a
 * refresh token (RFC 9700 §4.4 mix-up / issuer confusion; threat model A10
 * "fixed provider endpoints").
 *
 * The answer is ALWAYS the pinned registry's endpoint for the account's
 * provider, never the endpoint stored beside the material: a stored issuer or
 * token endpoint that disagrees with the registry means the record was
 * written by something other than our enrollment, and the refresh token is
 * not sent anywhere.
 */
import { describe, expect, it } from 'vitest';
import { decideRefreshEndpoint, type OAuthEndpointRegistry } from '../decide-refresh-endpoint';

const registry: OAuthEndpointRegistry = {
  zoom: { issuer: 'https://zoom.us', tokenEndpoint: 'https://zoom.us/oauth/token', revocationEndpoint: 'https://zoom.us/oauth/revoke', clientAuth: 'client_secret_basic' },
  google: { issuer: 'https://accounts.google.com', tokenEndpoint: 'https://oauth2.googleapis.com/token', revocationEndpoint: 'https://oauth2.googleapis.com/revoke', clientAuth: 'client_secret_post' },
};

const zoomMaterial = { issuer: 'https://zoom.us', tokenEndpoint: 'https://zoom.us/oauth/token' };

describe('decideRefreshEndpoint', () => {
  it('given stored endpoints that match the pinned registry, should return the registry endpoint and client authentication', () => {
    const actual = decideRefreshEndpoint({ providerSlug: 'zoom', material: zoomMaterial, registry });
    const expected = { ok: true, tokenEndpoint: 'https://zoom.us/oauth/token', clientAuth: 'client_secret_basic' };
    expect(actual).toEqual(expected);
  });

  it('given a stored token endpoint that differs from the registry, should refuse to send the refresh token anywhere', () => {
    const actual = [
      decideRefreshEndpoint({ providerSlug: 'zoom', material: { ...zoomMaterial, tokenEndpoint: 'https://attacker.example/token' }, registry }),
      decideRefreshEndpoint({ providerSlug: 'zoom', material: { ...zoomMaterial, tokenEndpoint: 'https://zoom.us/oauth/token/' }, registry }),
      decideRefreshEndpoint({ providerSlug: 'zoom', material: { ...zoomMaterial, tokenEndpoint: 'http://zoom.us/oauth/token' }, registry }),
    ];
    const expected = [
      { ok: false, reason: 'endpoint_mismatch' },
      { ok: false, reason: 'endpoint_mismatch' },
      { ok: false, reason: 'endpoint_mismatch' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a stored issuer from another provider, should refuse (mix-up)', () => {
    const actual = decideRefreshEndpoint({ providerSlug: 'zoom', material: { ...zoomMaterial, issuer: 'https://accounts.google.com' }, registry });
    const expected = { ok: false, reason: 'endpoint_mismatch' };
    expect(actual).toEqual(expected);
  });

  it('given a generic or unknown provider, should refuse — only reviewed providers are refreshed', () => {
    const actual = [null, 'dropbox', '__proto__', 'constructor', 'toString'].map((providerSlug) => decideRefreshEndpoint({ providerSlug, material: zoomMaterial, registry }));
    const expected = Array.from({ length: 5 }, () => ({ ok: false, reason: 'unknown_provider' }));
    expect(actual).toEqual(expected);
  });
});
