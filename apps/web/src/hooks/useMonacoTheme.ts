'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import type { Monaco } from '@monaco-editor/react';
import { getCssVar, resolveColor, withAlpha } from '@/lib/theme/css-color-resolution';

export function useMonacoTheme(monaco: Monaco | null): string {
  const { resolvedTheme } = useTheme();
  const [themeName, setThemeName] = useState(
    resolvedTheme === 'dark' ? 'vs-dark' : 'vs'
  );

  useEffect(() => {
    if (!monaco) return;

    const isDark = resolvedTheme === 'dark';
    const name = isDark ? 'pagespace-dark' : 'pagespace-light';
    const fallbackTheme = isDark ? 'vs-dark' : 'vs';

    const fallbackPalette = isDark
      ? {
          background: '#222222',
          foreground: '#f0f0f0',
          border: '#373737',
          muted: '#353535',
          mutedForeground: '#737373',
          primary: '#5b8cff',
          card: '#2b2b2b',
          input: '#373737',
        }
      : {
          background: '#ffffff',
          foreground: '#1f1f1f',
          border: '#d9d9d9',
          muted: '#f3f3f3',
          mutedForeground: '#7a7a7a',
          primary: '#3f6dff',
          card: '#ffffff',
          input: '#f8f8f8',
        };

    const bg = resolveColor(getCssVar('--background'), fallbackPalette.background);
    const fg = resolveColor(getCssVar('--foreground'), fallbackPalette.foreground);
    const border = resolveColor(getCssVar('--border'), fallbackPalette.border);
    const muted = resolveColor(getCssVar('--muted'), fallbackPalette.muted);
    const mutedForeground = resolveColor(getCssVar('--muted-foreground'), fallbackPalette.mutedForeground);
    const card = resolveColor(getCssVar('--card'), fallbackPalette.card);
    const input = resolveColor(getCssVar('--input'), fallbackPalette.input);
    const primary = resolveColor(getCssVar('--primary'), fallbackPalette.primary);

    try {
      monaco.editor.defineTheme(name, {
        base: fallbackTheme,
        inherit: true,
        rules: [],
        colors: {
          'editor.background': bg,
          'editor.foreground': fg,
          'editor.lineHighlightBackground': isDark ? '#00000000' : muted,
          'editor.lineHighlightBorder': isDark ? '#00000000' : border,
          'editorLineNumber.foreground': mutedForeground,
          'editorGutter.background': bg,
          'minimap.background': bg,
          'editor.selectionBackground': isDark
            ? withAlpha(primary, 0.25, fallbackPalette.primary)
            : withAlpha(primary, 0.20, fallbackPalette.primary),
          'editorWidget.background': card,
          'editorWidget.border': border,
          'input.background': input,
          'input.border': border,
        },
      });
      setThemeName(name);
    } catch (error) {
      console.error('Failed to define Monaco theme, falling back to default theme:', error);
      setThemeName(fallbackTheme);
    }
  }, [monaco, resolvedTheme]);

  return themeName;
}
