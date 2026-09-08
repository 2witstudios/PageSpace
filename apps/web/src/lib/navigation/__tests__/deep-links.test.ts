import { describe, it, expect } from 'vitest';
import { resolveDeepLink } from '../deep-links';

describe('resolveDeepLink', () => {
  it('routes a claimed invite link to the in-app invite route', () => {
    expect(resolveDeepLink('https://pagespace.ai/invite/abc123')).toEqual({
      kind: 'route',
      path: '/invite/abc123',
    });
  });

  it('tolerates a trailing slash', () => {
    expect(resolveDeepLink('https://pagespace.ai/invite/abc123/')).toEqual({
      kind: 'route',
      path: '/invite/abc123',
    });
  });

  it('ignores query and hash, which the invite route does not read', () => {
    expect(resolveDeepLink('https://pagespace.ai/invite/abc123?utm=x#frag')).toEqual({
      kind: 'route',
      path: '/invite/abc123',
    });
  });

  it('re-encodes a token so it survives being put back into a path', () => {
    expect(resolveDeepLink('https://pagespace.ai/invite/a%20b')).toEqual({
      kind: 'route',
      path: '/invite/a%20b',
    });
  });

  it('does not treat a multi-segment path as an invite token', () => {
    // Invite params are a single opaque segment; anything deeper is not ours.
    expect(resolveDeepLink('https://pagespace.ai/invite/a/b')).toEqual({
      kind: 'external',
      url: 'https://pagespace.ai/invite/a/b',
    });
  });

  it('hands an unrouted path on the claimed host back to the browser', () => {
    // A link the app cannot complete must still complete somewhere, or claiming
    // the path would turn a working Safari link into a dead one.
    expect(resolveDeepLink('https://pagespace.ai/pricing')).toEqual({
      kind: 'external',
      url: 'https://pagespace.ai/pricing',
    });
  });

  it.each([
    ['a different host', 'https://evil.example/invite/abc123'],
    ['a suffix lookalike host', 'https://pagespace.ai.evil.example/invite/abc123'],
    // Guards exact-match specifically: this is the host an `endsWith`
    // check would wave through, and the suffix case above would not catch
    // that regression.
    ['a prefix lookalike host', 'https://evilpagespace.ai/invite/abc123'],
    ['a subdomain the entitlement does not claim', 'https://app.pagespace.ai/invite/abc123'],
    ['plain http', 'http://pagespace.ai/invite/abc123'],
    ['a relative path', '/invite/abc123'],
    ['unparseable input', 'not a url'],
  ])('returns null for %s', (_label, url) => {
    expect(resolveDeepLink(url)).toBeNull();
  });

  it('does not throw on a malformed escape sequence', () => {
    // `decodeURIComponent('%')` raises URIError. This runs during listener
    // setup, so a throw here would abort it and leave the app with no
    // warm-start listener for the rest of the session.
    expect(() => resolveDeepLink('https://pagespace.ai/invite/%')).not.toThrow();
    expect(resolveDeepLink('https://pagespace.ai/invite/%')).toEqual({
      kind: 'external',
      url: 'https://pagespace.ai/invite/%',
    });
  });

  it('ignores the auth-exchange custom scheme', () => {
    // /api/auth/desktop/exchange redeems its code with no PKCE binding, so
    // whichever app receives the code can take a session. Routing it from here
    // would extend that surface before the binding exists.
    expect(resolveDeepLink('pagespace://auth-exchange?code=stolen')).toBeNull();
  });
});
