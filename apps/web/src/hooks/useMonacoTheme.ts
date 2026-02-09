import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import type { Monaco } from '@monaco-editor/react';

let _ctx: CanvasRenderingContext2D | null = null;
function getCanvasContext(): CanvasRenderingContext2D {
  if (!_ctx) {
    _ctx = document.createElement('canvas').getContext('2d');
  }
  if (!_ctx) throw new Error('Canvas 2D context unavailable');
  return _ctx;
}

function resolveColor(cssValue: string): string {
  const ctx = getCanvasContext();
  ctx.fillStyle = cssValue;
  return ctx.fillStyle;
}

function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function useMonacoTheme(monaco: Monaco | null): string {
  const { resolvedTheme } = useTheme();
  const [themeName, setThemeName] = useState(
    resolvedTheme === 'dark' ? 'vs-dark' : 'vs'
  );

  useEffect(() => {
    if (!monaco) return;

    const isDark = resolvedTheme === 'dark';
    const name = isDark ? 'pagespace-dark' : 'pagespace-light';

    const bg = resolveColor(getCssVar('--background'));
    const fg = resolveColor(getCssVar('--foreground'));
    const border = resolveColor(getCssVar('--border'));
    const muted = resolveColor(getCssVar('--muted'));

    monaco.editor.defineTheme(name, {
      base: isDark ? 'vs-dark' : 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': bg,
        'editor.foreground': fg,
        'editor.lineHighlightBackground': muted,
        'editorLineNumber.foreground': resolveColor(getCssVar('--muted-foreground')),
        'editorGutter.background': bg,
        // ctx.fillStyle normalizes to 6-digit hex (#rrggbb), so appending
        // '40'/'33' produces valid 8-digit hex with alpha
        'editor.selectionBackground': isDark
          ? resolveColor(getCssVar('--primary')) + '40'   // 25% opacity
          : resolveColor(getCssVar('--primary')) + '33',  // 20% opacity
        'editorWidget.background': resolveColor(getCssVar('--card')),
        'editorWidget.border': border,
        'input.background': resolveColor(getCssVar('--input')),
        'input.border': border,
      },
    });

    setThemeName(name);
  }, [monaco, resolvedTheme]);

  return themeName;
}
