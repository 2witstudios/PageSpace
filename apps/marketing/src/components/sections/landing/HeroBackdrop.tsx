"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { HeroPicture } from "@/components/HeroPicture";

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
      {/* Both frames are prebuilt variants (see HeroPicture), sized to the
          viewport. The theme follows the system and the server cannot know it,
          so only one frame can take the preload: the dark one keeps it, and
          both load eagerly at high priority. In dark mode the light layer is
          invisible but still has to be decoded before a switch, or the fade
          would reveal a blur. */}
      <HeroPicture frame="dark" className="hero-bg" sizes="100vw" preloadAvif />
      <div className="hero-bg-light" data-theme-fade={switched || undefined}>
        <HeroPicture frame="light" className="hero-bg" sizes="100vw" />
      </div>
    </>
  );
}
