'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import type { ITheme } from '@xterm/xterm';
import { getCssVar, resolveColor, withAlpha } from '@/lib/theme/css-color-resolution';

/** No ANSI-color CSS vars exist in the codebase — this is new design surface.
 * Curated low-contrast palettes (not stock xterm ANSI) so terminal output
 * reads as muted/native rather than the default green-tinted xterm look. */
const ANSI_PALETTE: Record<'dark' | 'light', Omit<ITheme, 'background' | 'foreground' | 'cursor' | 'cursorAccent' | 'selectionBackground'>> = {
  dark: {
    black: '#2b2b2b',
    red: '#c2685f',
    green: '#7a9e78',
    yellow: '#bfa15e',
    blue: '#6b8cae',
    magenta: '#9c7bab',
    cyan: '#6b9fa0',
    white: '#c9c9c9',
    brightBlack: '#5c5c5c',
    brightRed: '#d99189',
    brightGreen: '#9dc19a',
    brightYellow: '#d9c07f',
    brightBlue: '#8fb0d1',
    brightMagenta: '#bda0cb',
    brightCyan: '#8fc0c1',
    brightWhite: '#f0f0f0',
  },
  light: {
    black: '#3a3a3a',
    red: '#a8443c',
    green: '#4c7a4a',
    yellow: '#8a6d23',
    blue: '#3f6188',
    magenta: '#7a5586',
    cyan: '#3f7a7c',
    white: '#7a7a7a',
    brightBlack: '#5c5c5c',
    brightRed: '#c25f56',
    brightGreen: '#6c9c69',
    brightYellow: '#a6883a',
    brightBlue: '#5a7fa8',
    brightMagenta: '#9876a3',
    brightCyan: '#5a9b9c',
    brightWhite: '#1f1f1f',
  },
};

const FALLBACK_PALETTE = {
  dark: {
    background: '#222222',
    foreground: '#f0f0f0',
    border: '#373737',
    primary: '#5b8cff',
  },
  light: {
    background: '#ffffff',
    foreground: '#1f1f1f',
    border: '#d9d9d9',
    primary: '#3f6dff',
  },
};

/** Reactive to `next-themes`' `resolvedTheme` — same effect-on-dependency
 * pattern as `useMonacoTheme`, mapping our design tokens onto xterm's
 * `ITheme` shape instead of a Monaco color map. */
export function useXtermTheme(): ITheme {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const fallback = isDark ? FALLBACK_PALETTE.dark : FALLBACK_PALETTE.light;
  const ansi = isDark ? ANSI_PALETTE.dark : ANSI_PALETTE.light;

  const [theme, setTheme] = useState<ITheme>(() => ({
    background: fallback.background,
    foreground: fallback.foreground,
    cursor: fallback.primary,
    cursorAccent: fallback.background,
    selectionBackground: fallback.border,
    ...ansi,
  }));

  useEffect(() => {
    const background = resolveColor(getCssVar('--background'), fallback.background);
    const foreground = resolveColor(getCssVar('--foreground'), fallback.foreground);
    const primary = resolveColor(getCssVar('--primary'), fallback.primary);

    setTheme({
      background,
      foreground,
      cursor: primary,
      cursorAccent: background,
      selectionBackground: withAlpha(primary, isDark ? 0.25 : 0.20, fallback.primary),
      ...ansi,
    });
  // ansi/fallback are derived purely from isDark, which is derived from
  // resolvedTheme — including them would be redundant with resolvedTheme and
  // (being freshly-constructed objects) would re-run the effect every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTheme]);

  return theme;
}
