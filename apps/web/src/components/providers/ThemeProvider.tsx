"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import { type ThemeProviderProps } from "next-themes";
import { syncThemeToCookie, getThemeFromCookie } from "@/lib/theme-cookie";

function ThemeCookieSync() {
  const { theme, setTheme } = useTheme();

  React.useEffect(() => {
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
