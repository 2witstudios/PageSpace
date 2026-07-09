/**
 * CSS custom-property color resolution.
 *
 * Design tokens are defined as CSS custom properties (oklch, rgb, etc.) —
 * consumers that need a concrete hex string (Monaco theme colors, xterm
 * ITheme) resolve them through this pipeline: try a fast direct parse first,
 * then fall back to asking the browser (CSS.supports + canvas fill, then a
 * hidden-element computed-style probe) for anything the fast paths can't
 * parse themselves (oklch, color-mix, named colors, etc.).
 */

/**
 * Shared light/dark fallback swatches — used when a CSS custom property is
 * missing or fails to resolve (e.g. before the stylesheet loads). Kept in
 * one place so Monaco and xterm's themes can't silently drift apart on a
 * future rebrand.
 */
export const THEME_FALLBACK = {
  dark: { background: '#222222', foreground: '#f0f0f0', primary: '#5b8cff' },
  light: { background: '#ffffff', foreground: '#1f1f1f', primary: '#3f6dff' },
} as const;

let colorResolveContext: CanvasRenderingContext2D | null | undefined;

export function getCssVar(name: string): string {
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

function getColorResolveContext(): CanvasRenderingContext2D | null {
  if (colorResolveContext !== undefined) {
    return colorResolveContext;
  }

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  colorResolveContext = canvas.getContext('2d', { willReadFrequently: true });
  return colorResolveContext;
}

function parseCssColorToHex(value: string): string | null {
  const input = value.trim();
  if (!input || typeof window === 'undefined') {
    return null;
  }

  if (!('CSS' in window) || typeof window.CSS.supports !== 'function') {
    return null;
  }

  if (!window.CSS.supports('color', input)) {
    return null;
  }

  const context = getColorResolveContext();
  if (!context) {
    return null;
  }

  context.clearRect(0, 0, 1, 1);
  context.fillStyle = 'rgba(0, 0, 0, 0)';
  const sentinel = context.fillStyle;
  context.fillStyle = input;
  if (context.fillStyle === sentinel) {
    // CSS.supports() can accept syntax the canvas 2D fillStyle parser still
    // rejects — an invalid assignment is silently ignored, leaving fillStyle
    // on the transparent sentinel. Without this check that read as a valid
    // "transparent black" result instead of a failed parse, so fall through
    // to the computed-style probe instead.
    return null;
  }
  context.fillRect(0, 0, 1, 1);

  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  const alphaHex = a < 255 ? byteToHex(a) : '';
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

export function resolveColor(cssValue: string, fallback: string): string {
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

  const cssHex = parseCssColorToHex(cssValue);
  if (cssHex) {
    return cssHex;
  }

  const computed = getComputedColorValue(cssValue);
  if (computed) {
    const computedHex =
      normalizeHexColor(computed) ??
      parseRgbLikeColorToHex(computed) ??
      parseCssColorToHex(computed);
    if (computedHex) {
      return computedHex;
    }
  }

  return fallbackHex;
}

export function withAlpha(color: string, alpha: number, fallback: string): string {
  const resolved = resolveColor(color, fallback);
  const normalized = normalizeHexColor(resolved) ?? normalizeHexColor(fallback) ?? '#000000';

  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  const a = byteToHex(clamp(alpha, 0, 1) * 255);

  return `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}${a}`;
}
