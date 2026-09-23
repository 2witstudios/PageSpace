/**
 * L3·G3 — `planRefreshedMaterial`: turn a provider's token-endpoint response
 * into the next `oauth2` material the refresh worker rotates into the plane
 * (RFC 6749 §5.1, §6; RFC 9700 §4.14).
 *
 * What it guards: a refresh never widens authority (a response scope beyond
 * the stored scopes is refused, RFC 6749 §6), never changes where the next
 * refresh goes (issuer and token endpoint are carried, never read from the
 * response), keeps the old refresh token only when the provider did not
 * rotate it, and never trusts a response it cannot read as a bearer token set.
 */
import { describe, expect, it } from 'vitest';
import { planRefreshedMaterial, DEFAULT_ACCESS_TTL_MS } from '../plan-refreshed-material';
import type { SecretMaterialByKind } from '../../store/store-adapter';

const NOW = 1_800_000_000_000;

const previous: SecretMaterialByKind['oauth2'] = {
  accessToken: 'synthetic-old-access',
  accessExpiresAt: NOW - 1,
  refreshToken: 'synthetic-old-refresh',
  scopes: ['meeting:read', 'meeting:write'],
  issuer: 'https://zoom.us',
  tokenEndpoint: 'https://zoom.us/oauth/token',
};

describe('planRefreshedMaterial', () => {
  it('given a rotating provider response, should carry the new access and refresh tokens and the new expiry', () => {
    const actual = planRefreshedMaterial({ previous, response: { access_token: 'synthetic-new-access', token_type: 'bearer', expires_in: 3600, refresh_token: 'synthetic-new-refresh' }, now: NOW });
    const expected = {
      ok: true,
      rotated: true,
      next: { ...previous, accessToken: 'synthetic-new-access', accessExpiresAt: NOW + 3_600_000, refreshToken: 'synthetic-new-refresh' },
    };
    expect(actual).toEqual(expected);
  });

  it('given a provider that does not rotate the refresh token, should keep the stored one', () => {
    const actual = planRefreshedMaterial({ previous, response: { access_token: 'synthetic-new-access', token_type: 'Bearer', expires_in: 3599 }, now: NOW });
    const expected = { ok: true, rotated: false, next: { ...previous, accessToken: 'synthetic-new-access', accessExpiresAt: NOW + 3_599_000 } };
    expect(actual).toEqual(expected);
  });

  it('given no expires_in, should assume the default lifetime rather than a token that never expires', () => {
    const actual = planRefreshedMaterial({ previous, response: { access_token: 'synthetic-new-access', token_type: 'bearer' }, now: NOW });
    const expected = { ok: true, rotated: false, next: { ...previous, accessToken: 'synthetic-new-access', accessExpiresAt: NOW + DEFAULT_ACCESS_TTL_MS } };
    expect(actual).toEqual(expected);
  });

  it('given a narrower scope, should record the narrower scope', () => {
    const actual = planRefreshedMaterial({ previous, response: { access_token: 'synthetic-new-access', token_type: 'bearer', expires_in: 60, scope: 'meeting:read' }, now: NOW });
    const expected = { ok: true, rotated: false, next: { ...previous, accessToken: 'synthetic-new-access', accessExpiresAt: NOW + 60_000, scopes: ['meeting:read'] } };
    expect(actual).toEqual(expected);
  });

  it('given a scope the stored grant never had, should refuse rather than widen authority', () => {
    const actual = planRefreshedMaterial({ previous, response: { access_token: 'synthetic-new-access', token_type: 'bearer', expires_in: 60, scope: 'meeting:read user:write:admin' }, now: NOW });
    const expected = { ok: false, reason: 'scope_widened' };
    expect(actual).toEqual(expected);
  });

  it('given a response that tries to move the issuer or token endpoint, should ignore those fields and keep the stored ones', () => {
    const actual = planRefreshedMaterial({
      previous,
      response: { access_token: 'synthetic-new-access', token_type: 'bearer', expires_in: 60, issuer: 'https://evil.example', token_endpoint: 'https://evil.example/token' },
      now: NOW,
    });
    const expected = { ok: true, rotated: false, next: { ...previous, accessToken: 'synthetic-new-access', accessExpiresAt: NOW + 60_000 } };
    expect(actual).toEqual(expected);
  });

  it('given a token type other than bearer, should refuse — the executor only places bearer tokens', () => {
    const actual = planRefreshedMaterial({ previous, response: { access_token: 'synthetic-new-access', token_type: 'mac', expires_in: 60 }, now: NOW });
    const expected = { ok: false, reason: 'token_type' };
    expect(actual).toEqual(expected);
  });

  it('given a body without a usable access token or with a nonsense lifetime, should refuse as malformed', () => {
    const actual = [
      null,
      'synthetic-new-access',
      {},
      { access_token: '' },
      { access_token: 42 },
      { access_token: 'synthetic-new-access', token_type: 'bearer', expires_in: -5 },
      { access_token: 'synthetic-new-access', token_type: 'bearer', expires_in: 'soon' },
      { access_token: 'synthetic-new-access', token_type: 'bearer', expires_in: 60, refresh_token: '' },
      { access_token: 'synthetic-new-access', token_type: 'bearer', expires_in: 60, scope: 7 },
    ].map((response) => planRefreshedMaterial({ previous, response, now: NOW }));
    const expected = Array.from({ length: 9 }, () => ({ ok: false, reason: 'malformed' }));
    expect(actual).toEqual(expected);
  });

  it('given a response without token_type, should accept it as bearer — several providers omit it on refresh', () => {
    const actual = planRefreshedMaterial({ previous, response: { access_token: 'synthetic-new-access', expires_in: 60 }, now: NOW });
    const expected = { ok: true, rotated: false, next: { ...previous, accessToken: 'synthetic-new-access', accessExpiresAt: NOW + 60_000 } };
    expect(actual).toEqual(expected);
  });
});
