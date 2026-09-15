/**
 * ADR 0004 §3 + §8.13 — the canonical request projection and its digest.
 *
 * Written RED at G1b before `canonicalize-request.ts`, `digest-request.ts`
 * and `render-approval-subject.ts` existed (Control Board §7.2). The
 * primitives are real (node's WHATWG URL parser, a real SHA-256) but the
 * digest's hash is INJECTED into `digestRequest` — the module under test
 * never reaches for `node:crypto` for the digest.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalizeRequest } from '../canonicalize-request';
import { digestRequest } from '../digest-request';
import { renderApprovalSubject } from '../render-approval-subject';
import type { CanonicalRequest, CanonicalRequestInput, CanonicalizeRefusal } from '../canonical-request';
import type { HashBytes } from '../grant';

const hash: HashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** SHA-256 of zero bytes — what an empty body must hash to (ADR 0004 §3.2). */
const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const BODY = utf8('{"title":"hello"}');

function makeInput(overrides: Partial<CanonicalRequestInput> = {}): CanonicalRequestInput {
  return {
    channel: 'http-executor',
    method: 'post',
    url: 'https://API.GitHub.com/repos/octo/hello/issues?state=open&labels=bug',
    headers: { Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-Trace-Id': 'abc' },
    body: BODY,
    resources: { repo: 'octo/hello', org: 'octo' },
    operation: { class: 'write', name: 'github.issues.create' },
    declaredHeaders: [],
    ...overrides,
  };
}

function canonical(overrides: Partial<CanonicalRequestInput> = {}): CanonicalRequest {
  const result = canonicalizeRequest(makeInput(overrides));
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.canonical;
}

function refusal(overrides: Partial<CanonicalRequestInput>): CanonicalizeRefusal | 'ok' {
  const result = canonicalizeRequest(makeInput(overrides));
  return result.ok ? 'ok' : result.reason;
}

/** Turn a canonical request back into an input, so `canonicalize ∘ canonicalize` can be checked. */
function inputFromCanonical(c: CanonicalRequest, body: Uint8Array): CanonicalRequestInput {
  // The canonical query is already NORMALIZED (still percent-encoded), so a
  // faithful round-trip joins the pairs verbatim. Re-encoding them here would
  // hide a missing normalization in the implementation by doing it in the test.
  const query = c.query.map(([name, value]) => `${name}=${value}`).join('&');
  return {
    channel: c.channel,
    method: c.method,
    url: `${c.origin}${c.path}${query.length > 0 ? `?${query}` : ''}`,
    headers: Object.fromEntries(c.headers),
    body,
    resources: Object.fromEntries(c.resources),
    operation: c.operation,
    declaredHeaders: [],
  };
}

describe('canonicalizeRequest refusals (ADR 0004 F18)', () => {
  it('given a URL with userinfo, should refuse with userinfo_present', () => {
    const actual = refusal({ url: 'https://alice:hunter2@api.github.com/repos' });
    expect(actual).toBe('userinfo_present');
  });

  it('given userinfo that is only a username, should still refuse with userinfo_present', () => {
    const actual = refusal({ url: 'https://alice@api.github.com/repos' });
    expect(actual).toBe('userinfo_present');
  });

  it('given a wildcard host, should refuse with wildcard_host', () => {
    const actual = refusal({ url: 'https://*.github.com/repos' });
    expect(actual).toBe('wildcard_host');
  });

  it.each([
    ['dotted quad', 'https://127.0.0.1/'],
    ['decimal', 'https://2130706433/'],
    ['hex', 'https://0x7f000001/'],
    ['octal', 'https://0177.0.0.1/'],
    ['ipv6', 'https://[::1]/'],
    ['ipv6 mapped', 'https://[::ffff:127.0.0.1]/'],
  ])('given an IP-literal host (%s), should refuse with ip_literal_host', (_label, url) => {
    const actual = refusal({ url });
    expect(actual).toBe('ip_literal_host');
  });

  it('given an http:// URL, should refuse with scheme_not_https', () => {
    const actual = refusal({ url: 'http://api.github.com/repos' });
    expect(actual).toBe('scheme_not_https');
  });

  it.each([
    ['Authorization'],
    ['cookie'],
    ['Host'],
    ['Proxy-Authorization'],
    ['proxy-connection'],
    ['X-Forwarded-For'],
    ['x-forwarded-host'],
    ['X-Forwarded-Proto'],
    ['transfer-encoding'],
    ['Connection'],
    ['Upgrade'],
    ['proxy-anything-else'],
    ['x-forwarded-anything-else'],
  ])('given a caller-supplied %s header, should refuse with reserved_header (never strip)', (name) => {
    const actual = refusal({ headers: { ...makeInput().headers, [name]: 'x' } });
    expect(actual).toBe('reserved_header');
  });

  it.each([
    ['a literal .. segment the parser left', 'https://api.github.com/repos/%2e%2e%2fadmin', 'path_traversal'],
    ['an encoded .. that survives one decode', 'https://api.github.com/repos/%252e%252e/admin', 'ok'],
    ['a double-encoded .. inside a segment', 'https://api.github.com/repos/a%2f..%2fb', 'path_traversal'],
    ['a NUL after one decode', 'https://api.github.com/repos/a%00b', 'path_control_char'],
    ['a control character after one decode', 'https://api.github.com/repos/a%0Ab', 'path_control_char'],
  ])('given %s, should decide %s', (_label, url, expected) => {
    // A `%252e%252e` decodes ONCE to the literal text `%2e%2e` — that is not a
    // dot segment after one decode, so it is admitted and re-encoded; the
    // upstream receives `%252e%252e`, never a traversal.
    const actual = refusal({ url });
    expect(actual).toBe(expected);
  });

  it.each([
    ['http-executor', 'TRACE'],
    ['http-executor', 'git-upload-pack'],
    ['relay-runner', 'GET'],
    ['relay-runner', 'GIT-UPLOAD-PACK'],
    ['browser-worker', 'POST'],
    ['browser-worker', 'eval'],
  ] as const)('given channel %s with method %s outside the closed set, should refuse with method_not_allowed', (channel, method) => {
    const actual = refusal({ channel, method });
    expect(actual).toBe('method_not_allowed');
  });

  it('given a channel outside the executor set, should refuse with malformed', () => {
    const actual = refusal({ channel: 'refresh-worker' as unknown as CanonicalRequestInput['channel'] });
    expect(actual).toBe('malformed');
  });

  it('given a URL that does not parse, should refuse with malformed', () => {
    const actual = refusal({ url: 'https://' });
    expect(actual).toBe('malformed');
  });

  it('given a host with characters outside the LDH set, should refuse with host_not_idna', () => {
    const actual = refusal({ url: 'https://api_internal.example.com/' });
    expect(actual).toBe('host_not_idna');
  });

  it('given a caller content-length that disagrees with the body bytes, should refuse with malformed', () => {
    const actual = refusal({ headers: { 'content-length': String(BODY.byteLength + 1) } });
    expect(actual).toBe('malformed');
  });

  it.each([
    ['a newline and a fabricated second line', 'a public page\nGET https://api.github.com/user (read)'],
    ['spaces', 'read a public page'],
    ['an em dash that mimics the headline separator', 'x — https://api.github.com'],
    ['a parenthesis that mimics the class suffix', 'x (read)'],
  ])('given an operation name containing %s, should refuse with malformed (the headline is a function of validated fields only)', (_label, name) => {
    const actual = refusal({ operation: { class: 'read', name } });
    expect(actual).toBe('malformed');
  });

  it('given a catalogue-shaped operation name, should admit it', () => {
    const actual = canonical({ operation: { class: 'read', name: 'github.issues.list_v2-beta' } }).operation.name;
    expect(actual).toBe('github.issues.list_v2-beta');
  });

  it('given an operation class outside the union, should refuse with malformed', () => {
    const actual = refusal({ operation: { class: 'admin' as unknown as 'read', name: 'x' } });
    expect(actual).toBe('malformed');
  });
});

describe('canonicalizeRequest normalization', () => {
  it('given a mixed-case IDNA host, should lowercase and IDNA→ASCII it', () => {
    const actual = canonical({ url: 'https://BÜCHER.Example.com/x' }).origin;
    expect(actual).toBe('https://xn--bcher-kva.example.com:443');
  });

  it('given an https URL without a port, should write :443 explicitly', () => {
    const actual = canonical({ url: 'https://api.github.com/x' }).origin;
    expect(actual).toBe('https://api.github.com:443');
  });

  it('given an explicit non-default port, should keep it', () => {
    const actual = canonical({ url: 'https://api.github.com:8443/x' }).origin;
    expect(actual).toBe('https://api.github.com:8443');
  });

  it('given a host with a trailing dot, should normalize to the same origin as without it', () => {
    const actual = canonical({ url: 'https://api.github.com./x' }).origin;
    const expected = canonical({ url: 'https://api.github.com/x' }).origin;
    expect(actual).toBe(expected);
  });

  it('given query and header maps in any order, should emit sorted pairs', () => {
    const actual = canonical({
      url: 'https://api.github.com/x?zeta=1&alpha=2&Beta=3',
      headers: { 'content-type': 'application/json', accept: 'text/plain' },
    });
    expect(actual.query).toEqual([
      ['Beta', '3'],
      ['alpha', '2'],
      ['zeta', '1'],
    ]);
    expect(actual.headers).toEqual([
      ['accept', 'text/plain'],
      ['content-length', String(BODY.byteLength)],
      ['content-type', 'application/json'],
    ]);
  });

  it('given duplicate query names, should keep them in input order after the sort', () => {
    const actual = canonical({ url: 'https://api.github.com/x?k=second&a=0&k=first' }).query;
    expect(actual).toEqual([
      ['a', '0'],
      ['k', 'second'],
      ['k', 'first'],
    ]);
  });

  it.each([
    ['a plus against its percent-encoding', 'https://api.github.com/x?to=a+b', 'https://api.github.com/x?to=a%2Bb'],
    ['a slash against its percent-encoding', 'https://api.github.com/x?path=/safe', 'https://api.github.com/x?path=%2Fsafe'],
    ['an ampersand against its percent-encoding', 'https://api.github.com/x?a=1%26b=2', 'https://api.github.com/x?a=1&b=2'],
  ])('given two wire requests differing by %s, should produce DIFFERENT digests (the approved bytes are the executed bytes)', (_label, first, second) => {
    const a = digestRequest({ canonical: canonical({ url: first }), hash });
    const b = digestRequest({ canonical: canonical({ url: second }), hash });
    expect(a).not.toBe(b);
  });

  it('given a query component, should normalize percent-encoding without decoding it (uppercase hex, unreserved decoded, everything else kept encoded)', () => {
    const actual = canonical({ url: 'https://api.github.com/x?q=a%2bb&r=%7euser&s=%41' }).query;
    expect(actual).toEqual([
      ['q', 'a%2Bb'],
      ['r', '~user'],
      ['s', 'A'],
    ]);
  });

  it('given a query value containing a percent-encoded control character, should refuse (as the path does)', () => {
    const actual = [refusal({ url: 'https://api.github.com/x?a=%00' }), refusal({ url: 'https://api.github.com/x?a=%0A' })];
    expect(actual).toEqual(['path_control_char', 'path_control_char']);
  });

  it('given a bare flag and the same flag with an empty value, should canonicalize alike — a stated equivalence, since the frozen pair shape cannot hold the difference', () => {
    const bare = canonical({ url: 'https://api.github.com/x?force' }).query;
    const empty = canonical({ url: 'https://api.github.com/x?force=' }).query;
    expect({ bare, empty }).toEqual({ bare: [['force', '']], empty: [['force', '']] });
  });

  it.each([
    ['a CRLF pair smuggling a reserved header', 'application/json\r\nauthorization: Bearer ATTACKER'],
    ['a bare newline', 'application/json\nx: y'],
    ['a NUL', 'application/json\u0000'],
  ])('given an admitted header whose VALUE carries %s, should refuse (a name-only check does not stop header injection)', (_label, value) => {
    const actual = refusal({ headers: { accept: value } });
    expect(actual).toBe('malformed');
  });

  it('given only projected + declared headers, should drop every other header from the projection', () => {
    const actual = canonical({
      headers: { Accept: 'a', 'X-Trace-Id': 't', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ua' },
      declaredHeaders: ['x-github-api-version'],
    }).headers;
    expect(actual).toEqual([
      ['accept', 'a'],
      ['content-length', String(BODY.byteLength)],
      ['x-github-api-version', '2022-11-28'],
    ]);
  });

  it('given an empty body, should record the SHA-256 of zero bytes, never null', () => {
    const actual = canonical({ body: new Uint8Array(0), headers: {} });
    expect(actual.bodySha256).toBe(SHA256_EMPTY);
  });

  it('given an empty body, should project content-length 0 whether or not the caller supplied it (one request, one digest)', () => {
    const supplied = canonical({ body: new Uint8Array(0), headers: { 'Content-Length': '0' } });
    const omitted = canonical({ body: new Uint8Array(0), headers: {} });
    expect({ supplied: supplied.headers, omitted: omitted.headers }).toEqual({
      supplied: [['content-length', '0']],
      omitted: [['content-length', '0']],
    });
    expect(digestRequest({ canonical: supplied, hash })).toBe(digestRequest({ canonical: omitted, hash }));
  });

  it('given a non-empty body, should project content-length from the bytes themselves', () => {
    const actual = canonical({ headers: {} }).headers;
    expect(actual).toEqual([['content-length', String(BODY.byteLength)]]);
  });

  it('given a caller-supplied content-length that agrees with the body, should digest identically to one that omitted it', () => {
    const supplied = canonical({ headers: { 'content-length': String(BODY.byteLength) } });
    const omitted = canonical({ headers: {} });
    expect(digestRequest({ canonical: supplied, hash })).toBe(digestRequest({ canonical: omitted, hash }));
  });

  it('given the http method in lower case, should upper-case it', () => {
    const actual = canonical({ method: 'get', body: new Uint8Array(0) }).method;
    expect(actual).toBe('GET');
  });

  it('given a path with dot segments and un-normalized encoding, should resolve and re-encode canonically', () => {
    const actual = canonical({ url: 'https://api.github.com/a/./b/../c/%7Euser/sp%20ace/%41' }).path;
    expect(actual).toBe('/a/c/~user/sp%20ace/A');
  });

  it('given an encoded slash inside a segment, should keep it encoded (never a new segment)', () => {
    const actual = canonical({ url: 'https://api.github.com/repos/octo%2Fhello' }).path;
    expect(actual).toBe('/repos/octo%2Fhello');
  });

  it('given resources in any key order, should emit sorted pairs', () => {
    const actual = canonical({ resources: { repo: 'octo/hello', branch: 'main', org: 'octo' } }).resources;
    expect(actual).toEqual([
      ['branch', 'main'],
      ['org', 'octo'],
      ['repo', 'octo/hello'],
    ]);
  });

  it('given a valid input, should emit the fixed field set in the fixed order', () => {
    const actual = Object.keys(canonical());
    expect(actual).toEqual(['channel', 'method', 'origin', 'path', 'query', 'headers', 'bodySha256', 'resources', 'operation']);
  });

  it('given a valid input, should round-trip: canonicalize ∘ canonicalize is the identity [0004 §8.13]', () => {
    const once = canonical({ url: 'https://API.GitHub.com/repos/octo/hello/../world/issues?zeta=%20&alpha=a%2Bb&alpha=x' });
    const twiceResult = canonicalizeRequest(inputFromCanonical(once, BODY));
    const actual = twiceResult.ok ? twiceResult.canonical : twiceResult;
    expect(actual).toEqual(once);
  });

  it.each(['https://localhost/x', 'https://internal.corp/x', 'https://metadata.google.internal/x'])(
    'given a name that RESOLVES privately (%s), should admit it here — canonicalization is not the SSRF boundary, the connect-time address check is (G2)',
    (url) => {
      const actual = canonicalizeRequest(makeInput({ url, body: new Uint8Array(0), headers: {} }));
      expect(actual.ok).toBe(true);
    },
  );

  it('given a relay method, should accept the closed relay set as-is', () => {
    const actual = canonical({ channel: 'relay-runner', method: 'git-receive-pack', body: new Uint8Array(0), headers: {} }).method;
    expect(actual).toBe('git-receive-pack');
  });

  it('given a browser method, should accept the closed browser set as-is', () => {
    const actual = canonical({ channel: 'browser-worker', method: 'navigate', body: new Uint8Array(0), headers: {} }).method;
    expect(actual).toBe('navigate');
  });
});

describe('digestRequest', () => {
  it('given two inputs differing only by header order, key order, host case or :443, should produce the same digest', () => {
    const a = canonical({
      url: 'https://api.github.com:443/repos/octo/hello/issues?state=open&labels=bug',
      headers: { 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' },
      resources: { org: 'octo', repo: 'octo/hello' },
    });
    const b = canonical();
    const actual = digestRequest({ canonical: a, hash });
    const expected = digestRequest({ canonical: b, hash });
    expect(actual).toBe(expected);
  });

  it('given two inputs differing in one body byte, should produce different digests', () => {
    const altered = new Uint8Array(BODY);
    altered[altered.length - 2] = altered[altered.length - 2]! ^ 0x01;
    const actual = digestRequest({ canonical: canonical({ body: altered }), hash });
    const expected = digestRequest({ canonical: canonical(), hash });
    expect(actual).not.toBe(expected);
  });

  it('given the same canonical request and operation {class,name} differing, should produce different digests (op discriminator)', () => {
    const base = digestRequest({ canonical: canonical(), hash });
    const otherName = digestRequest({ canonical: canonical({ operation: { class: 'write', name: 'github.issues.update' } }), hash });
    const otherClass = digestRequest({ canonical: canonical({ operation: { class: 'read', name: 'github.issues.create' } }), hash });
    expect(otherName).not.toBe(base);
    expect(otherClass).not.toBe(base);
  });

  it('given a canonical request with keys inserted in another order, should produce the same digest (rebuilt from the typed value)', () => {
    const c = canonical();
    const shuffled = {
      operation: c.operation,
      resources: c.resources,
      bodySha256: c.bodySha256,
      headers: c.headers,
      query: c.query,
      path: c.path,
      origin: c.origin,
      method: c.method,
      channel: c.channel,
    } as CanonicalRequest;
    const actual = digestRequest({ canonical: shuffled, hash });
    const expected = digestRequest({ canonical: c, hash });
    expect(actual).toBe(expected);
  });

  it('given a canonical request, should hash the injected primitive over canonical JSON bytes (sorted keys, positional arrays)', () => {
    const c = canonical({ body: new Uint8Array(0), headers: {}, url: 'https://a.example/p?b=1&a=2', resources: { r: '1' } });
    const seen: string[] = [];
    const spy: HashBytes = (bytes) => {
      seen.push(new TextDecoder().decode(bytes));
      return 'digest';
    };
    const actual = digestRequest({ canonical: c, hash: spy });
    expect(actual).toBe('digest');
    expect(seen).toEqual([
      `{"bodySha256":"${SHA256_EMPTY}","channel":"http-executor","headers":[["content-length","0"]],"method":"POST","operation":{"class":"write","name":"github.issues.create"},"origin":"https://a.example:443","path":"/p","query":[["a","2"],["b","1"]],"resources":[["r","1"]]}`,
    ]);
  });
});

describe('renderApprovalSubject (ASI06)', () => {
  it('given a canonical request, should render the subject from it alone — no field sourced from model text, page body or summary', () => {
    const c = canonical();
    const actual = renderApprovalSubject({ canonical: c });
    expect(actual).toEqual({
      headline: 'POST https://api.github.com:443/repos/octo/hello/issues — github.issues.create (write)',
      origin: 'https://api.github.com:443',
      operation: { class: 'write', name: 'github.issues.create' },
      resources: [
        ['org', 'octo'],
        ['repo', 'octo/hello'],
      ],
      bodySha256: c.bodySha256,
      bodyBytes: BODY.byteLength,
    });
  });

  it('given a canonical request with no body, should report zero body bytes', () => {
    const actual = renderApprovalSubject({ canonical: canonical({ body: new Uint8Array(0), headers: {} }) }).bodyBytes;
    expect(actual).toBe(0);
  });

  it('given a subject, should carry only fields derivable from the canonical request (no free text slot)', () => {
    const actual = Object.keys(renderApprovalSubject({ canonical: canonical() })).sort();
    expect(actual).toEqual(['bodyBytes', 'bodySha256', 'headline', 'operation', 'origin', 'resources']);
  });
});
