import type { ThemePreference } from './theme-preference';

/** The slice of <html> a theme switch writes to; tests pass a plain object. */
type ThemeTarget = {
  readonly dataset: Record<string, string | undefined>;
};

/**
 * Writes the preference onto `data-theme`, which selects `color-scheme` and
 * so every `light-dark()` token in globals.css: the page restyles in place,
 * with no reload and no class changes. The server renders it from the cookie,
 * so this only runs on a switch; ThemeProvider passes `document.documentElement`.
 */
export const applyTheme = (
  root: ThemeTarget,
  preference: ThemePreference,
): void => {
  root.dataset.theme = preference;
};
