/**
 * L2·G2 — `normalizeOrigin`: the ONE origin rule (ADR 0004 §3.2), shared by
 * account creation (what a human pins) and `canonicalizeRequest` (what a
 * request targets), so the two can never disagree about what "the same origin"
 * means. https only; host lowercased, trailing dot dropped; the port ALWAYS
 * written; userinfo, wildcards and IP literals refused. An origin is only an
 * origin: a path other than `/`, a query or a fragment is refused rather than
 * silently dropped.
 */
import { describe, expect, it } from 'vitest';
import { normalizeOrigin } from '../normalize-origin';

describe('normalizeOrigin', () => {
  it('given equivalent spellings of one origin, should produce one canonical origin with an explicit port', () => {
    const actual = ['https://API.Example.com', 'https://api.example.com/', 'https://api.example.com:443', 'https://api.example.com.'].map((raw) => normalizeOrigin({ raw }));
    const expected = Array.from({ length: 4 }, () => ({ ok: true, origin: 'https://api.example.com:443' }));
    expect(actual).toEqual(expected);
  });

  it('given the same host on another port, should be a different origin', () => {
    const actual = normalizeOrigin({ raw: 'https://api.example.com:8443' });
    const expected = { ok: true, origin: 'https://api.example.com:8443' };
    expect(actual).toEqual(expected);
  });

  it('given http, userinfo, a wildcard, an IP literal or an unparseable value, should refuse with the rule it broke', () => {
    const actual = ['http://api.example.com', 'https://user:pw@api.example.com', 'https://*.example.com', 'https://10.0.0.1', 'https://[::1]', 'not a url'].map((raw) => normalizeOrigin({ raw }));
    const expected = [
      { ok: false, reason: 'scheme_not_https' },
      { ok: false, reason: 'userinfo_present' },
      { ok: false, reason: 'wildcard_host' },
      { ok: false, reason: 'ip_literal_host' },
      { ok: false, reason: 'ip_literal_host' },
      { ok: false, reason: 'malformed' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a value carrying a path, query or fragment, should refuse not_an_origin rather than drop them', () => {
    const actual = ['https://api.example.com/v1', 'https://api.example.com/?x=1', 'https://api.example.com/#f'].map((raw) => normalizeOrigin({ raw }));
    const expected = Array.from({ length: 3 }, () => ({ ok: false, reason: 'not_an_origin' }));
    expect(actual).toEqual(expected);
  });

  it('given a lookalike Unicode host, should canonicalize to its punycode form — never to the ASCII name it imitates', () => {
    const actual = [normalizeOrigin({ raw: 'https://\u0430pple.com' }), normalizeOrigin({ raw: 'https://xn--pple-43d.com' })];
    const expected = [
      { ok: true, origin: 'https://xn--pple-43d.com:443' },
      { ok: true, origin: 'https://xn--pple-43d.com:443' },
    ];
    expect(actual).toEqual(expected);
  });
});
