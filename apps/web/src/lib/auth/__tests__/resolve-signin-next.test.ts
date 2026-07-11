import { describe, it, expect } from 'vitest';
import { resolveSigninNext } from '../resolve-signin-next';

// Logged-out /dashboard requests reach the signin page via a middleware REWRITE
// rather than a redirect, because a redirect is cancelled and punted to Safari by
// the iOS shell's navigation policy (see middleware.ts). Under a rewrite the
// browser URL stays on the dashboard deep link, and useSearchParams reads the
// browser URL — so `next=` on the rewrite destination never reaches the client and
// the deep link has to be recovered from the path the page is sitting on.
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

  // useSearchParams does NOT agree with itself across the hydration boundary under a
  // rewrite: the server renders at the rewrite destination (/auth/signin?next=…, so it
  // sees the param) while the browser is at /dashboard/… (so it does not). nextPath is
  // rendered into the signup link's href, so a disagreement is a real hydration mismatch.
  // Both sources are therefore gated on browserPath, a browser-only value.
  describe('hydration safety', () => {
    it('resolves to undefined with NO browserPath even when paramNext is present and valid', () => {
      // This is the server render / first client render. Both must agree on undefined.
      expect(
        resolveSigninNext({ paramNext: '/dashboard/drv_abc', browserPath: null }),
      ).toBeUndefined();
    });

    it('yields the value only once browserPath is known (the render after mount)', () => {
      expect(
        resolveSigninNext({ paramNext: '/dashboard/drv_abc', browserPath: '/auth/signin?next=/dashboard/drv_abc' }),
      ).toBe('/dashboard/drv_abc');
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
