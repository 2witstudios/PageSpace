/**
 * Redirect URI rules for third-party clients (ADR 0004 Decision 3; epic
 * `yv08hib74nrtmksdzxmf5nkw` architecture decision 3).
 *
 * ONE pure function decides redirect validity, and it is used at registration
 * time and at authorize time. A second implementation is how an app ends up
 * registering a URI the authorize endpoint will not honour — or, in the
 * direction that actually hurts, registering one it will.
 *
 * The rules, all fail-closed:
 *  - `https://` — exact match on scheme, host, port and path. No wildcards, no
 *    userinfo, no query, no fragment.
 *  - private-use scheme (`swipesend://callback`) — exact match, and only when
 *    that client registered it.
 *  - loopback port-wildcard — FIRST PARTY ONLY. It is what the CLI needs
 *    (`http://127.0.0.1:{ephemeral}/callback`), and it is precisely the rule
 *    that must never be lent to a third party.
 *  - `http://` anywhere but loopback, and `localhost` in any form, rejected.
 */
import { describe, it, expect } from 'vitest';
import { getRegisteredClient, validateRedirectUri, PAGESPACE_CLI_CLIENT_ID, type RegisteredClient } from '../clients';

function client(overrides: Partial<RegisteredClient> = {}): RegisteredClient {
  return {
    clientId: 'third-party',
    name: 'Third Party App',
    type: 'public',
    redirectUris: ['https://app.example.com/auth/pagespace/callback'],
    allowedGrantTypes: ['authorization_code', 'refresh_token'],
    firstParty: false,
    verified: false,
    ...overrides,
  };
}

describe('validateRedirectUri — https exact match', () => {
  const web = client();

  it('accepts the exact registered https URI', () => {
    expect(validateRedirectUri(web, 'https://app.example.com/auth/pagespace/callback')).toBe(true);
  });

  it('accepts it with an explicit default port (the URL parser normalizes :443 away)', () => {
    expect(validateRedirectUri(web, 'https://app.example.com:443/auth/pagespace/callback')).toBe(true);
  });

  it('rejects a different port on the same host+path', () => {
    expect(validateRedirectUri(web, 'https://app.example.com:8443/auth/pagespace/callback')).toBe(false);
  });

  it('rejects a different host, including a subdomain and a suffix-extended host', () => {
    expect(validateRedirectUri(web, 'https://evil.app.example.com/auth/pagespace/callback')).toBe(false);
    expect(validateRedirectUri(web, 'https://app.example.com.evil.test/auth/pagespace/callback')).toBe(false);
    expect(validateRedirectUri(web, 'https://app.example/auth/pagespace/callback')).toBe(false);
  });

  it('rejects a different path — prefix, suffix, and trailing slash all count', () => {
    expect(validateRedirectUri(web, 'https://app.example.com/auth/pagespace/callback/evil')).toBe(false);
    expect(validateRedirectUri(web, 'https://app.example.com/auth/pagespace')).toBe(false);
    expect(validateRedirectUri(web, 'https://app.example.com/auth/pagespace/callback/')).toBe(false);
  });

  it('rejects http:// against an https registration (scheme is part of the match)', () => {
    expect(validateRedirectUri(web, 'http://app.example.com/auth/pagespace/callback')).toBe(false);
  });

  it('rejects userinfo, query and fragment on an otherwise exact match', () => {
    expect(validateRedirectUri(web, 'https://user@app.example.com/auth/pagespace/callback')).toBe(false);
    expect(validateRedirectUri(web, 'https://user:pw@app.example.com/auth/pagespace/callback')).toBe(false);
    expect(validateRedirectUri(web, 'https://app.example.com/auth/pagespace/callback?next=//evil.test')).toBe(false);
    expect(validateRedirectUri(web, 'https://app.example.com/auth/pagespace/callback#x')).toBe(false);
  });

  it('never honours a wildcard, even if one was somehow registered', () => {
    const wild = client({ redirectUris: ['https://*.example.com/auth/pagespace/callback'] });
    expect(validateRedirectUri(wild, 'https://evil.example.com/auth/pagespace/callback')).toBe(false);
    expect(validateRedirectUri(wild, 'https://*.example.com/auth/pagespace/callback')).toBe(false);
  });

  it('refuses a literal `*` anywhere in the candidate, even where it would match a registered path byte for byte', () => {
    const starPath = client({ redirectUris: ['https://app.example.com/cb/*'] });
    expect(validateRedirectUri(starPath, 'https://app.example.com/cb/*')).toBe(false);
  });

  it('refuses a REGISTERED uri containing `*` rather than matching it literally (a wildcard registration grants nothing)', () => {
    const starPath = client({ redirectUris: ['https://app.example.com/cb/*', 'https://app.example.com/cb/ok'] });
    expect(validateRedirectUri(starPath, 'https://app.example.com/cb/anything')).toBe(false);
    expect(validateRedirectUri(starPath, 'https://app.example.com/cb/ok')).toBe(true);
  });

  it('rejects `localhost` over https as well (RFC 8252 §8.3 — the name can be remapped)', () => {
    const local = client({ redirectUris: ['https://localhost/auth/pagespace/callback'] });
    expect(validateRedirectUri(local, 'https://localhost/auth/pagespace/callback')).toBe(false);
  });
});

describe('validateRedirectUri — private-use schemes (RFC 8252 §7.1)', () => {
  const native = client({ redirectUris: ['swipesend://callback'] });

  it('accepts the exact registered private-use scheme URI', () => {
    expect(validateRedirectUri(native, 'swipesend://callback')).toBe(true);
  });

  it('rejects a different host component under the same scheme', () => {
    expect(validateRedirectUri(native, 'swipesend://evil')).toBe(false);
  });

  it('rejects an extended path under the same scheme+host', () => {
    expect(validateRedirectUri(native, 'swipesend://callback/evil')).toBe(false);
  });

  it('rejects another app\'s scheme the client never registered', () => {
    expect(validateRedirectUri(native, 'otherapp://callback')).toBe(false);
  });

  it('accepts a reverse-DNS private-use scheme when registered exactly', () => {
    const reverseDns = client({ redirectUris: ['com.example.app://oauth/callback'] });
    expect(validateRedirectUri(reverseDns, 'com.example.app://oauth/callback')).toBe(true);
    expect(validateRedirectUri(reverseDns, 'com.example.app://oauth/evil')).toBe(false);
  });

  it('never treats a dangerous pseudo-scheme as a private-use scheme, even if registered', () => {
    for (const uri of ['javascript://callback', 'data://callback', 'file://callback', 'blob://callback', 'vbscript://callback', 'about://callback']) {
      const dangerous = client({ redirectUris: [uri] });
      expect(validateRedirectUri(dangerous, uri)).toBe(false);
    }
  });

  it('rejects a private-use redirect carrying query or fragment', () => {
    expect(validateRedirectUri(native, 'swipesend://callback?code=x')).toBe(false);
    expect(validateRedirectUri(native, 'swipesend://callback#x')).toBe(false);
  });
});

describe('validateRedirectUri — loopback is first-party only', () => {
  const cli = getRegisteredClient(PAGESPACE_CLI_CLIENT_ID);

  it('the CLI (first party) still gets the port wildcard on both loopback literals', () => {
    expect(cli).not.toBeNull();
    expect(validateRedirectUri(cli!, 'http://127.0.0.1:51234/callback')).toBe(true);
    expect(validateRedirectUri(cli!, 'http://[::1]:9999/callback')).toBe(true);
  });

  it('a third party that registered the identical loopback URI gets NO port wildcard', () => {
    const thirdPartyLoopback = client({ redirectUris: ['http://127.0.0.1/callback'] });
    expect(validateRedirectUri(thirdPartyLoopback, 'http://127.0.0.1:51234/callback')).toBe(false);
  });

  it('a third party does not get loopback at all — not even on the exact registered port', () => {
    const thirdPartyLoopback = client({ redirectUris: ['http://127.0.0.1:51234/callback'] });
    expect(validateRedirectUri(thirdPartyLoopback, 'http://127.0.0.1:51234/callback')).toBe(false);
  });

  it('an https registration on the loopback literal does not satisfy a cleartext loopback candidate (the port wildcard belongs to http loopback only)', () => {
    const httpsLoopback = client({ firstParty: true, redirectUris: ['https://127.0.0.1/callback'] });
    expect(validateRedirectUri(httpsLoopback, 'http://127.0.0.1:51234/callback')).toBe(false);
    expect(validateRedirectUri(httpsLoopback, 'http://127.0.0.1/callback')).toBe(false);
    // …and the https registration still matches its own exact candidate.
    expect(validateRedirectUri(httpsLoopback, 'https://127.0.0.1/callback')).toBe(true);
  });

  it('a registered loopback uri carrying a query or fragment grants nothing — the loopback branch compares host and path, so a sloppy registration must not act as a clean one', () => {
    const dirtyQuery = client({ firstParty: true, redirectUris: ['http://127.0.0.1/callback?x=1'] });
    expect(validateRedirectUri(dirtyQuery, 'http://127.0.0.1:51234/callback')).toBe(false);
    const dirtyFragment = client({ firstParty: true, redirectUris: ['http://127.0.0.1/callback#x'] });
    expect(validateRedirectUri(dirtyFragment, 'http://127.0.0.1:51234/callback')).toBe(false);
    const dirtyUserinfo = client({ firstParty: true, redirectUris: ['http://user@127.0.0.1/callback'] });
    expect(validateRedirectUri(dirtyUserinfo, 'http://127.0.0.1:51234/callback')).toBe(false);
  });

  it('`localhost` is rejected for the first party too', () => {
    expect(validateRedirectUri(cli!, 'http://localhost:51234/callback')).toBe(false);
  });

  it('non-loopback http is rejected for the first party too', () => {
    const firstPartyWeb = client({ firstParty: true, redirectUris: ['http://app.example.com/callback'] });
    expect(validateRedirectUri(firstPartyWeb, 'http://app.example.com/callback')).toBe(false);
  });

  it('a first party may still register https and private-use URIs, matched exactly', () => {
    const firstPartyMixed = client({
      firstParty: true,
      redirectUris: ['https://app.pagespace.ai/auth/pagespace/callback', 'pagespace://auth-exchange'],
    });
    expect(validateRedirectUri(firstPartyMixed, 'https://app.pagespace.ai/auth/pagespace/callback')).toBe(true);
    expect(validateRedirectUri(firstPartyMixed, 'pagespace://auth-exchange')).toBe(true);
    expect(validateRedirectUri(firstPartyMixed, 'pagespace://auth-exchange/evil')).toBe(false);
  });
});

describe('validateRedirectUri — malformed and empty input', () => {
  const web = client();

  it('rejects an empty, whitespace, or unparseable redirect', () => {
    expect(validateRedirectUri(web, '')).toBe(false);
    expect(validateRedirectUri(web, '   ')).toBe(false);
    expect(validateRedirectUri(web, 'not a uri')).toBe(false);
    expect(validateRedirectUri(web, '/auth/pagespace/callback')).toBe(false);
  });

  it('rejects everything when the client registered nothing', () => {
    expect(validateRedirectUri(client({ redirectUris: [] }), 'https://app.example.com/auth/pagespace/callback')).toBe(false);
  });

  it('skips an unparseable REGISTERED uri without letting it match or throw', () => {
    const brokenRegistration = client({ redirectUris: ['::::', 'https://app.example.com/auth/pagespace/callback'] });
    expect(validateRedirectUri(brokenRegistration, '::::')).toBe(false);
    expect(validateRedirectUri(brokenRegistration, 'https://app.example.com/auth/pagespace/callback')).toBe(true);
  });
});

describe('RegisteredClient — third-party metadata fields', () => {
  it('carries the consent-screen and cap fields Phase 1 renders and enforces', () => {
    const rich = client({
      logoUrl: 'https://cdn.example.com/logo.png',
      homepageUrl: 'https://example.com',
      description: 'Sends things by swiping',
      ownerUserId: 'usr123',
      allowedScopes: ['profile', 'offline_access', 'drive:member'],
      verified: true,
    });
    expect(rich.logoUrl).toBe('https://cdn.example.com/logo.png');
    expect(rich.homepageUrl).toBe('https://example.com');
    expect(rich.description).toBe('Sends things by swiping');
    expect(rich.ownerUserId).toBe('usr123');
    expect(rich.allowedScopes).toEqual(['profile', 'offline_access', 'drive:member']);
    expect(rich.verified).toBe(true);
  });

  it('the first-party CLI client is verified and declares no scope cap', () => {
    const cli = getRegisteredClient(PAGESPACE_CLI_CLIENT_ID);
    expect(cli?.verified).toBe(true);
    expect(cli?.allowedScopes).toBeUndefined();
  });
});
