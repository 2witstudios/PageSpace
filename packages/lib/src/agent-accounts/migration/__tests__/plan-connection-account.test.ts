/**
 * L3·G3 — `planConnectionAccount`: what one `integration_connections` row
 * becomes in the credential plane (ADR 0005 §6 extend-vs-new: migrate each
 * row's material into an `agent_accounts` reference + plane secret).
 *
 * The contract: the account's key is placed on the wire EXACTLY as
 * `applyAuth` placed it for the legacy connection (same header or query name,
 * same prefix), so a migrated tool call is byte-identical upstream; the
 * account is pinned to the provider's canonical origin; anything the plane
 * cannot yet hold faithfully is refused and stays on the legacy ratchet —
 * never approximated. Refusals: drive-scoped rows (no owner model yet, D-16),
 * a per-connection base-URL override (the D-28 SSRF input, dropped by ADR
 * 0005), expiring OAuth (needs the refresh worker's authorization), body
 * placement, more than one credential header, missing or header-splitting
 * values.
 */
import { describe, expect, it } from 'vitest';
import type { AuthMethod } from '../../../integrations/types';
import { planConnectionAccount } from '../plan-connection-account';

const userConnection = { userId: 'user_1', driveId: null, baseUrlOverride: null };
const provider = (authMethod: AuthMethod, baseUrl = 'https://api.github.com') => ({ slug: 'github', baseUrl, authMethod });
const ORIGIN = 'https://api.github.com:443';

describe('planConnectionAccount', () => {
  it('given a non-expiring OAuth connection, should place the access token in the Authorization header with the same prefix', () => {
    const actual = planConnectionAccount({
      connection: userConnection,
      provider: provider({ type: 'oauth2', config: { authorizationUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token', scopes: ['repo'] } }),
      credentials: { accessToken: 'gho_synthetic' },
    });
    const expected = {
      ok: true,
      owner: { kind: 'user', userId: 'user_1' },
      kind: 'api_key',
      material: { value: 'Bearer gho_synthetic', placement: { in: 'header', name: 'Authorization' } },
      allowedOrigins: [ORIGIN],
      providerSlug: 'github',
    };
    expect(actual).toEqual(expected);
  });

  it('given an OAuth connection placed in the query, should place the token as access_token', () => {
    const actual = planConnectionAccount({
      connection: userConnection,
      provider: provider({ type: 'oauth2', config: { authorizationUrl: 'https://x.example/a', tokenUrl: 'https://x.example/t', scopes: [], tokenPlacement: 'query' } }),
      credentials: { access_token: 'synthetic' },
    });
    const expected = { value: 'synthetic', placement: { in: 'query', name: 'access_token' } };
    expect(actual.ok ? actual.material : actual).toEqual(expected);
  });

  it('given an OAuth connection holding a refresh token or an expiry, should refuse until the refresh worker can serve it', () => {
    const oauth: AuthMethod = { type: 'oauth2', config: { authorizationUrl: 'https://x.example/a', tokenUrl: 'https://x.example/t', scopes: [] } };
    const actual = [{ accessToken: 'a', refreshToken: 'r' }, { access_token: 'a', refresh_token: 'r' }, { accessToken: 'a', expiresAt: '2027-01-01T00:00:00Z' }].map((credentials) =>
      planConnectionAccount({ connection: userConnection, provider: provider(oauth), credentials }),
    );
    const expected = Array.from({ length: 3 }, () => ({ ok: false, reason: 'needs_refresh_worker' }));
    expect(actual).toEqual(expected);
  });

  it('given api key, bearer and basic connections, should reproduce applyAuth placement and prefix exactly', () => {
    const actual = [
      planConnectionAccount({ connection: userConnection, provider: provider({ type: 'api_key', config: { placement: 'header', paramName: 'X-Api-Key', prefix: 'Key ' } }), credentials: { apiKey: 'k1' } }),
      planConnectionAccount({ connection: userConnection, provider: provider({ type: 'api_key', config: { placement: 'query', paramName: 'key' } }), credentials: { apiKey: 'k2' } }),
      planConnectionAccount({ connection: userConnection, provider: provider({ type: 'bearer_token', config: {} }), credentials: { token: 't1' } }),
      planConnectionAccount({ connection: userConnection, provider: provider({ type: 'bearer_token', config: { headerName: 'X-Token', prefix: '' } }), credentials: { token: 't2' } }),
      planConnectionAccount({ connection: userConnection, provider: provider({ type: 'basic_auth', config: { usernameField: 'user', passwordField: 'pass' } }), credentials: { user: 'u', pass: 'p:w' } }),
    ].map((plan) => (plan.ok ? plan.material : plan));
    const expected = [
      { value: 'Key k1', placement: { in: 'header', name: 'X-Api-Key' } },
      { value: 'k2', placement: { in: 'query', name: 'key' } },
      { value: 'Bearer t1', placement: { in: 'header', name: 'Authorization' } },
      { value: 't2', placement: { in: 'header', name: 'X-Token' } },
      { value: `Basic ${btoa('u:p:w')}`, placement: { in: 'header', name: 'Authorization' } },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a custom-header connection, should carry its one credential header and refuse two', () => {
    const one: AuthMethod = { type: 'custom_header', config: { headers: [{ name: 'X-Secret', valueFrom: 'credential', credentialKey: 'secret' }, { name: 'X-Version', valueFrom: 'static', staticValue: '2' }] } };
    const two: AuthMethod = { type: 'custom_header', config: { headers: [{ name: 'X-A', valueFrom: 'credential', credentialKey: 'a' }, { name: 'X-B', valueFrom: 'credential', credentialKey: 'b' }] } };
    const actual = [
      planConnectionAccount({ connection: userConnection, provider: provider(one), credentials: { secret: 's' } }),
      planConnectionAccount({ connection: userConnection, provider: provider(two), credentials: { a: '1', b: '2' } }),
    ].map((plan) => (plan.ok ? plan.material : plan));
    const expected = [{ value: 's', placement: { in: 'header', name: 'X-Secret' } }, { ok: false, reason: 'unsupported_auth' }];
    expect(actual).toEqual(expected);
  });

  it('given a drive-scoped connection or a base-URL override, should refuse and leave it on the legacy path', () => {
    const bearer: AuthMethod = { type: 'bearer_token', config: {} };
    const actual = [
      planConnectionAccount({ connection: { userId: null, driveId: 'drive_1', baseUrlOverride: null }, provider: provider(bearer), credentials: { token: 't' } }),
      planConnectionAccount({ connection: { ...userConnection, baseUrlOverride: 'https://internal.example' }, provider: provider(bearer), credentials: { token: 't' } }),
    ];
    const expected = [
      { ok: false, reason: 'drive_scoped' },
      { ok: false, reason: 'base_url_override' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given no credential, body placement, or an auth method with nothing to hold, should refuse', () => {
    const actual = [
      planConnectionAccount({ connection: userConnection, provider: provider({ type: 'none' }), credentials: {} }),
      planConnectionAccount({ connection: userConnection, provider: provider({ type: 'bearer_token', config: {} }), credentials: {} }),
      planConnectionAccount({ connection: userConnection, provider: provider({ type: 'api_key', config: { placement: 'body', paramName: 'key' } }), credentials: { apiKey: 'k' } }),
    ];
    const expected = [
      { ok: false, reason: 'no_credential' },
      { ok: false, reason: 'no_credential' },
      { ok: false, reason: 'unsupported_auth' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a value that could split a header or a placement name that is not a token, should refuse', () => {
    const actual = [
      planConnectionAccount({ connection: userConnection, provider: provider({ type: 'bearer_token', config: {} }), credentials: { token: 't\r\nX-Evil: 1' } }),
      planConnectionAccount({ connection: userConnection, provider: provider({ type: 'api_key', config: { placement: 'header', paramName: 'X Key' } }), credentials: { apiKey: 'k' } }),
      planConnectionAccount({ connection: userConnection, provider: provider({ type: 'bearer_token', config: {} }), credentials: { token: 'x'.repeat(8_200) } }),
    ];
    const expected = Array.from({ length: 3 }, () => ({ ok: false, reason: 'value_invalid' }));
    expect(actual).toEqual(expected);
  });

  it('given a provider base URL that is not a public https origin, should refuse; a base path is dropped from the pin', () => {
    const bearer: AuthMethod = { type: 'bearer_token', config: {} };
    const actual = [
      planConnectionAccount({ connection: userConnection, provider: provider(bearer, 'http://api.example.com'), credentials: { token: 't' } }),
      planConnectionAccount({ connection: userConnection, provider: provider(bearer, 'https://10.0.0.1'), credentials: { token: 't' } }),
      planConnectionAccount({ connection: userConnection, provider: provider(bearer, 'https://slack.com/api'), credentials: { token: 't' } }),
    ].map((plan) => (plan.ok ? plan.allowedOrigins : plan));
    const expected = [{ ok: false, reason: 'invalid_origin' }, { ok: false, reason: 'invalid_origin' }, ['https://slack.com:443']];
    expect(actual).toEqual(expected);
  });
});
