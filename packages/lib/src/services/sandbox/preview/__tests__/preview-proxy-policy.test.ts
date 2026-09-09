import { describe, it, expect } from 'vitest';
import { assert } from '../../__tests__/riteway';
import {
  assertTrustedPreviewUpstream,
  isRoutableSpriteUrl,
  isRoutableSpriteUrlString,
  buildPreviewUpstreamUrl,
  buildPreviewAccessLog,
  buildPreviewResponseHeaders,
  extractPreviewPath,
  rewriteUpstreamLocation,
  selectForwardableRequestHeaders,
  selectForwardableResponseHeaders,
} from '../preview-proxy-policy';

const SPRITE = 'https://ps-abc-org.sprites.app';

describe('the upstream is never derivable from client input', () => {
  it('accepts a real sprite URL', () => {
    expect(() => assertTrustedPreviewUpstream(new URL(SPRITE))).not.toThrow();
  });

  it.each([
    'http://ps-abc-org.sprites.app',
    'https://sprites.app',
    'https://evil.example.com',
    'https://sprites.app.evil.example.com',
    'https://169.254.169.254',
  ])('refuses %s as an upstream', (url) => {
    expect(() => assertTrustedPreviewUpstream(new URL(url))).toThrow(/refusing to forward/);
  });

  it('builds the upstream from the sprite origin and the raw path+query, preserving encoding', () => {
    assert({
      given: 'a vite-style encoded path with a query',
      should: 'keep the sprite origin and the suffix byte-for-byte',
      actual: buildPreviewUpstreamUrl(SPRITE, '/@fs/%2Fsrc/main.tsx?import&t=1').toString(),
      expected: `${SPRITE}/@fs/%2Fsrc/main.tsx?import&t=1`,
    });
  });

  it('cannot be re-homed by a protocol-relative path — the leading slashes are collapsed and the host stays the sprite', () => {
    assert({ given: '//evil.example.com/x', should: 'stay on the sprite origin', actual: buildPreviewUpstreamUrl(SPRITE, '//evil.example.com/x').origin, expected: SPRITE });
    assert({ given: '/@vite/client?token=a%2Fb#frag', should: 'carry path and query, drop the fragment', actual: buildPreviewUpstreamUrl(SPRITE, '/@vite/client?token=a%2Fb#frag').toString(), expected: `${SPRITE}/@vite/client?token=a%2Fb` });
    expect(() => buildPreviewUpstreamUrl(SPRITE, '/a\r\nHost: evil')).toThrow(/control character/);
  });

  it('resolves dot segments against the fixed origin rather than escaping it', () => {
    assert({
      given: '/a/../../b',
      should: 'stay on the sprite origin',
      actual: buildPreviewUpstreamUrl(SPRITE, '/a/../../b').toString(),
      expected: `${SPRITE}/b`,
    });
  });

  it('extracts the path below a mount, and nothing outside it', () => {
    assert({ given: 'the mount itself', should: 'be /', actual: extractPreviewPath('/m/x', '/m/x'), expected: '/' });
    assert({ given: 'a child', should: 'be the suffix', actual: extractPreviewPath('/m/x/a/b', '/m/x'), expected: '/a/b' });
    assert({ given: 'a sibling that merely shares a prefix', should: 'be null', actual: extractPreviewPath('/m/xy', '/m/x'), expected: null });
  });
});

describe('header policy', () => {
  it('forwards only allowlisted request headers — never cookie, authorization, origin, referer, host, accept-encoding', () => {
    assert({
      given: 'a browser request with credentials and hop-by-hop headers',
      should: 'keep the content-negotiation set and drop the rest',
      actual: selectForwardableRequestHeaders({
        Cookie: '__Host-ps_preview=abc',
        Authorization: 'Bearer client',
        Origin: 'https://app.pagespace.ai',
        Referer: 'https://app.pagespace.ai/x',
        Host: 'env-1.preview.example',
        'Accept-Encoding': 'gzip, br',
        Accept: 'text/html',
        'Content-Type': 'application/json',
        'If-None-Match': '"abc"',
        'User-Agent': 'UA',
        Connection: 'keep-alive',
        'Sec-WebSocket-Key': 'k',
      }),
      expected: { accept: 'text/html', 'content-type': 'application/json', 'if-none-match': '"abc"', 'user-agent': 'UA' },
    });
  });

  it('adds the websocket handshake headers only for an upgrade', () => {
    assert({
      given: 'an upgrade request',
      should: 'forward the sec-websocket-* set',
      actual: selectForwardableRequestHeaders({ 'sec-websocket-key': 'k', 'sec-websocket-version': '13', cookie: 'x' }, { upgrade: true }),
      expected: { 'sec-websocket-key': 'k', 'sec-websocket-version': '13' },
    });
  });

  it('drops set-cookie, framing/HSTS/report-only, encoding/length and platform topology from responses; keeps the rest', () => {
    assert({
      given: 'a dev-server response with everything',
      should: 'relay content headers and upstream CSP, drop the dangerous ones',
      actual: selectForwardableResponseHeaders({
        'Set-Cookie': 'a=b',
        'X-Frame-Options': 'DENY',
        'Strict-Transport-Security': 'max-age=1',
        'Content-Security-Policy-Report-Only': 'x',
        'Content-Security-Policy': "default-src 'self'",
        'Content-Encoding': 'gzip',
        'Content-Length': '12',
        'Transfer-Encoding': 'chunked',
        Server: 'sprites',
        Via: '1.1 fly',
        'Content-Type': 'text/html',
        ETag: '"x"',
        Location: '/next',
      }),
      expected: { 'content-security-policy': "default-src 'self'", 'content-type': 'text/html', etag: '"x"', location: '/next' },
    });
  });

  it('frames the preview under the app origin only, and under nothing when the app origin is unknown', () => {
    assert({
      given: 'a known app origin',
      should: 'emit frame-ancestors for it',
      actual: buildPreviewResponseHeaders('https://app.pagespace.ai')[0],
      expected: ['content-security-policy', 'frame-ancestors https://app.pagespace.ai'],
    });
    assert({
      given: 'no app origin',
      should: "fail closed to 'none'",
      actual: buildPreviewResponseHeaders(null)[0],
      expected: ['content-security-policy', "frame-ancestors 'none'"],
    });
    assert({
      given: 'any origin',
      should: 'never cache and never send a referrer',
      actual: buildPreviewResponseHeaders('https://a').slice(1),
      expected: [['cache-control', 'no-store'], ['referrer-policy', 'no-referrer'], ['x-content-type-options', 'nosniff'], ['cross-origin-resource-policy', 'same-origin']],
    });
  });

  it('rewrites a redirect to the sprite origin as origin-relative and leaves foreign redirects alone', () => {
    assert({ given: 'absolute sprite location', should: 'become relative', actual: rewriteUpstreamLocation(`${SPRITE}/login?next=%2F#x`, SPRITE), expected: '/login?next=%2F#x' });
    assert({ given: 'relative location', should: 'stay relative', actual: rewriteUpstreamLocation('/login', SPRITE), expected: '/login' });
    assert({ given: 'foreign location', should: 'pass through', actual: rewriteUpstreamLocation('https://example.com/x', SPRITE), expected: 'https://example.com/x' });
    assert({ given: 'an unparsable location', should: 'pass through unchanged', actual: rewriteUpstreamLocation('http://[', SPRITE), expected: 'http://[' });
  });
});

describe('attributable access log', () => {
  it('records who, which holder, how, and the outcome — with a bounded path and no body', () => {
    const record = buildPreviewAccessLog({
      userId: 'u1',
      holder: { kind: 'env', id: 'e1' },
      method: 'GET',
      path: `/${'x'.repeat(500)}`,
      outcome: 'forwarded',
      status: 200,
      wake: true,
      bytesOut: 10,
      durationMs: 5,
      transport: 'http',
    });
    assert({
      given: 'a forwarded request with a huge path',
      should: 'carry attribution and bound the path',
      actual: { ...record, path: (record.path as string).length },
      expected: { userId: 'u1', holderKind: 'env', holderId: 'e1', transport: 'http', method: 'GET', path: 201, outcome: 'forwarded', status: 200, wake: true, bytesOut: 10, durationMs: 5 },
    });
  });

  it('omits fields it was not given rather than writing undefined', () => {
    assert({
      given: 'a refusal',
      should: 'carry only the reason',
      actual: buildPreviewAccessLog({ userId: 'u', holder: { kind: 'workspace', id: 'w' }, method: 'GET', path: '/', outcome: 'refused', reason: 'stale-instance', transport: 'websocket' }),
      expected: { userId: 'u', holderKind: 'workspace', holderId: 'w', transport: 'websocket', method: 'GET', path: '/', outcome: 'refused', reason: 'stale-instance' },
    });
  });
});

describe('a sprite URL must be a hostname DNS can answer', () => {
  const LONG = `https://pgs-env-${'a'.repeat(55)}-bskrl.sprites.app`; // 69-char first label — what production had
  const OK = `https://pgs-env-${'a'.repeat(40)}-bskrl.sprites.app`;   // 54

  it('refuses a first label longer than 63 chars, in the assertion and in the pure check', () => {
    expect(new URL(LONG).hostname.split('.')[0]).toHaveLength(69);
    expect(isRoutableSpriteUrl(new URL(LONG))).toBe(false);
    expect(() => assertTrustedPreviewUpstream(new URL(LONG))).toThrow(/label longer/);
    expect(isRoutableSpriteUrl(new URL(OK))).toBe(true);
    expect(() => assertTrustedPreviewUpstream(new URL(OK))).not.toThrow();
  });

  it('the string form has nothing to say about null or garbage — only a parsable URL can be unroutable', () => {
    expect(isRoutableSpriteUrlString(null)).toBe(true);
    expect(isRoutableSpriteUrlString('not a url')).toBe(true);
    expect(isRoutableSpriteUrlString(LONG)).toBe(false);
    expect(isRoutableSpriteUrlString(OK)).toBe(true);
  });
});
