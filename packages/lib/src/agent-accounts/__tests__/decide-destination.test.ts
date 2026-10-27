/**
 * L2·G2 — `decideDestination`: may the executor send a credentialed request
 * to this URL? Requirement: "Given a request to any origin ≠ O (including O on
 * another port, or a redirect off O), should deny before any network I/O".
 *
 * Every request the executor sends carries the account's credential, so a
 * redirect is always a CREDENTIALED redirect: it is re-authorized (the target
 * is checked against the pin) and then never followed — the 3xx is released
 * to the caller instead. A redirect that stays on O is still not followed:
 * following it would send the credential to a path no approval covered.
 */
import { describe, expect, it } from 'vitest';
import type { CanonicalOrigin } from '../canonical-request';
import { decideDestination } from '../decide-destination';

const O = ['https://api.example.com:443' as CanonicalOrigin];

describe('decideDestination', () => {
  it('given the pinned origin, spelled any equivalent way, should allow the initial request', () => {
    const actual = ['https://api.example.com/v1/x', 'https://API.example.com:443/v1/x?y=1'].map((url) => decideDestination({ url, allowedOrigins: O, hop: 'initial' }));
    const expected = [
      { allow: true, origin: 'https://api.example.com:443' },
      { allow: true, origin: 'https://api.example.com:443' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given another origin — another port, a subdomain, a lookalike, a parent domain — should deny origin_not_allowed', () => {
    const urls = ['https://api.example.com:8443/x', 'https://evil.api.example.com/x', 'https://api.example.com.evil.test/x', 'https://example.com/x', 'https://xn--pi-7ma.example.com/x'];
    const actual = urls.map((url) => decideDestination({ url, allowedOrigins: O, hop: 'initial' }));
    const expected = urls.map(() => ({ allow: false, reason: 'origin_not_allowed' }));
    expect(actual).toEqual(expected);
  });

  it('given http, userinfo, an IP literal or garbage, should deny with the origin rule broken', () => {
    const actual = ['http://api.example.com/x', 'https://u:p@api.example.com/x', 'https://127.0.0.1/x', '::'].map((url) => decideDestination({ url, allowedOrigins: O, hop: 'initial' }));
    const expected = [
      { allow: false, reason: 'scheme_not_https' },
      { allow: false, reason: 'userinfo_present' },
      { allow: false, reason: 'ip_literal_host' },
      { allow: false, reason: 'malformed' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a redirect hop, on or off the pinned origin, absolute or relative, should never follow it', () => {
    const base = 'https://api.example.com/v1/start';
    const actual = [
      decideDestination({ url: '/v1/next', base, allowedOrigins: O, hop: 'redirect' }),
      decideDestination({ url: 'https://api.example.com/v1/next', base, allowedOrigins: O, hop: 'redirect' }),
      decideDestination({ url: 'https://collector.evil.test/steal', base, allowedOrigins: O, hop: 'redirect' }),
      decideDestination({ url: 'http://api.example.com/v1/next', base, allowedOrigins: O, hop: 'redirect' }),
    ];
    const expected = [
      { allow: false, reason: 'credentialed_redirect' },
      { allow: false, reason: 'credentialed_redirect' },
      { allow: false, reason: 'origin_not_allowed' },
      { allow: false, reason: 'scheme_not_https' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given an empty allow list, should deny everything', () => {
    const actual = decideDestination({ url: 'https://api.example.com/x', allowedOrigins: [], hop: 'initial' });
    const expected = { allow: false, reason: 'origin_not_allowed' };
    expect(actual).toEqual(expected);
  });
});
