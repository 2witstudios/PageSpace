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
//
// The cookie is a strict mirror of next-themes' state, "system" included.
// Skipping "system" would leave a stale "dark"/"light" cookie behind when a
// user switches back to system: the server would then paint the stale theme
// and the client would flip it after hydration — the exact post-paint switch
// this PR removes. (layout.tsx treats any value other than "dark"/"light"
// as "no explicit theme".)
//
// localStorage is mirrored too: when the theme came from the cookie alone
// (fresh device via defaultTheme, see layout.tsx), next-themes never writes
// its storage key — only setTheme does — and Safari's ITP expires
// script-written cookies after ~7 days, so without this the preference
// would silently reset. Writing storage directly is invisible, unlike the
// setTheme call this PR removed.
const THEME_STORAGE_KEY = "theme"; // next-themes' default storageKey

function ThemeCookieSync() {
  const { theme } = useTheme();

  React.useEffect(() => {
    if (!theme) return;
    syncThemeToCookie(theme);
    try {
      if (localStorage.getItem(THEME_STORAGE_KEY) !== theme) {
        localStorage.setItem(THEME_STORAGE_KEY, theme);
      }
    } catch {
      // Storage unavailable (private mode / blocked) — cookie still covers us.
    }
  }, [theme]);

  return null;
}

// Attribute match rather than an explicit class list so future glass
// variants added in globals.css are covered without touching this file.
const GLASS_SELECTOR = '[class*="liquid-glass-"]';

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
    let restore: (() => void) | null = null;
    let frame = 0;

    const observer = new MutationObserver(() => {
      const isDark = html.classList.contains("dark");
      if (isDark === wasDark) return;
      wasDark = isDark;
      // Finish any in-flight nudge first so we never capture our own
      // perturbed transform as the value to restore.
      if (restore) {
        cancelAnimationFrame(frame);
        restore();
      }
      const els = Array.from(
        document.querySelectorAll<HTMLElement>(GLASS_SELECTOR)
      );
      const prevTransforms = els.map((el) => el.style.transform);
      els.forEach((el) => {
        el.style.transform = "translateZ(0.01px)";
      });
      restore = () => {
        els.forEach((el, i) => {
          el.style.transform = prevTransforms[i];
        });
        restore = null;
      };
      // Restore on the next frame, not synchronously: transform is
      // layout-inert, so a same-task set-and-restore is a net style no-op by
      // paint time and the compositor may skip the recomposite entirely. The
      // perturbed value must survive to one real paint. (translateZ has no
      // visual effect without perspective, so the held frame is invisible.)
      frame = requestAnimationFrame(restore);
    });
    observer.observe(html, { attributes: true, attributeFilter: ["class"] });
    return () => {
      observer.disconnect();
      if (restore) {
        cancelAnimationFrame(frame);
        restore();
      }
    };
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
