/**
 * L3·G3 — `interpretTokenResponse`: what the pinned HTTPS client's outcome
 * for a refresh means, before `classifyRefreshFailure` decides what to do
 * about a failure (RFC 6749 §5.1 success is exactly 200; §5.2 error body;
 * RFC 9110 §10.2.3 Retry-After).
 *
 * Pins: only a complete 200 with a JSON object body is a success; a truncated
 * or unparseable 200 is `malformed_response` (the provider may already have
 * rotated the refresh token); an error status carries the body's `error`
 * code and a Retry-After in either form; a transport failure is `timeout` or
 * `network`, never a status.
 */
import { describe, expect, it } from 'vitest';
import { interpretTokenResponse } from '../interpret-token-response';
import type { SendOutcome } from '../../executor/pinned-https-client';

const NOW = Date.UTC(2027, 0, 1, 0, 0, 0);
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const response = (status: number, body: Uint8Array, headers: readonly (readonly [string, string])[] = [], truncated = false): SendOutcome => ({ kind: 'response', status, headers, body, truncated });

describe('interpretTokenResponse', () => {
  it('given a complete 200 with a JSON object, should hand the body on', () => {
    const actual = interpretTokenResponse({ send: response(200, json({ access_token: 'synthetic' })), now: NOW });
    const expected = { ok: true, body: { access_token: 'synthetic' } };
    expect(actual).toEqual(expected);
  });

  it('given a 200 that is truncated, not JSON, or not an object, should report a malformed response', () => {
    const actual = [
      response(200, json({ access_token: 'synthetic' }), [], true),
      response(200, new TextEncoder().encode('<html>ok</html>')),
      response(200, json(['synthetic'])),
      response(200, json(null)),
    ].map((send) => interpretTokenResponse({ send, now: NOW }));
    const expected = Array.from({ length: 4 }, () => ({ ok: false, failure: { kind: 'malformed_response' } }));
    expect(actual).toEqual(expected);
  });

  it('given an OAuth error body, should carry its error code with the status', () => {
    const actual = interpretTokenResponse({ send: response(400, json({ error: 'invalid_grant', error_description: 'Bad Request' })), now: NOW });
    const expected = { ok: false, failure: { kind: 'status', status: 400, oauthError: 'invalid_grant', retryAfterMs: null } };
    expect(actual).toEqual(expected);
  });

  it('given an error body without a string error code, should carry no code', () => {
    const actual = [response(401, new TextEncoder().encode('unauthorized')), response(401, json({ error: 7 }))].map((send) => interpretTokenResponse({ send, now: NOW }));
    const expected = [
      { ok: false, failure: { kind: 'status', status: 401, oauthError: null, retryAfterMs: null } },
      { ok: false, failure: { kind: 'status', status: 401, oauthError: null, retryAfterMs: null } },
    ];
    expect(actual).toEqual(expected);
  });

  it('given Retry-After as delta-seconds or an HTTP date, should convert it to milliseconds from now', () => {
    const actual = [
      interpretTokenResponse({ send: response(429, json({}), [['retry-after', '30']]), now: NOW }),
      interpretTokenResponse({ send: response(503, json({}), [['retry-after', new Date(NOW + 90_000).toUTCString()]]), now: NOW }),
    ];
    const expected = [
      { ok: false, failure: { kind: 'status', status: 429, oauthError: null, retryAfterMs: 30_000 } },
      { ok: false, failure: { kind: 'status', status: 503, oauthError: null, retryAfterMs: 90_000 } },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a Retry-After in the past or unreadable, should carry none', () => {
    const actual = [
      interpretTokenResponse({ send: response(429, json({}), [['retry-after', new Date(NOW - 1_000).toUTCString()]]), now: NOW }),
      interpretTokenResponse({ send: response(429, json({}), [['retry-after', 'soon']]), now: NOW }),
      interpretTokenResponse({ send: response(429, json({}), [['retry-after', '-5']]), now: NOW }),
    ];
    const expected = Array.from({ length: 3 }, () => ({ ok: false, failure: { kind: 'status', status: 429, oauthError: null, retryAfterMs: null } }));
    expect(actual).toEqual(expected);
  });

  it('given another success status, should report it as a status, not a success', () => {
    const actual = interpretTokenResponse({ send: response(201, json({ access_token: 'synthetic' })), now: NOW });
    const expected = { ok: false, failure: { kind: 'status', status: 201, oauthError: null, retryAfterMs: null } };
    expect(actual).toEqual(expected);
  });

  it('given a transport failure or refusal, should report timeout or network', () => {
    const actual = [
      { kind: 'failed', phase: 'after_send', reason: 'timeout' },
      { kind: 'failed', phase: 'before_send', reason: 'tls' },
      { kind: 'failed', phase: 'after_send', reason: 'network' },
      { kind: 'refused', reason: 'non_public_address' },
      { kind: 'refused', reason: 'dns_failed' },
    ].map((send) => interpretTokenResponse({ send: send as SendOutcome, now: NOW }));
    const expected = [
      { ok: false, failure: { kind: 'timeout' } },
      { ok: false, failure: { kind: 'network' } },
      { ok: false, failure: { kind: 'network' } },
      { ok: false, failure: { kind: 'network' } },
      { ok: false, failure: { kind: 'network' } },
    ];
    expect(actual).toEqual(expected);
  });
});
