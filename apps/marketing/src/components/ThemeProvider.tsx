"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import { syncThemeToCookie, getThemeFromCookie } from "@/lib/theme-cookie";

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

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider {...props}>
      <ThemeCookieSync />
      {children}
    </NextThemesProvider>
  );
}
