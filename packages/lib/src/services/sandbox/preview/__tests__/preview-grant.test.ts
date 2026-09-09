import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { assert } from '../../__tests__/riteway';
import {
  PREVIEW_COOKIE_NAME,
  buildClearPreviewCookieHeader,
  buildPreviewAuthRedirect,
  buildPreviewCookieHeader,
  buildPreviewHost,
  buildPreviewOpenPath,
  derivePreviewCookieKey,
  parseCookieHeader,
  parsePreviewHost,
  previewFrameSrcEntry,
  readPreviewCookie,
  sanitizeUpstreamSetCookie,
  signPreviewCookie,
  verifyPreviewCookie,
} from '../preview-grant';
import { normalizeDevPreviewApex } from '../dev-preview-env';

const APEX = 'pagespace-preview.app';
const NOW = new Date('2026-09-06T10:00:00.000Z');
const KEY = derivePreviewCookieKey('s'.repeat(40));

describe('the preview apex', () => {
  it('accepts a dedicated registrable domain and normalizes it', () => {
    assert({ given: 'mixed case with a trailing dot', should: 'normalize', actual: normalizeDevPreviewApex(' PageSpace-Preview.App. ', 'app.pagespace.ai'), expected: APEX });
  });

  it.each([
    ['pagespace.ai', 'app.pagespace.ai', 'the app domain itself'],
    ['preview.pagespace.ai', 'pagespace.ai', 'a child of the app domain'],
    ['pagespace.ai', 'preview.pagespace.ai', 'a parent of the app host'],
    ['previews.pagespace.ai', 'app.pagespace.ai', 'a SIBLING on the same registrable domain'],
    ['previews.pagespace.co.uk', 'app.pagespace.co.uk', 'a sibling under a two-label public suffix'],
    ['', 'app.pagespace.ai', 'unset'],
    ['not a domain', 'app.pagespace.ai', 'malformed'],
    ['localhost', 'app.pagespace.ai', 'no TLD'],
  ])('refuses %s (%s) — cookie tossing needs shared registrable domain', (raw, appHost) => {
    assert({ given: `${raw} against ${appHost}`, should: 'be null (fail closed)', actual: normalizeDevPreviewApex(raw, appHost), expected: null });
  });

  it('accepts a genuinely separate registrable domain even when it shares a TLD', () => {
    assert({ given: 'pagespace-preview.app vs app.pagespace.app', should: 'accept', actual: normalizeDevPreviewApex('pagespace-preview.app', 'app.pagespace.app'), expected: 'pagespace-preview.app' });
  });

  it('accepts an apex when the app host is unknown (the app-host guard is defense in depth, not the only guard)', () => {
    assert({ given: 'no app host', should: 'still normalize', actual: normalizeDevPreviewApex(APEX, null), expected: APEX });
  });
});

describe('preview hosts', () => {
  it('names a holder origin and parses it back', () => {
    const host = buildPreviewHost({ kind: 'env', id: 'clenv123' }, APEX);
    assert({ given: 'an env holder', should: 'build env-<id>.preview.<apex>', actual: host, expected: `env-clenv123.preview.${APEX}` });
    assert({ given: 'that host with a port', should: 'parse back', actual: parsePreviewHost(`${host}:443`, APEX), expected: { kind: 'env', id: 'clenv123' } });
    assert({ given: 'a workspace host', should: 'parse ws-', actual: parsePreviewHost(`ws-abc.preview.${APEX}`, APEX), expected: { kind: 'workspace', id: 'abc' } });
    assert({ given: 'a host in mixed case (DNS is case-insensitive)', should: 'parse to the lower-cased id', actual: parsePreviewHost(`ENV-Abc.Preview.${APEX.toUpperCase()}`, APEX), expected: { kind: 'env', id: 'abc' } });
  });

  it.each([
    [`preview.${APEX}`],
    [`x.preview.${APEX}`],
    [`env-.preview.${APEX}`],
    [`env-a.b.preview.${APEX}`],
    [`env-a.preview.${APEX}.evil.com`],
    ['app.pagespace.ai'],
    [null],
  ])('does not treat %s as a preview host', (host) => {
    assert({ given: String(host), should: 'be null', actual: parsePreviewHost(host, APEX), expected: null });
  });

  it('refuses to build a host from an id that is not a label', () => {
    expect(() => buildPreviewHost({ kind: 'env', id: 'has space' }, APEX)).toThrow();
  });

  it('exposes exactly the wildcard as the frame-src entry', () => {
    assert({ given: APEX, should: 'be https://*.preview.<apex>', actual: previewFrameSrcEntry(APEX), expected: `https://*.preview.${APEX}` });
  });
});

describe('the cookie token', () => {
  const claims = { holder: { kind: 'workspace' as const, id: 'ws1' }, userId: 'u1', sessionId: 'sess1', expiresAt: NOW.getTime() + 60_000 };

  it('round-trips under the same key', () => {
    const token = signPreviewCookie(claims, KEY);
    assert({ given: 'a signed token', should: 'verify to its claims', actual: verifyPreviewCookie(token, KEY, NOW), expected: { ok: true, claims } });
  });

  it('rejects a token signed under another secret', () => {
    const token = signPreviewCookie(claims, derivePreviewCookieKey('t'.repeat(40)));
    assert({ given: 'foreign key', should: 'bad-signature', actual: verifyPreviewCookie(token, KEY, NOW), expected: { ok: false, reason: 'bad-signature' } });
  });

  it('rejects a payload edit (holder swap) even with the original signature', () => {
    const token = signPreviewCookie(claims, KEY);
    const [v, , sig] = token.split('.');
    const swapped = Buffer.from(JSON.stringify({ k: 'workspace', h: 'ws2', u: 'u1', s: 'sess1', e: claims.expiresAt })).toString('base64url');
    assert({ given: 'a swapped holder', should: 'bad-signature', actual: verifyPreviewCookie(`${v}.${swapped}.${sig}`, KEY, NOW), expected: { ok: false, reason: 'bad-signature' } });
  });

  it('rejects an expired token', () => {
    const token = signPreviewCookie(claims, KEY);
    assert({ given: 'now past expiry', should: 'expired', actual: verifyPreviewCookie(token, KEY, new Date(claims.expiresAt)), expected: { ok: false, reason: 'expired' } });
  });

  it.each(['', 'v1', 'v0.a.b', 'v1.!!.??', 'v1.a.b.c'])('rejects malformed %s', (token) => {
    const result = verifyPreviewCookie(token, KEY, NOW);
    assert({ given: token, should: 'not verify', actual: result.ok, expected: false });
  });

  it('carries the SESSION, and refuses a payload that omits or malforms it', () => {
    // A cookie with no session id is a v1 cookie: it would authenticate a
    // person with nothing to revoke. It must not verify.
    const signed = signPreviewCookie(claims, KEY);
    expect(signed.startsWith('v2.')).toBe(true);
    const result = verifyPreviewCookie(signed, KEY, NOW);
    assert({ given: 'a v2 cookie', should: 'carry the minting session', actual: result.ok && result.claims.sessionId, expected: 'sess1' });

    // Re-signed OVER THE MODIFIED BODY, which is the whole point: reusing the
    // original signature would make every case below fail on `bad-signature`
    // before the claim check ran, and the assertion would pass without testing
    // anything. The MAC covers `v2.<payload>`, matching `signPreviewCookie`.
    const resign = (payload: Record<string, unknown>) => {
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const sig = createHmac('sha256', KEY).update(`v2.${body}`).digest().toString('base64url');
      return { body, sig };
    };
    for (const payload of [
      { k: 'workspace', h: 'ws1', u: 'u1', e: claims.expiresAt },
      { k: 'workspace', h: 'ws1', u: 'u1', s: '', e: claims.expiresAt },
      { k: 'workspace', h: 'ws1', u: 'u1', s: 42, e: claims.expiresAt },
    ]) {
      const { body, sig } = resign(payload);
      assert({ given: JSON.stringify(payload), should: 'not verify', actual: verifyPreviewCookie(`v2.${body}.${sig}`, KEY, NOW).ok, expected: false });
    }
  });

  it('treats a v1 cookie as malformed, which routes to the silent re-handshake', () => {
    const [, body, sig] = signPreviewCookie(claims, KEY).split('.');
    assert({ given: 'a v1-versioned token', should: 'be malformed, never accepted', actual: verifyPreviewCookie(`v1.${body}.${sig}`, KEY, NOW), expected: { ok: false, reason: 'malformed' } });
  });

  it('never verifies with an empty key, and never signs with one', () => {
    const empty = derivePreviewCookieKey('');
    assert({ given: 'empty key', should: 'no-key', actual: verifyPreviewCookie(signPreviewCookie(claims, KEY), empty, NOW), expected: { ok: false, reason: 'no-key' } });
    expect(() => signPreviewCookie(claims, empty)).toThrow(/not configured/);
  });

  it('derives different keys for different secrets and a stable key for the same one', () => {
    expect(derivePreviewCookieKey('a'.repeat(40)).equals(derivePreviewCookieKey('a'.repeat(40)))).toBe(true);
    expect(derivePreviewCookieKey('a'.repeat(40)).equals(derivePreviewCookieKey('b'.repeat(40)))).toBe(false);
  });
});

describe('cookie headers', () => {
  it('installs a __Host-, HttpOnly, Secure, SameSite=None, Partitioned cookie with the remaining lifetime', () => {
    assert({
      given: 'a token expiring in 90s',
      should: 'set every host-only attribute and Max-Age=90',
      actual: buildPreviewCookieHeader('tok', new Date(NOW.getTime() + 90_000), NOW),
      expected: `${PREVIEW_COOKIE_NAME}=tok; Path=/; Max-Age=90; Secure; HttpOnly; SameSite=None; Partitioned`,
    });
  });

  it('never sets a Domain attribute (host-only by construction)', () => {
    expect(buildPreviewCookieHeader('t', new Date(NOW.getTime() + 1000), NOW)).not.toMatch(/domain=/i);
    expect(buildClearPreviewCookieHeader()).toMatch(/Max-Age=0/);
  });

  it('reads the preview cookie out of a Cookie header, first occurrence wins, values may contain =', () => {
    assert({ given: 'two cookies', should: 'parse both', actual: parseCookieHeader('a=1; b=x=y; a=2'), expected: { a: '1', b: 'x=y' } });
    assert({ given: 'our cookie among others', should: 'read it', actual: readPreviewCookie(`x=1; ${PREVIEW_COOKIE_NAME}=v1.p.s`), expected: 'v1.p.s' });
    assert({ given: 'no header', should: 'be null', actual: readPreviewCookie(null), expected: null });
  });
});

describe('what a dev server may set', () => {
  it('strips Domain so a cookie stays host-only (no cross-holder tossing)', () => {
    assert({
      given: 'a dev-server cookie with Domain',
      should: 'keep everything but Domain',
      actual: sanitizeUpstreamSetCookie(`sid=abc; Domain=preview.${APEX}; Path=/; HttpOnly; SameSite=Lax`),
      expected: 'sid=abc; Path=/; HttpOnly; SameSite=Lax',
    });
  });

  it('drops any cookie in the reserved __Host-ps_ namespace', () => {
    assert({ given: 'the preview cookie name', should: 'drop', actual: sanitizeUpstreamSetCookie(`${PREVIEW_COOKIE_NAME}=forged; Path=/`), expected: null });
    assert({ given: 'a sibling reserved name', should: 'drop', actual: sanitizeUpstreamSetCookie('__Host-ps_other=1'), expected: null });
  });
});

describe('redirect targets', () => {
  it('builds the auth redirect with the grant as a query parameter', () => {
    assert({
      given: 'a host and a grant',
      should: 'point at /__pagespace/auth',
      actual: buildPreviewAuthRedirect(`env-e1.preview.${APEX}`, 'g_1-2'),
      expected: `https://env-e1.preview.${APEX}/__pagespace/auth?grant=g_1-2`,
    });
  });

  it('knows the app-origin open route for each holder kind', () => {
    assert({ given: 'workspace', should: 'session route', actual: buildPreviewOpenPath({ kind: 'workspace', id: 'w' }, null), expected: '/api/agent-workspaces/w/preview/open' });
    assert({ given: 'env with drive', should: 'env route', actual: buildPreviewOpenPath({ kind: 'env', id: 'e' }, 'd'), expected: '/api/drives/d/envs/e/preview/open' });
    assert({ given: 'env without drive', should: 'null', actual: buildPreviewOpenPath({ kind: 'env', id: 'e' }, null), expected: null });
  });

});

describe('cookie lifetime', () => {
  it('is minutes, not hours — the cookie is not session-bound, so its TTL is the logged-out exposure window', async () => {
    const { PREVIEW_COOKIE_TTL_MS } = await import('../preview-grant');
    expect(PREVIEW_COOKIE_TTL_MS).toBeLessThanOrEqual(15 * 60 * 1000);
  });
});
