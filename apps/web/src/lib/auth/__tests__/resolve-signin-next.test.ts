import { describe, it, expect } from 'vitest';
import { resolveSigninNext, buildSigninRoute } from '../resolve-signin-next';

// Logged-out /dashboard requests reach the signin page via a middleware REWRITE rather
// than a redirect, because a redirect is cancelled and punted to Safari by the iOS shell's
// navigation policy (see middleware.ts). A rewrite leaves the browser URL alone, so the
// browser is still sitting ON the dashboard deep link — which is why middleware sends the
// rewrite to a BARE /auth/signin (no next=) and the deep link is recovered from the path
// instead. Carrying it on the rewrite destination too would have the server render a value
// the client cannot see, and it reaches the DOM: a hydration mismatch.
describe('resolveSigninNext', () => {
  describe('redirect flow (a real /auth/signin?next=… URL)', () => {
    it('uses next= when present', () => {
      expect(
        resolveSigninNext({ paramNext: '/dashboard/drv_abc/pg_xyz', browserPath: '/auth/signin' }),
      ).toBe('/dashboard/drv_abc/pg_xyz');
    });

    it('resolves to undefined on a bare /auth/signin, so the caller falls back to its own default', () => {
      // The browserPath fallback must be INERT here: '/auth/signin' is not an
      // allowed next target, so the normal web flow is unchanged by its existence.
      expect(resolveSigninNext({ paramNext: null, browserPath: '/auth/signin' })).toBeUndefined();
    });
  });

  describe('rewrite flow (the iOS shell — browser URL is the dashboard deep link)', () => {
    it('recovers the deep link from the browser path when next= is absent', () => {
      expect(
        resolveSigninNext({ paramNext: null, browserPath: '/dashboard/drv_abc/pg_xyz' }),
      ).toBe('/dashboard/drv_abc/pg_xyz');
    });

    it('keeps the query string of the deep link', () => {
      expect(
        resolveSigninNext({ paramNext: null, browserPath: '/dashboard/drv_abc?tab=chat' }),
      ).toBe('/dashboard/drv_abc?tab=chat');
    });

    it('resolves to undefined before mount, when the browser path is not yet known', () => {
      expect(resolveSigninNext({ paramNext: null, browserPath: null })).toBeUndefined();
    });

    it('prefers an explicit next= over the browser path', () => {
      expect(
        resolveSigninNext({ paramNext: '/dashboard/from-param', browserPath: '/dashboard/from-browser' }),
      ).toBe('/dashboard/from-param');
    });

    // Under a rewrite, useSearchParams reads the BROWSER url — so a junk `?next=` the
    // user arrived with is visible here even though middleware already rejected it.
    // Its mere presence must not shadow the deep link we can still recover.
    it('recovers the deep link even when the browser url carries a rejected next=', () => {
      expect(
        resolveSigninNext({
          paramNext: '/settings/billing', // outside the allowlist — middleware dropped it
          browserPath: '/dashboard/drv_abc?next=/settings/billing',
        }),
      ).toBe('/dashboard/drv_abc');
    });

    it('strips only the rejected next=, keeping the rest of the query', () => {
      expect(
        resolveSigninNext({
          paramNext: 'https://evil.example',
          browserPath: '/dashboard/drv_abc?next=https://evil.example&tab=chat',
        }),
      ).toBe('/dashboard/drv_abc?tab=chat');
    });
  });

  // nextPath is rendered into the signup link's href, so server and client must agree on
  // the FIRST render. browserPath is null during SSR and on the first client render (it is
  // set in an effect), so agreement rests entirely on paramNext matching across the
  // boundary — which is exactly why middleware puts next= on the redirect but NOT on the
  // rewrite. These two cases are that guarantee, pinned.
  describe('hydration safety (first render, browserPath not yet known)', () => {
    it('redirect flow: server and client both see next=, and both resolve it', () => {
      // Server renders /auth/signin?next=X; the browser is on that same URL. Agreement —
      // and the SSR href is already correct, so a pre-hydration click keeps the deep link.
      expect(
        resolveSigninNext({ paramNext: '/dashboard/drv_abc', browserPath: null }),
      ).toBe('/dashboard/drv_abc');
    });

    it('rewrite flow: neither server nor client sees a next=, and both resolve undefined', () => {
      // The rewrite destination is a bare /auth/signin, and the browser sits on
      // /dashboard/… which has no next= either. The deep link arrives post-mount instead.
      expect(resolveSigninNext({ paramNext: null, browserPath: null })).toBeUndefined();
    });
  });

  describe('open-redirect safety', () => {
    it.each([
      ['absolute off-origin URL', 'https://evil.example/x'],
      ['protocol-relative URL', '//evil.example/x'],
      ['backslash trick', '/\\evil.example'],
      ['path outside the allowlist', '/settings/billing'],
      ['traversal escaping the allowlist', '/dashboard/../settings/billing'],
    ])('drops a %s supplied via next=', (_label, path) => {
      // browserPath is a real signin URL here, so the gate is open and it is genuinely
      // the allowlist — not the hydration guard — doing the rejecting.
      expect(resolveSigninNext({ paramNext: path, browserPath: '/auth/signin' })).toBeUndefined();
    });

    it('drops an unsafe browser path just as readily as an unsafe next=', () => {
      expect(resolveSigninNext({ paramNext: null, browserPath: '//evil.example/x' })).toBeUndefined();
    });
  });
});

// A session that dies mid-use never passes through middleware as a page request — the
// client notices the dead token and routes away itself — so this is the only place that
// can attach `next=`. Without it the user is dropped on the default dashboard afterwards,
// having lost their place. (useAuthStore's auth:expired handler is the caller.)
describe('buildSigninRoute', () => {
  it('carries the page the user was on, url-encoded', () => {
    expect(buildSigninRoute('/dashboard/drv_abc/pg_xyz')).toBe(
      '/auth/signin?next=%2Fdashboard%2Fdrv_abc%2Fpg_xyz',
    );
  });

  it('keeps the query string of the page they were on', () => {
    expect(buildSigninRoute('/dashboard/drv_abc?tab=chat')).toBe(
      '/auth/signin?next=%2Fdashboard%2Fdrv_abc%3Ftab%3Dchat',
    );
  });

  it('round-trips: what it encodes is what resolveSigninNext reads back out', () => {
    const route = buildSigninRoute('/dashboard/drv_abc?tab=chat');
    const params = new URL(route, 'https://pagespace.invalid').searchParams;

    expect(resolveSigninNext({ paramNext: params.get('next'), browserPath: route })).toBe(
      '/dashboard/drv_abc?tab=chat',
    );
  });

  it.each([
    ['a page outside the allowlist', '/settings/billing'],
    ['an off-origin url', 'https://evil.example/x'],
    ['a protocol-relative url', '//evil.example/x'],
    ['signin itself (no self-referential loop)', '/auth/signin'],
    ['nothing at all', null],
  ])('degrades to a bare /auth/signin for %s', (_label, path) => {
    expect(buildSigninRoute(path)).toBe('/auth/signin');
  });
});
