import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { syncThemeToCookie } from '../../../../web/src/lib/theme-cookie';
import {
  THEME_COOKIE_NAME,
  THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  parseThemePreference,
  preferenceFromCookies,
  serializeThemeCookie,
} from './theme-preference';

describe('parseThemePreference', () => {
  test('the classic theme cookie', () => {
    assert({
      given: 'the cookie name',
      should: "be classic's `theme`, so both apps read one preference",
      actual: THEME_COOKIE_NAME,
      expected: 'theme',
    });

    assert({
      given: 'each value classic writes',
      should: 'keep it as the preference',
      actual: ['light', 'dark', 'system'].map(parseThemePreference),
      expected: ['light', 'dark', 'system'],
    });
  });

  test('a missing or untrusted value', () => {
    assert({
      given: 'no cookie, an empty value, a wrong case or markup',
      should: "fall back to system, as classic's layout does",
      actual: [undefined, '', 'Dark', '"><script>', 'light '].map(
        parseThemePreference,
      ),
      expected: ['system', 'system', 'system', 'system', 'system'],
    });
  });
});

describe('THEME_PREFERENCES', () => {
  test('the choices the switcher offers', () => {
    assert({
      given: 'the preference list',
      should: 'offer light, dark and system, in that order',
      actual: THEME_PREFERENCES,
      expected: ['light', 'dark', 'system'],
    });
  });
});

describe('preferenceFromCookies', () => {
  test('a cookie string such as document.cookie', () => {
    assert({
      given: 'the theme cookie among others, and a prefix-named cookie',
      should: 'read only the `theme` pair through the trust boundary',
      actual: [
        preferenceFromCookies('session=abc; theme=dark; other=1'),
        preferenceFromCookies('theme=light'),
        preferenceFromCookies('mytheme=dark; theme=system'),
        preferenceFromCookies('mytheme=dark'),
        preferenceFromCookies('theme=sepia'),
        preferenceFromCookies(''),
      ],
      expected: ['dark', 'light', 'system', 'system', 'system', 'system'],
    });
  });
});

describe('serializeThemeCookie', () => {
  test('the cookie imago writes', () => {
    assert({
      given: 'each preference and no cookie domain',
      should: "write classic's name, path, max-age and SameSite",
      actual: THEME_PREFERENCES.map((preference) =>
        serializeThemeCookie(preference, { domain: undefined }),
      ),
      expected: [
        'theme=light; path=/; max-age=31536000; SameSite=Lax',
        'theme=dark; path=/; max-age=31536000; SameSite=Lax',
        'theme=system; path=/; max-age=31536000; SameSite=Lax',
      ],
    });

    assert({
      given: 'a shared cookie domain',
      should: 'scope the cookie to it, as classic does',
      actual: serializeThemeCookie('dark', { domain: '.pagespace.ai' }),
      expected:
        'theme=dark; path=/; max-age=31536000; SameSite=Lax; domain=.pagespace.ai',
    });

    assert({
      given: 'an empty cookie domain',
      should: 'leave the cookie host-only, as classic does',
      actual: serializeThemeCookie('light', { domain: '' }),
      expected: 'theme=light; path=/; max-age=31536000; SameSite=Lax',
    });
  });

  describe("parity with classic's writer", () => {
    const classicWrites = (
      preference: string,
      domain: string | undefined,
    ): string => {
      const written: string[] = [];
      vi.stubGlobal('document', {
        set cookie(value: string) {
          written.push(value);
        },
      });
      vi.stubEnv('NEXT_PUBLIC_COOKIE_DOMAIN', domain);
      syncThemeToCookie(preference);
      return written.join('\n');
    };

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    test('every preference, with and without a cookie domain', () => {
      const cases = THEME_PREFERENCES.flatMap((preference) =>
        [undefined, '.pagespace.ai'].map((domain) => ({ preference, domain })),
      );

      assert({
        given: "apps/web's syncThemeToCookie and imago's serializer",
        should: 'write the identical cookie, so classic and imago agree',
        actual: cases.map(({ preference, domain }) =>
          serializeThemeCookie(preference, { domain }),
        ),
        expected: cases.map(({ preference, domain }) =>
          classicWrites(preference, domain),
        ),
      });
    });
  });
});

describe('THEME_STORAGE_KEY', () => {
  test("classic's next-themes storage", () => {
    assert({
      given: 'the localStorage key',
      should: "be next-themes' default `theme`, which classic reads first",
      actual: THEME_STORAGE_KEY,
      expected: 'theme',
    });
  });
});
