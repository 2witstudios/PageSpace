/**
 * The browser side of `MeasureText`: one shared offscreen canvas, with widths
 * cached because the same strings are measured on every render (spill) and on
 * every sheet change (auto row height).
 */

import type { MeasureText } from './text-layout';

const CACHE_LIMIT = 5000;

/** The slice of `CanvasRenderingContext2D` measurement needs. */
export interface MeasureContext {
  font: string;
  measureText: (text: string) => { width: number };
}

/** Rough fallback for environments with no canvas (SSR, jsdom). */
export const estimateTextWidth: MeasureText = (text, font) => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 14);
  return text.length * size * 0.55;
};

/**
 * A caching measurer over a lazily created context. The context is created on
 * first use, not at import, so importing this on the server is harmless.
 */
export const createTextMeasurer = (
  getContext: () => MeasureContext | null,
  cacheLimit: number = CACHE_LIMIT,
): { measure: MeasureText; clear: () => void } => {
  const cache = new Map<string, number>();
  let context: MeasureContext | null | undefined;

  const measure: MeasureText = (text, font) => {
    const key = `${font}|${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    if (context === undefined) context = getContext();
    let width: number;
    if (context) {
      context.font = font;
      width = context.measureText(text).width;
    } else {
      width = estimateTextWidth(text, font);
    }

    // Drop the oldest entry rather than clearing, so a long session does not
    // periodically re-measure everything at once.
    if (cache.size >= cacheLimit) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, width);
    return width;
  };

  return { measure, clear: () => cache.clear() };
};

/** A 2D context from a fresh canvas, or null where there is no DOM. */
export const createCanvasContext = (
  doc: Document | null = globalThis.document,
): MeasureContext | null => (doc ? doc.createElement('canvas').getContext('2d') : null);

const shared = createTextMeasurer(() => createCanvasContext());

export const measureCellText: MeasureText = shared.measure;

/**
 * Forget every cached width. Called once web fonts finish loading: anything
 * measured before then was measured in the fallback face.
 */
export const clearMeasureCache = (): void => shared.clear();

export const FALLBACK_FONT_FAMILIES = {
  sans: 'system-ui, sans-serif',
  mono: 'ui-monospace, monospace',
} as const;

/**
 * Font families as the canvas needs them. Canvas cannot resolve CSS custom
 * properties, so they are read from computed styles of the grid itself.
 */
export const resolveFontFamilies = (element: HTMLElement | null): { sans: string; mono: string } => {
  if (!element) return { ...FALLBACK_FONT_FAMILIES };
  const style = getComputedStyle(element);
  const sans = style.fontFamily || FALLBACK_FONT_FAMILIES.sans;
  const mono = style.getPropertyValue('--font-mono').trim();
  // A custom property can itself hold `var(...)`, which canvas cannot read.
  return { sans, mono: mono && !mono.includes('var(') ? mono : FALLBACK_FONT_FAMILIES.mono };
};
