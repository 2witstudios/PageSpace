import { describe, it, expect } from 'vitest';
import { canonicalizeRequest } from '../../canonicalize-request';
import type { CanonicalRequestInput } from '../../canonical-request';

// Threat model C1 (ASI02). Origin normalization as a table over the pure
// `canonicalizeRequest` (Control Board §7.7). A lookalike is a distinct origin
// AFTER normalization, so an allowlist compare on canonical origins can never
// be fooled by case, a trailing dot, an implicit port, or a homoglyph.

function originOf(url: string): string {
  const result = canonicalizeRequest({
    request: { channel: 'http-executor', method: 'GET', url, headers: {}, body: new Uint8Array(0) },
    providerSlug: null,
    registry: [],
  });
  return result.ok ? result.canonical.origin : `refused:${result.reason}`;
}

const ALLOWED = originOf('https://api.github.com/');

describe('adversarial: lookalike-origins', () => {
  it.each([
    ['cyrillic а in github', 'https://api.gіthub.com/'],
    ['a look-alike TLD', 'https://api.github.co/'],
    ['a subdomain of the allowed host', 'https://api.github.com.evil.example/'],
    ['the allowed host as a subdomain', 'https://evil.api.github.com/'],
  ])('given a punycode/homoglyph host for an allowed origin (%s), should not match after IDNA→ASCII normalization', (_label, url) => {
    const actual = originOf(url);
    expect(actual).not.toBe(ALLOWED);
    expect(actual.startsWith('refused:')).toBe(false);
  });

  it('given an allowed origin with a different port, should not match (explicit port always compared)', () => {
    const actual = originOf('https://api.github.com:8443/');
    expect(actual).not.toBe(ALLOWED);
    expect(actual).toBe('https://api.github.com:8443');
  });

  it.todo('given a parent-domain cookie in a capture, should be excluded unless the parent is itself allowed — I/O row, owned by G6b (session capture)');

  it.each([
    ['trailing dot', 'https://api.github.com./'],
    ['mixed case', 'https://API.GitHub.COM/'],
    ['explicit default port', 'https://api.github.com:443/'],
    ['all three', 'https://Api.GitHub.com.:443/'],
    ['fullwidth letters (UTS46 maps them to ASCII, so this IS the allowed host)', 'https://ａｐｉ.github.com/'],
  ])('given a host with %s, should normalize to the same canonical origin', (_label, url) => {
    const actual = originOf(url);
    expect(actual).toBe(ALLOWED);
  });

  it('given userinfo before an allowed host, should refuse at canonicalization', () => {
    const actual = originOf('https://api.github.com@evil.example/');
    expect(actual).toBe('refused:userinfo_present');
  });

  it('given a wildcard in the host, should refuse at canonicalization rather than match anything', () => {
    const actual = originOf('https://*.github.com/');
    expect(actual).toBe('refused:wildcard_host');
  });

  it('given the same request with the scheme downgraded, should refuse rather than normalize to https', () => {
    const actual = originOf('http://api.github.com/');
    expect(actual).toBe('refused:scheme_not_https');
  });

  it('given an input typed as CanonicalRequestInput, should not admit a pre-branded origin (the brand is earned by canonicalization)', () => {
    const input: CanonicalRequestInput = {
      channel: 'http-executor',
      method: 'GET',
      url: 'https://api.github.com/',
      headers: {},
      body: new Uint8Array(0),
    };
    // @ts-expect-error — a raw string is not a CanonicalOrigin
    const raw: import('../../canonical-request').CanonicalOrigin = input.url;
    expect(typeof raw).toBe('string');
  });
});
