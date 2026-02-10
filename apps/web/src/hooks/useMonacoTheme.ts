'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import type { Monaco } from '@monaco-editor/react';

function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function byteToHex(value: number): string {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
}

function normalizeHexColor(value: string): string | null {
  const normalized = value.trim().toLowerCase();

  if (/^#[0-9a-f]{6}$/.test(normalized) || /^#[0-9a-f]{8}$/.test(normalized)) {
    return normalized;
  }

  if (/^#[0-9a-f]{3}$/.test(normalized)) {
    const r = normalized[1];
    const g = normalized[2];
    const b = normalized[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }

  if (/^#[0-9a-f]{4}$/.test(normalized)) {
    const r = normalized[1];
    const g = normalized[2];
    const b = normalized[3];
    const a = normalized[4];
    return `#${r}${r}${g}${g}${b}${b}${a}${a}`;
  }

  return null;
}

function parseRgbChannel(value: string): number | null {
  const channel = value.trim();
  if (channel.endsWith('%')) {
    const percent = Number.parseFloat(channel.slice(0, -1));
    if (!Number.isFinite(percent)) return null;
    return clamp((percent / 100) * 255, 0, 255);
  }

  const numeric = Number.parseFloat(channel);
  if (!Number.isFinite(numeric)) return null;
  return clamp(numeric, 0, 255);
}

function parseAlphaChannel(value: string): number | null {
  const alpha = value.trim();
  if (alpha.endsWith('%')) {
    const percent = Number.parseFloat(alpha.slice(0, -1));
    if (!Number.isFinite(percent)) return null;
    return clamp(percent / 100, 0, 1);
  }

  const numeric = Number.parseFloat(alpha);
  if (!Number.isFinite(numeric)) return null;
  return clamp(numeric, 0, 1);
}

function parseRgbLikeColorToHex(value: string): string | null {
  const input = value.trim();
  const match = input.match(/^rgba?\((.*)\)$/i);
  if (!match) return null;

  const content = match[1].trim();
  let rgbParts: string[] = [];
  let alphaPart: string | undefined;

  if (content.includes(',')) {
    const parts = content.split(',').map((part) => part.trim());
    if (parts.length < 3) return null;
    rgbParts = parts.slice(0, 3);
    alphaPart = parts[3];
  } else {
    const slashParts = content.split('/');
    const rgbTokens = slashParts[0]?.trim().split(/\s+/) ?? [];
    if (rgbTokens.length < 3) return null;
    rgbParts = rgbTokens.slice(0, 3);
    alphaPart = slashParts[1]?.trim();
  }

  const r = parseRgbChannel(rgbParts[0] ?? '');
  const g = parseRgbChannel(rgbParts[1] ?? '');
  const b = parseRgbChannel(rgbParts[2] ?? '');
  if (r === null || g === null || b === null) return null;

  const a = alphaPart ? parseAlphaChannel(alphaPart) : 1;
  if (a === null) return null;

  const alphaHex = a < 1 ? byteToHex(a * 255) : '';
  return `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}${alphaHex}`;
}

function getComputedColorValue(cssValue: string): string | null {
  const probe = document.createElement('span');
  probe.style.color = '';
  probe.style.color = cssValue;

  if (!probe.style.color) {
    return null;
  }

  probe.style.display = 'none';
  const parent = document.body ?? document.documentElement;
  parent.appendChild(probe);
  const computed = getComputedStyle(probe).color.trim();
  probe.remove();

  return computed || null;
}

function resolveColor(cssValue: string, fallback: string): string {
  const fallbackHex = normalizeHexColor(fallback) ?? '#000000';

  if (!cssValue) {
    return fallbackHex;
  }

  const directHex = normalizeHexColor(cssValue);
  if (directHex) {
    return directHex;
  }

  const directRgbHex = parseRgbLikeColorToHex(cssValue);
  if (directRgbHex) {
    return directRgbHex;
  }

  const computed = getComputedColorValue(cssValue);
  if (computed) {
    const computedHex = normalizeHexColor(computed) ?? parseRgbLikeColorToHex(computed);
    if (computedHex) {
      return computedHex;
    }
  }

  return fallbackHex;
}

function withAlpha(color: string, alpha: number, fallback: string): string {
  const resolved = resolveColor(color, fallback);
  const normalized = normalizeHexColor(resolved) ?? normalizeHexColor(fallback) ?? '#000000';

  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  const a = byteToHex(clamp(alpha, 0, 1) * 255);

  return `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}${a}`;
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
    const fallbackTheme = isDark ? 'vs-dark' : 'vs';

    const fallbackPalette = isDark
      ? {
          background: '#262626',
          foreground: '#f0f0f0',
          border: '#404040',
          muted: '#2e2e2e',
          mutedForeground: '#8f8f8f',
          primary: '#5b8cff',
          card: '#1f1f1f',
          input: '#303030',
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
          'editor.lineHighlightBackground': muted,
          'editorLineNumber.foreground': mutedForeground,
          'editorGutter.background': bg,
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
