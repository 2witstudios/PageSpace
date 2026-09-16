import { describe, it, expect } from 'vitest';
import { canonicalizeRequest } from '../../canonicalize-request';

// Threat model C2 (ASI02). Validate DNS and pin the connection; repeat per
// redirect hop. The connection-time rows are executor I/O (G2's http
// executor) and stay `it.todo` here; the one pure row — an IP literal never
// becomes an origin — is a table over `canonicalizeRequest`.

function reasonFor(url: string): string {
  const result = canonicalizeRequest({
    request: { channel: 'http-executor', method: 'GET', url, headers: {}, body: new Uint8Array(0), resources: {} },
    providerSlug: null,
    registry: [],
  });
  return result.ok ? 'ok' : result.reason;
}

describe('adversarial: dns-rebinding', () => {
  it.todo('given an origin whose A record changes to a private address between authorization and connect, should refuse the connection (pinned address) — I/O row, owned by G2 (http executor)');
  it.todo('given a hostname resolving to both a public and a private address, should refuse (all-addresses rule, as the web_fetch shell) — I/O row, owned by G2 (http executor)');
  it.todo('given a redirect to a host resolving privately, should refuse at that hop — I/O row, owned by G2 (http executor)');

  it.each([
    ['decimal', 'https://2130706433/'],
    ['hex', 'https://0x7f000001/'],
    ['octal', 'https://0177.0.0.1/'],
    ['dotted private', 'https://10.0.0.1/'],
    ['dotted public', 'https://8.8.8.8/'],
    ['short-form', 'https://127.1/'],
    ['ipv6 loopback', 'https://[::1]/'],
    ['ipv6 link-local', 'https://[fe80::1]/'],
    ['ipv6-mapped v4', 'https://[::ffff:10.0.0.1]/'],
  ])('given a %s IP literal, should refuse at canonicalization (ip_literal_host)', (_label, url) => {
    const actual = reasonFor(url);
    expect(actual).toBe('ip_literal_host');
  });
});
