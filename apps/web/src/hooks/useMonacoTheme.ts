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

function withAlpha(color: string, alpha: number): string {
  const resolved = resolveColor(color);
  if (resolved.startsWith('#')) {
    const hex = Math.round(alpha * 255).toString(16).padStart(2, '0');
    return resolved + hex;
  }
  const match = resolved.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (match) {
    return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
  }
  return resolved;
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
        'editor.selectionBackground': isDark
          ? withAlpha(getCssVar('--primary'), 0.25)
          : withAlpha(getCssVar('--primary'), 0.20),
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
