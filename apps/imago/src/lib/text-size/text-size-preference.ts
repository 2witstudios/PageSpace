/**
 * Imago's text-size setting. It is imago's own (classic has none), not a
 * secret and not httpOnly: the root layout reads it to render
 * <html data-text-size>, so the first paint is already at the chosen size.
 */
export const TEXT_SIZE_COOKIE_NAME = 'imago-text-size';

/** The choices, smallest first, in the order the control offers them. */
export const TEXT_SIZES = ['small', 'default', 'large', 'larger'] as const;

export type TextSize = (typeof TEXT_SIZES)[number];

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

const isTextSize = (value: unknown): value is TextSize => TEXT_SIZES.some((size) => size === value);

/** The trust boundary for the cookie: anything but a known size is the default. */
export const parseTextSize = (value: string | undefined): TextSize => (isTextSize(value) ? value : 'default');

/** Reads the size out of a cookie string such as `document.cookie`, through the same trust boundary as the server. */
export const textSizeFromCookies = (cookies: string): TextSize =>
  parseTextSize(
    cookies
      .split(';')
      .map((pair) => pair.trim().split('='))
      .find(([name]) => name === TEXT_SIZE_COOKIE_NAME)?.[1],
  );

/**
 * The cookie a choice writes, attribute for attribute as the theme cookie
 * (serializeThemeCookie): path=/, one year, SameSite=Lax, and the shared
 * cookie domain when one is configured (host-only otherwise).
 */
export const serializeTextSizeCookie = (size: TextSize, { domain }: { readonly domain: string | undefined }): string =>
  `${TEXT_SIZE_COOKIE_NAME}=${size}; path=/; max-age=${ONE_YEAR_SECONDS}; SameSite=Lax${domain ? `; domain=${domain}` : ''}`;
