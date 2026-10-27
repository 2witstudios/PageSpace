import type { ImageLoader } from "next/image";

/**
 * The hero backdrops, encoded once at build time (scripts/encode-hero.ts) so
 * the marketing server never runs sharp for them. A 3840w AVIF encode of one
 * frame peaks at ~270 MB; two at once overran the 512 MB machine and the
 * reboot wiped the optimizer cache, so the next retina visitor crashed it again.
 *
 * This module is the single source for the encoder and the page: every width
 * and format listed here is written to disk, and the loaders below only ever
 * point at those files.
 */

/** next/image's default deviceSizes — the widths a `sizes="100vw"` srcset asks for. */
export const HERO_WIDTHS = [640, 750, 828, 1080, 1200, 1920, 2048, 3840] as const;

/** Matches what the optimizer shipped: AVIF at q90-20, WebP at q90. */
export const HERO_FORMATS = {
  avif: { mimeType: "image/avif", quality: 70 },
  webp: { mimeType: "image/webp", quality: 90 },
} as const;

export type HeroFormat = keyof typeof HERO_FORMATS;

export const HERO_FRAMES = {
  dark: {
    source: "hero-space.webp",
    blurDataURL:
      "data:image/webp;base64,UklGRnIAAABXRUJQVlA4IGYAAAAQBACdASoYAAoAPtFapEwoJSOiMAgBABoJZACdMoAKOILPbRUwIYbwsAD+/re+Pv0MN+A1bR7I/7yCzqImeck6gy0aV0OsD81MyQafLMicOSPnAvKKaENGBgRjKZhqKF8e1s+QAAA=",
  },
  light: {
    source: "hero-space-light.webp",
    blurDataURL:
      "data:image/webp;base64,UklGRrwAAABXRUJQVlA4ILAAAACwBACdASoYAAoAPrVKoUqnJCMhsAgA4BaJaACdMoFWZjlG6Gm44gZ57c8sEUywAP7+s0t264aE6qfbqCcUjPS63d5Q5eqST+4+BsCASCMeFtZzi3q9oq8F25pii+Ihg/77uc1nokwPJzmvyRj+48Je+H/mVeXy3o4om2w+8vP31r+BkISDLcZh8oJsK2ecX8GOZluMdX/4b0WFjU5AtlOESCgspF1HJJArdGLVcfAAAA==",
  },
} as const;

export type HeroFrame = keyof typeof HERO_FRAMES;

/**
 * Under `/_marketing/` because that is the only marketing prefix the proxy
 * routes, and Next serves `public/` at the root: the files live in
 * `public/_marketing/hero/`.
 */
export const HERO_URL_BASE = "/_marketing/hero";

/** The smallest encoded width that covers `width`; the largest if none does. */
export function heroVariantWidth(width: number): number {
  return HERO_WIDTHS.find((w) => w >= width) ?? HERO_WIDTHS[HERO_WIDTHS.length - 1];
}

export function heroVariantPath(frame: HeroFrame, width: number, format: HeroFormat): string {
  return `${HERO_URL_BASE}/${frame}-${heroVariantWidth(width)}.${format}`;
}

export function heroLoader(frame: HeroFrame, format: HeroFormat): ImageLoader {
  return ({ width }) => heroVariantPath(frame, width, format);
}

export type HeroVariant = { frame: HeroFrame; width: number; format: HeroFormat; path: string };

/** Every file the encoder must produce. */
export function heroVariants(): HeroVariant[] {
  return (Object.keys(HERO_FRAMES) as HeroFrame[]).flatMap((frame) =>
    HERO_WIDTHS.flatMap((width) =>
      (Object.keys(HERO_FORMATS) as HeroFormat[]).map((format) => ({
        frame,
        width,
        format,
        path: heroVariantPath(frame, width, format),
      })),
    ),
  );
}
