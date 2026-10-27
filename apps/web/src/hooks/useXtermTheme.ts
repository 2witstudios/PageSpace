'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import type { ITheme } from '@xterm/xterm';
import { getCssVar, resolveColor, withAlpha, THEME_FALLBACK } from '@/lib/theme/css-color-resolution';

/**
 * Curated, low-contrast ANSI palettes — no ANSI-color design tokens exist in
 * globals.css, so these are muted constants (not raw CSS-var lookups) tuned
 * to read as intentionally quiet rather than a raw default xterm palette.
 */
const MUTED_ANSI_DARK = {
  black: '#3b3f46',
  red: '#c97b7b',
  green: '#8fae83',
  yellow: '#c9b17a',
  blue: '#7b93b8',
  magenta: '#a688a8',
  cyan: '#7fa8a3',
  white: '#c7c7c7',
  brightBlack: '#5c6370',
  brightRed: '#e0a0a0',
  brightGreen: '#a8c99a',
  brightYellow: '#e0c896',
  brightBlue: '#9bb4d6',
  brightMagenta: '#c2a3c2',
  brightCyan: '#9ecac4',
  brightWhite: '#e8e8e8',
} as const;

const MUTED_ANSI_LIGHT = {
  black: '#5c5f66',
  red: '#a85d5d',
  green: '#5f7a56',
  yellow: '#93793f',
  blue: '#4f668c',
  magenta: '#805f80',
  cyan: '#4f7d78',
  white: '#6b6b6b',
  brightBlack: '#8a8d94',
  brightRed: '#bf7373',
  brightGreen: '#79966d',
  brightYellow: '#ab9058',
  brightBlue: '#6785ab',
  brightMagenta: '#987298',
  brightCyan: '#6d9a94',
  brightWhite: '#3a3a3a',
} as const;

function buildFallbackTheme(isDark: boolean): ITheme {
  const fallback = isDark ? THEME_FALLBACK.dark : THEME_FALLBACK.light;
  const ansi = isDark ? MUTED_ANSI_DARK : MUTED_ANSI_LIGHT;
  return {
    background: fallback.background,
    foreground: fallback.foreground,
    cursor: fallback.primary,
    cursorAccent: fallback.background,
    selectionBackground: `${fallback.primary}40`,
    ...ansi,
  };
}

function resolveTheme(isDark: boolean): ITheme {
  const fallback = isDark ? THEME_FALLBACK.dark : THEME_FALLBACK.light;
  const ansi = isDark ? MUTED_ANSI_DARK : MUTED_ANSI_LIGHT;

  const background = resolveColor(getCssVar('--background'), fallback.background);
  const foreground = resolveColor(getCssVar('--foreground'), fallback.foreground);
  const primary = resolveColor(getCssVar('--primary'), fallback.primary);

  return {
    background,
    foreground,
    cursor: primary,
    cursorAccent: background,
    selectionBackground: withAlpha(primary, isDark ? 0.3 : 0.2, fallback.primary),
    ...ansi,
  };
}

/** Reactive to next-themes' resolvedTheme, same pattern as useMonacoTheme. */
export function useXtermTheme(): ITheme {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const [theme, setTheme] = useState<ITheme>(() => buildFallbackTheme(isDark));

  useEffect(() => {
    setTheme(resolveTheme(isDark));
  }, [isDark]);

  return theme;
}
