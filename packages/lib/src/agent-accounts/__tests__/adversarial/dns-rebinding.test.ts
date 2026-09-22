import { describe, it, expect } from 'vitest';
import { canonicalizeRequest } from '../../canonicalize-request';
import type { CanonicalOrigin } from '../../canonical-request';
import { decidePinnedAddress } from '../../decide-pinned-address';
import { decideDestination } from '../../decide-destination';

// Threat model C2 (ASI02). Validate DNS and pin the connection; repeat per
// redirect hop. G2 owns the executor rows: the pure rows run here over
// `decidePinnedAddress` / `decideDestination` (the executor resolves ONCE,
// asks the first, connects only to the address it returns, and never follows
// a redirect); the I/O rows run against a real TLS server in
// `executor/__tests__/pinned-https-client.integration.test.ts` and end to end
// in `http-executor-end-to-end.integration.test.ts`.

function reasonFor(url: string): string {
  const result = canonicalizeRequest({
    request: { channel: 'http-executor', method: 'GET', url, headers: {}, body: new Uint8Array(0) },
    providerSlug: null,
    registry: [],
  });
  return result.ok ? 'ok' : result.reason;
}

describe('adversarial: dns-rebinding', () => {
  it('given an origin whose A record changes to a private address between authorization and connect, should refuse the connection — authorization never resolves, and the connect-time answer is the only one pinned', () => {
    const actual = decidePinnedAddress({ addresses: [{ address: '10.0.0.7', family: 4, isPublic: false }] });
    const expected = { ok: false, reason: 'non_public_address' };
    expect(actual).toEqual(expected);
  });

  it('given a hostname resolving to both a public and a private address, should refuse the whole answer (all-addresses rule, as the web_fetch shell)', () => {
    const actual = decidePinnedAddress({ addresses: [{ address: '93.184.216.34', family: 4, isPublic: true }, { address: '127.0.0.1', family: 4, isPublic: false }] });
    const expected = { ok: false, reason: 'non_public_address' };
    expect(actual).toEqual(expected);
  });

  it('given a redirect to a host resolving privately, should never reach DNS for it — no redirect is followed', () => {
    const actual = decideDestination({ url: 'https://internal.corp.example/admin', base: 'https://api.example.com/x', allowedOrigins: ['https://api.example.com:443' as CanonicalOrigin], hop: 'redirect' });
    const expected = { allow: false, reason: 'origin_not_allowed' };
    expect(actual).toEqual(expected);
  });

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
