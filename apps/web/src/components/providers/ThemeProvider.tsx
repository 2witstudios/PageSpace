"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import { type ThemeProviderProps } from "next-themes";
import { syncThemeToCookie } from "@/lib/theme-cookie";

// Theme resolution now happens once, before paint: the server reads the
// `theme` cookie and passes it as `defaultTheme` (see layout.tsx), so
// next-themes' own pre-hydration script resolves the right theme on the
// first pass. Writing the cookie back on change is all this needs to do —
// it must NOT call `setTheme` after mount, since that's a real, visible
// theme switch (not just a settle) and mobile WebKit can fail to repaint
// `backdrop-filter` surfaces (e.g. the navbar) when it happens — see
// GlassRepaintFix below.
function ThemeCookieSync() {
  const { theme } = useTheme();

  React.useEffect(() => {
    if (theme && theme !== "system") {
      syncThemeToCookie(theme);
    }
  }, [theme]);

  return null;
}

const GLASS_SELECTOR =
  ".liquid-glass-thin, .liquid-glass-regular, .liquid-glass-thick";

// Mobile WebKit has a known bug: elements combining `position: sticky` with
// `backdrop-filter` (our "liquid glass" surfaces — the navbar is the one
// users have reported this on) can keep painting the previous theme's
// background after `.dark` toggles on <html>, since the compositor doesn't
// always know to recomposite a blurred layer when only the color underneath
// changed. Nudge a reflow on those elements whenever the resolved theme
// actually changes, so Safari is forced to repaint them.
function GlassRepaintFix() {
  const { resolvedTheme } = useTheme();
  const hasMounted = React.useRef(false);

  React.useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }
    document.querySelectorAll<HTMLElement>(GLASS_SELECTOR).forEach((el) => {
      const prevTransform = el.style.transform;
      el.style.transform = "translateZ(0.01px)";
      void el.offsetHeight;
      el.style.transform = prevTransform;
    });
  }, [resolvedTheme]);

  return null;
}

// Instrumentation for the reported "navbar stuck in the wrong theme" bug: if
// <html>'s class ever drifts from what next-themes thinks the resolved theme
// is, log it so a future report comes with the data needed to pin down the
// cause instead of "couldn't reproduce".
function ThemeMismatchGuard() {
  const { resolvedTheme } = useTheme();

  React.useEffect(() => {
    if (!resolvedTheme) return;
    const hasDarkClass = document.documentElement.classList.contains("dark");
    const expectedDark = resolvedTheme === "dark";
    if (hasDarkClass !== expectedDark) {
      console.warn(
        "[theme] <html> class is out of sync with resolvedTheme — UI may look stuck in the wrong theme until the next toggle.",
        { resolvedTheme, hasDarkClass }
      );
    }
  }, [resolvedTheme]);

  return null;
}

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider {...props}>
      <ThemeCookieSync />
      <GlassRepaintFix />
      <ThemeMismatchGuard />
      {children}
    </NextThemesProvider>
  );
}
