/**
 * L2·G2 — `buildOutboundRequest`: the FRESH request the executor sends, built
 * from the canonical request the grant's digest covers plus the resolved key —
 * never from the caller's raw request object.
 *
 * What is sent is exactly what was digested: method, origin, the canonical
 * path and query, the projected headers, and body bytes whose SHA-256 is the
 * canonical `bodySha256`. The executor adds `host` and the key at its
 * placement; nothing else. A key placement that collides with a header or
 * query parameter the request already carries is refused, not merged — the
 * model must not be able to pre-set the parameter the key rides in.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { HashBytes } from '../grant';
import type { CanonicalRequest } from '../canonical-request';
import { canonicalizeRequest } from '../canonicalize-request';
import { buildOutboundRequest } from '../build-outbound-request';

const sha256: HashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const KEY = 'sk_live_4f9a2c7e1b3d5f7a9c1e';
const enc = (text: string) => new TextEncoder().encode(text);

function canonicalOf(url: string, method = 'GET', body = new Uint8Array(0), headers: Record<string, string> = {}): CanonicalRequest {
  const result = canonicalizeRequest({ request: { channel: 'http-executor', method, url, headers, body }, providerSlug: null, registry: [] });
  if (!result.ok) throw new Error(`fixture refused: ${result.reason}`);
  return result.canonical;
}

describe('buildOutboundRequest', () => {
  it('given a GET and a header placement, should send the canonical URL with host and the key header and nothing else', () => {
    const canonical = canonicalOf('https://API.example.com/v1/forecast?city=Oslo&units=metric', 'GET', new Uint8Array(0), { Accept: 'application/json' });
    const actual = buildOutboundRequest({ canonical, body: new Uint8Array(0), material: { value: KEY, placement: { in: 'header', name: 'authorization' } }, sha256 });
    const expected = {
      ok: true,
      request: {
        method: 'GET',
        url: 'https://api.example.com/v1/forecast?city=Oslo&units=metric',
        hostname: 'api.example.com',
        port: 443,
        headers: [
          ['accept', 'application/json'],
          ['authorization', KEY],
          ['content-length', '0'],
          ['host', 'api.example.com'],
        ],
        body: new Uint8Array(0),
      },
    };
    expect(actual).toEqual(expected);
  });

  it('given a query placement and a non-default port, should append the encoded key parameter and keep the port in host', () => {
    const canonical = canonicalOf('https://api.example.com:8443/v1/x?a=1');
    const verdict = buildOutboundRequest({ canonical, body: new Uint8Array(0), material: { value: 'k y&z', placement: { in: 'query', name: 'api_key' } }, sha256 });
    const actual = verdict.ok ? { url: verdict.request.url, host: verdict.request.headers.find(([name]) => name === 'host'), port: verdict.request.port } : verdict;
    const expected = { url: 'https://api.example.com:8443/v1/x?a=1&api_key=k%20y%26z', host: ['host', 'api.example.com:8443'], port: 8443 };
    expect(actual).toEqual(expected);
  });

  it('given a POST, should carry the exact body bytes with the derived content-length', () => {
    const body = enc('{"q":"x"}');
    const canonical = canonicalOf('https://api.example.com/v1/q', 'POST', body, { 'Content-Type': 'application/json' });
    const verdict = buildOutboundRequest({ canonical, body, material: { value: KEY, placement: { in: 'header', name: 'x-api-key' } }, sha256 });
    const actual = verdict.ok ? { body: verdict.request.body, length: verdict.request.headers.find(([name]) => name === 'content-length') } : verdict;
    const expected = { body, length: ['content-length', '9'] };
    expect(actual).toEqual(expected);
  });

  it('given body bytes that are not the ones the canonical request digested, should refuse body_mismatch', () => {
    const canonical = canonicalOf('https://api.example.com/v1/q', 'POST', enc('{"q":"x"}'), { 'Content-Type': 'application/json' });
    const actual = buildOutboundRequest({ canonical, body: enc('{"q":"y"}'), material: { value: KEY, placement: { in: 'header', name: 'x-api-key' } }, sha256 });
    const expected = { ok: false, reason: 'body_mismatch' };
    expect(actual).toEqual(expected);
  });

  it('given a placement that collides with a query parameter or a header the request already carries, should refuse placement_collision', () => {
    const actual = [
      buildOutboundRequest({ canonical: canonicalOf('https://api.example.com/v1/x?api_key=attacker'), body: new Uint8Array(0), material: { value: KEY, placement: { in: 'query', name: 'api_key' } }, sha256 }),
      buildOutboundRequest({ canonical: canonicalOf('https://api.example.com/v1/x', 'GET', new Uint8Array(0), { Accept: '*/*' }), body: new Uint8Array(0), material: { value: KEY, placement: { in: 'header', name: 'accept' } }, sha256 }),
    ];
    const expected = [
      { ok: false, reason: 'placement_collision' },
      { ok: false, reason: 'placement_collision' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a key value carrying CR or LF, should refuse key_invalid rather than split a header', () => {
    const actual = buildOutboundRequest({ canonical: canonicalOf('https://api.example.com/v1/x'), body: new Uint8Array(0), material: { value: 'k\r\nx-evil: 1', placement: { in: 'header', name: 'authorization' } }, sha256 });
    const expected = { ok: false, reason: 'key_invalid' };
    expect(actual).toEqual(expected);
  });

  it('given a caller query parameter whose name differs from the key placement only by case, dots, spaces or brackets, should refuse placement_collision — servers that fold names would read the attacker\'s value', () => {
    const urls = ['https://api.example.com/v1/x?API_KEY=attacker', 'https://api.example.com/v1/x?api.key=attacker', 'https://api.example.com/v1/x?api%20key=attacker', 'https://api.example.com/v1/x?api%5Bkey=attacker'];
    const actual = urls.map((url) => buildOutboundRequest({ canonical: canonicalOf(url), body: new Uint8Array(0), material: { value: KEY, placement: { in: 'query', name: 'api_key' } }, sha256 }));
    const expected = urls.map(() => ({ ok: false, reason: 'placement_collision' }));
    expect(actual).toEqual(expected);
  });

  it('given a caller query parameter spelled with + for the space (api+key), should refuse placement_collision — form decoders read + as a space', () => {
    const actual = buildOutboundRequest({ canonical: canonicalOf('https://api.example.com/v1/x?api+key=attacker'), body: new Uint8Array(0), material: { value: KEY, placement: { in: 'query', name: 'api_key' } }, sha256 });
    const expected = { ok: false, reason: 'placement_collision' };
    expect(actual).toEqual(expected);
  });
});
