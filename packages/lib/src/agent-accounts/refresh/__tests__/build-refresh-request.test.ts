/**
 * L3·G3 — `buildRefreshRequest`: the exact bytes the refresh worker sends to
 * a provider's token endpoint (RFC 6749 §6 refresh, §2.3.1 client auth).
 *
 * Pins: only an https endpoint with no credentials, query or fragment is a
 * destination; the refresh token and client secret travel only in the form
 * body or the Basic header the provider's registry entry names — never in the
 * URL; a value carrying a control character is refused so it can never split
 * a header; Basic credentials are form-urlencoded before base64 (§2.3.1).
 */
import { describe, expect, it } from 'vitest';
import { buildRefreshRequest } from '../build-refresh-request';

const client = { clientId: 'synthetic client', clientSecret: 's3cr/et:+' };
const decode = (body: Uint8Array) => new TextDecoder().decode(body);

describe('buildRefreshRequest', () => {
  it('given basic client authentication, should send the refresh grant in the form body and form-urlencoded credentials in the Authorization header', () => {
    const built = buildRefreshRequest({ tokenEndpoint: 'https://zoom.us/oauth/token', clientAuth: 'client_secret_basic', client, refreshToken: 'synthetic-refresh/+=' });
    const actual = built.ok ? { ...built.request, body: decode(built.request.body) } : built;
    const expected = {
      method: 'POST',
      url: 'https://zoom.us/oauth/token',
      hostname: 'zoom.us',
      port: 443,
      headers: [
        ['accept', 'application/json'],
        ['authorization', `Basic ${Buffer.from('synthetic+client:s3cr%2Fet%3A%2B').toString('base64')}`],
        ['content-type', 'application/x-www-form-urlencoded'],
        ['host', 'zoom.us'],
      ],
      body: 'grant_type=refresh_token&refresh_token=synthetic-refresh%2F%2B%3D',
    };
    expect(actual).toEqual(expected);
  });

  it('given post client authentication, should put the client credentials in the form body and send no Authorization header', () => {
    const built = buildRefreshRequest({ tokenEndpoint: 'https://oauth2.googleapis.com/token', clientAuth: 'client_secret_post', client, refreshToken: 'synthetic-refresh' });
    const actual = built.ok ? { headers: built.request.headers, body: decode(built.request.body) } : built;
    const expected = {
      headers: [
        ['accept', 'application/json'],
        ['content-type', 'application/x-www-form-urlencoded'],
        ['host', 'oauth2.googleapis.com'],
      ],
      body: 'grant_type=refresh_token&refresh_token=synthetic-refresh&client_id=synthetic+client&client_secret=s3cr%2Fet%3A%2B',
    };
    expect(actual).toEqual(expected);
  });

  it('given an endpoint on a non-default port, should carry the port in the host header and URL', () => {
    const built = buildRefreshRequest({ tokenEndpoint: 'https://idp.example:8443/token', clientAuth: 'client_secret_post', client, refreshToken: 'r' });
    const actual = built.ok ? { url: built.request.url, port: built.request.port, host: built.request.headers.find(([name]) => name === 'host') } : built;
    const expected = { url: 'https://idp.example:8443/token', port: 8443, host: ['host', 'idp.example:8443'] };
    expect(actual).toEqual(expected);
  });

  it('given an endpoint that is not a clean https URL, should refuse to build a request', () => {
    const actual = [
      'http://zoom.us/oauth/token',
      'https://user:pass@zoom.us/oauth/token',
      'https://zoom.us/oauth/token?refresh_token=x',
      'https://zoom.us/oauth/token#frag',
      'not a url',
    ].map((tokenEndpoint) => buildRefreshRequest({ tokenEndpoint, clientAuth: 'client_secret_post', client, refreshToken: 'r' }));
    const expected = Array.from({ length: 5 }, () => ({ ok: false, reason: 'endpoint_invalid' }));
    expect(actual).toEqual(expected);
  });

  it('given a refresh token or client credential carrying a control character or nothing at all, should refuse', () => {
    const actual = [
      buildRefreshRequest({ tokenEndpoint: 'https://zoom.us/oauth/token', clientAuth: 'client_secret_basic', client, refreshToken: 'r\r\nx-evil: 1' }),
      buildRefreshRequest({ tokenEndpoint: 'https://zoom.us/oauth/token', clientAuth: 'client_secret_basic', client: { clientId: 'id\n', clientSecret: 's' }, refreshToken: 'r' }),
      buildRefreshRequest({ tokenEndpoint: 'https://zoom.us/oauth/token', clientAuth: 'client_secret_basic', client, refreshToken: '' }),
      buildRefreshRequest({ tokenEndpoint: 'https://zoom.us/oauth/token', clientAuth: 'client_secret_post', client: { clientId: '', clientSecret: 's' }, refreshToken: 'r' }),
    ];
    const expected = Array.from({ length: 4 }, () => ({ ok: false, reason: 'credential_invalid' }));
    expect(actual).toEqual(expected);
  });
});
