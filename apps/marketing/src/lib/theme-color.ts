/**
 * Browser chrome colour (`<meta name="theme-color">`) for each theme, matching
 * the page canvas: `--background` in globals.css, light oklch(0.995 0.002 240)
 * and dark oklch(0.11 0 0), converted to sRGB hex.
 */
export const THEME_COLORS = {
  light: "#fcfeff",
  dark: "#040404",
} as const;

type ThemeColorMeta = { content: string };

/**
 * The server emits one theme-color tag per OS colour scheme, which is right for
 * a visitor on the system theme. A theme picked with the toggle can disagree
 * with the OS, so once the resolved theme is known every tag gets that theme's
 * colour, whichever media query it carries. Unknown values leave the tags as
 * the server rendered them.
 */
export function applyThemeColor(
  metas: Iterable<ThemeColorMeta>,
  resolvedTheme: string | undefined,
): void {
  if (resolvedTheme !== "light" && resolvedTheme !== "dark") return;
  for (const meta of metas) meta.content = THEME_COLORS[resolvedTheme];
}
