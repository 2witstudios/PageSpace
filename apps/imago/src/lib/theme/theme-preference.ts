/**
 * Classic's theme cookie (apps/web/src/lib/theme-cookie.ts). Imago reads the
 * same cookie so both apps render one preference; it is not a secret and not
 * httpOnly, and classic writes it on every switch.
 */
export const THEME_COOKIE_NAME = 'theme';

export type ThemePreference = 'light' | 'dark' | 'system';

/**
 * The trust boundary for the cookie: anything other than an explicit light or
 * dark choice is `system`, exactly as classic's layout treats it.
 */
export const parseThemePreference = (
  value: string | undefined,
): ThemePreference =>
  value === 'light' || value === 'dark' || value === 'system'
    ? value
    : 'system';
