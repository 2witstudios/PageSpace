/**
 * L2·G2 — `filterResponse`: the view of an upstream response that may be
 * released toward the model. Requirement: "Given an api_key account pinned to
 * origin O, should call O with auth attached and return a response whose
 * headers/body contain no token-shaped or cookie values."
 *
 * Headers are an ALLOWLIST (set-cookie, auth challenges and anything unknown
 * never pass). The key itself is scrubbed in every encoding a site plausibly
 * echoes it in; token-shaped values (bearer tokens, JWTs, provider-prefixed
 * keys, `token`/`secret`/`password`-named fields) are scrubbed too. This is a
 * TRIPWIRE, not the boundary — an authorized site can always echo or mint a
 * credential (Λ10); the boundary is that the model never receives the key
 * from us.
 */
import { describe, expect, it } from 'vitest';
import { filterResponse } from '../filter-response';

const KEY = 'sk_live_4f9a2c7e1b3d5f7a9c1e';
const enc = (text: string) => new TextEncoder().encode(text);
const LIMIT = 64 * 1024;

function release(input: { readonly status?: number; readonly headers?: readonly (readonly [string, string])[]; readonly body: string | Uint8Array }) {
  return filterResponse({
    status: input.status ?? 200,
    headers: input.headers ?? [['content-type', 'application/json']],
    body: typeof input.body === 'string' ? enc(input.body) : input.body,
    knownValues: [KEY],
    maxBodyBytes: LIMIT,
  });
}

describe('filterResponse', () => {
  it('given an ordinary JSON response, should release the status, the allowlisted headers and the body unchanged', () => {
    const actual = release({ headers: [['Content-Type', 'application/json'], ['ETag', '"v1"'], ['X-RateLimit-Remaining', '41'], ['Server', 'nginx']], body: '{"temp":7,"id":"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"}' });
    const expected = {
      status: 200,
      headers: [
        ['content-type', 'application/json'],
        ['etag', '"v1"'],
        ['x-ratelimit-remaining', '41'],
      ],
      body: '{"temp":7,"id":"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"}',
      bodyOmitted: null,
      truncated: false,
      redacted: false,
    };
    expect(actual).toEqual(expected);
  });

  it('given set-cookie, auth challenges and unknown headers, should release none of them', () => {
    const verdict = release({ headers: [['content-type', 'text/plain'], ['Set-Cookie', 'sid=abc123; HttpOnly'], ['WWW-Authenticate', 'Bearer realm="x"'], ['X-Api-Key', KEY], ['Authorization', `Bearer ${KEY}`]], body: 'ok' });
    const actual = verdict.headers;
    const expected = [['content-type', 'text/plain']];
    expect(actual).toEqual(expected);
  });

  it('given a body that echoes the key raw, URL-encoded, base64, base64url or JSON-escaped, should scrub every copy', () => {
    const b64 = Buffer.from(KEY).toString('base64');
    const b64url = Buffer.from(KEY).toString('base64url');
    const body = `raw=${KEY} url=${encodeURIComponent(KEY)} b64=${b64} b64url=${b64url}`;
    const verdict = release({ headers: [['content-type', 'text/plain']], body });
    const actual = { leaked: [KEY, b64, b64url].some((value) => (verdict.body ?? '').includes(value)), redacted: verdict.redacted };
    const expected = { leaked: false, redacted: true };
    expect(actual).toEqual(expected);
  });

  it('given token-shaped values the site minted or reflected, should scrub bearer tokens, JWTs, prefixed keys and token-named fields', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl';
    const body = JSON.stringify({ note: `Authorization: Bearer abcdefgh12345678`, jwt, gh: 'ghp_0123456789abcdefghijABCDEFGHIJ012345', slack: 'xoxb-1234-5678-abcdefgh', access_token: 'opaque-value-123', password: 'hunter2hunter2', temp: 7 });
    const verdict = release({ body });
    const text = verdict.body ?? '';
    const actual = {
      leaked: ['abcdefgh12345678', jwt, 'ghp_0123456789abcdefghijABCDEFGHIJ012345', 'xoxb-1234-5678-abcdefgh', 'opaque-value-123', 'hunter2hunter2'].filter((value) => text.includes(value)),
      keptTemp: text.includes('"temp":7'),
    };
    const expected = { leaked: [], keptTemp: true };
    expect(actual).toEqual(expected);
  });

  it('given a Location header, should release only its origin and path — never a query that may carry a code or token', () => {
    const verdict = release({ status: 302, headers: [['location', `https://login.example.com/cb?code=${KEY}&state=s#frag`]], body: '' });
    const actual = { headers: verdict.headers, bodyOmitted: verdict.bodyOmitted };
    const expected = { headers: [['location', 'https://login.example.com/cb']], bodyOmitted: 'empty' };
    expect(actual).toEqual(expected);
  });

  it('given a binary body, should omit it rather than release bytes the redaction cannot read', () => {
    const verdict = release({ headers: [['content-type', 'application/octet-stream']], body: new Uint8Array([0, 1, 2, 255]) });
    const actual = { body: verdict.body, bodyOmitted: verdict.bodyOmitted };
    const expected = { body: null, bodyOmitted: 'binary' };
    expect(actual).toEqual(expected);
  });

  it('given a body over the release limit with the key straddling the cut, should truncate after scrubbing so no prefix of the key survives', () => {
    const body = 'a'.repeat(LIMIT - 10) + KEY + 'b'.repeat(100);
    const verdict = release({ headers: [['content-type', 'text/plain']], body });
    const actual = { truncated: verdict.truncated, prefixLeaked: (verdict.body ?? '').includes(KEY.slice(0, 8)), withinLimit: new TextEncoder().encode(verdict.body ?? '').byteLength <= LIMIT };
    const expected = { truncated: true, prefixLeaked: false, withinLimit: true };
    expect(actual).toEqual(expected);
  });

  it('given a released header value that echoes the key, should scrub it', () => {
    const verdict = release({ headers: [['content-type', 'text/plain'], ['link', `<https://api.example.com/x?page=2&key=${KEY}>; rel="next"`]], body: 'ok' });
    const actual = JSON.stringify(verdict.headers).includes(KEY);
    const expected = false;
    expect(actual).toEqual(expected);
  });

  it('given a text body in a charset other than UTF-8, should omit it — the scrub reads UTF-8 and a UTF-16 echo of the key would pass through', () => {
    const utf16 = new Uint8Array(Buffer.from(`key=${KEY}`, 'utf16le'));
    const verdict = release({ headers: [['content-type', 'text/plain; charset=utf-16le']], body: utf16 });
    const actual = { body: verdict.body, bodyOmitted: verdict.bodyOmitted };
    const expected = { body: null, bodyOmitted: 'binary' };
    expect(actual).toEqual(expected);
  });

  it('given an explicit UTF-8 charset, should release the text as usual', () => {
    const verdict = release({ headers: [['content-type', 'application/json; charset=UTF-8']], body: '{"a":1}' });
    const actual = verdict.body;
    const expected = '{"a":1}';
    expect(actual).toEqual(expected);
  });
});

