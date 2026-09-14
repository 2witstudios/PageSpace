"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useTheme } from "next-themes";

/**
 * The hero's space backdrop, one image per theme. The dark nebula is the base
 * layer and stays opaque; the white one sits above it and is shown or hidden by
 * the theme class alone, so a page load paints the right image with no motion.
 *
 * The two frames are not pixel-identical, so a theme switch crossfades the top
 * layer instead of cutting. That has to be a keyed animation, not a transition:
 * the ThemeProvider's `disableTransitionOnChange` suppresses transitions for the
 * class flip. `data-theme-fade` is only set after a real switch, never on the
 * first resolved theme, so a load never fades.
 */
export function HeroBackdrop() {
  const { resolvedTheme } = useTheme();
  const initialTheme = useRef<string | undefined>(undefined);
  const [switched, setSwitched] = useState(false);

  useEffect(() => {
    if (!resolvedTheme) return;
    if (initialTheme.current === undefined) {
      initialTheme.current = resolvedTheme;
    } else if (resolvedTheme !== initialTheme.current) {
      setSwitched(true);
    }
  }, [resolvedTheme]);

  return (
    <>
      {/* next/image negotiates AVIF/WebP and picks a width for the viewport
          (~70-280 KB at q90). The theme follows the system and the server
          cannot know it, so only one frame can take the preload: `priority`
          stays on the dark one, and the light one is eager with high fetch
          priority. The inline blur paints either field instantly. */}
      <Image
        className="hero-bg"
        src="/hero-space.webp"
        alt=""
        fill
        priority
        fetchPriority="high"
        sizes="100vw"
        quality={90}
        placeholder="blur"
        blurDataURL="data:image/webp;base64,UklGRnIAAABXRUJQVlA4IGYAAAAQBACdASoYAAoAPtFapEwoJSOiMAgBABoJZACdMoAKOILPbRUwIYbwsAD+/re+Pv0MN+A1bR7I/7yCzqImeck6gy0aV0OsD81MyQafLMicOSPnAvKKaENGBgRjKZhqKF8e1s+QAAA="
      />
      {/* Eager, not lazy: in dark mode this layer is invisible but still has to
          be decoded before a switch, or the fade would reveal a blur. */}
      <div className="hero-bg-light" data-theme-fade={switched || undefined}>
        <Image
          className="hero-bg"
          src="/hero-space-light.webp"
          alt=""
          fill
          loading="eager"
          fetchPriority="high"
          sizes="100vw"
          quality={90}
          placeholder="blur"
          blurDataURL="data:image/webp;base64,UklGRrwAAABXRUJQVlA4ILAAAACwBACdASoYAAoAPrVKoUqnJCMhsAgA4BaJaACdMoFWZjlG6Gm44gZ57c8sEUywAP7+s0t264aE6qfbqCcUjPS63d5Q5eqST+4+BsCASCMeFtZzi3q9oq8F25pii+Ihg/77uc1nokwPJzmvyRj+48Je+H/mVeXy3o4om2w+8vP31r+BkISDLcZh8oJsK2ecX8GOZluMdX/4b0WFjU5AtlOESCgspF1HJJArdGLVcfAAAA=="
        />
      </div>
    </>
  );
}
