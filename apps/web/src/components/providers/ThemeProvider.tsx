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
// changed. Nudge a reflow on those elements whenever <html>'s theme class
// actually changes, so Safari is forced to repaint them.
//
// A MutationObserver (rather than a React effect on `resolvedTheme`) is
// deliberate: React flushes this child's effects *before* next-themes'
// provider effect mutates <html class>, so an effect here would force the
// reflow while the old class was still applied and fix nothing. Observing
// the DOM fires strictly after the class change, and also covers switches
// React never initiates (OS theme change, `storage` events from other tabs).
function GlassRepaintFix() {
  React.useEffect(() => {
    const html = document.documentElement;
    let wasDark = html.classList.contains("dark");
    const observer = new MutationObserver(() => {
      const isDark = html.classList.contains("dark");
      if (isDark === wasDark) return;
      wasDark = isDark;
      document.querySelectorAll<HTMLElement>(GLASS_SELECTOR).forEach((el) => {
        const prevTransform = el.style.transform;
        el.style.transform = "translateZ(0.01px)";
        void el.offsetHeight;
        el.style.transform = prevTransform;
      });
    });
    observer.observe(html, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

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
    // Defer the check one frame: this child effect runs before next-themes'
    // provider effect has applied the new class to <html>, so a synchronous
    // read would report a "mismatch" on every legitimate toggle.
    const frame = requestAnimationFrame(() => {
      const hasDarkClass = document.documentElement.classList.contains("dark");
      const expectedDark = resolvedTheme === "dark";
      if (hasDarkClass !== expectedDark) {
        console.warn(
          "[theme] <html> class is out of sync with resolvedTheme — UI may look stuck in the wrong theme until the next toggle.",
          { resolvedTheme, hasDarkClass }
        );
      }
    });
    return () => cancelAnimationFrame(frame);
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
