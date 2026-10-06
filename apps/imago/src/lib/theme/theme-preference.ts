/**
 * Classic's theme cookie (apps/web/src/lib/theme-cookie.ts). Imago reads the
 * same cookie so both apps render one preference; it is not a secret and not
 * httpOnly, and classic writes it on every switch.
 */
export const THEME_COOKIE_NAME = 'theme';

/**
 * Classic's next-themes storage key (its default `storageKey`). next-themes
 * reads it before the cookie, so a switch made in imago must land here too or
 * classic would restore its stale value and write it back to the cookie.
 */
export const THEME_STORAGE_KEY = 'theme';

/** The choices, in the order the switcher offers them. */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

const isThemePreference = (value: unknown): value is ThemePreference =>
  THEME_PREFERENCES.some((preference) => preference === value);

/**
 * The trust boundary for the cookie: anything other than an explicit light or
 * dark choice is `system`, exactly as classic's layout treats it.
 */
export const parseThemePreference = (
  value: string | undefined,
): ThemePreference => (isThemePreference(value) ? value : 'system');

/**
 * Reads the preference out of a cookie string such as `document.cookie`,
 * through the same trust boundary as the server.
 */
export const preferenceFromCookies = (cookies: string): ThemePreference =>
  parseThemePreference(
    cookies
      .split(';')
      .map((pair) => pair.trim().split('='))
      .find(([name]) => name === THEME_COOKIE_NAME)?.[1],
  );

/**
 * The cookie classic's syncThemeToCookie writes, attribute for attribute:
 * path=/ so both apps on the origin see it, one year, SameSite=Lax, and the
 * shared cookie domain when one is configured (host-only otherwise).
 */
export const serializeThemeCookie = (
  preference: ThemePreference,
  { domain }: { readonly domain: string | undefined },
): string =>
  `${THEME_COOKIE_NAME}=${preference}; path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Lax${
    domain ? `; domain=${domain}` : ''
  }`;
