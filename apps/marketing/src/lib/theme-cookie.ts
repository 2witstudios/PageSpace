const COOKIE_NAME = "theme";
const MAX_AGE = 60 * 60 * 24 * 365; // 1 year

export function syncThemeToCookie(theme: string) {
  const cookieDomain = process.env.NEXT_PUBLIC_COOKIE_DOMAIN;
  const domain = cookieDomain ? `; domain=${cookieDomain}` : "";
  document.cookie = `${COOKIE_NAME}=${theme}; path=/; max-age=${MAX_AGE}; SameSite=Lax${domain}`;
}

export function getThemeFromCookie(): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]*)`));
  return match ? match[1] : null;
}
