"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import { syncThemeToCookie, getThemeFromCookie } from "@/lib/theme-cookie";
import { applyThemeColor } from "@/lib/theme-color";

type ThemeProviderProps = React.ComponentProps<typeof NextThemesProvider>;

function ThemeCookieSync() {
  const { theme, setTheme } = useTheme();

  React.useEffect(() => {
    // Bootstrap from cookie if localStorage has no theme yet
    const stored = localStorage.getItem("theme");
    if (!stored) {
      const cookieTheme = getThemeFromCookie();
      if (cookieTheme) {
        setTheme(cookieTheme);
      }
    }
  }, [setTheme]);

  React.useEffect(() => {
    if (theme && theme !== "system") {
      syncThemeToCookie(theme);
    }
  }, [theme]);

  return null;
}

/** Keeps the browser chrome colour on the resolved theme, not just the OS scheme. */
function ThemeColorSync() {
  const { resolvedTheme } = useTheme();

  React.useEffect(() => {
    applyThemeColor(
      document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
      resolvedTheme,
    );
  }, [resolvedTheme]);

  return null;
}

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider {...props}>
      <ThemeCookieSync />
      <ThemeColorSync />
      {children}
    </NextThemesProvider>
  );
}
