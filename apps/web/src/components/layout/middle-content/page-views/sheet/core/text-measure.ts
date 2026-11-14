/**
 * The browser side of `MeasureText`: one shared offscreen canvas, with widths
 * cached because the same strings are measured on every render (spill) and on
 * every sheet change (auto row height).
 */

import type { MeasureText } from './text-layout';

const CACHE_LIMIT = 5000;
const cache = new Map<string, number>();
let context: CanvasRenderingContext2D | null | undefined;

const getContext = (): CanvasRenderingContext2D | null => {
  if (context !== undefined) return context;
  context =
    typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  return context;
};

/** Rough fallback for environments with no canvas (SSR, jsdom). */
const estimate = (text: string, font: string): number => {
  const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 14);
  return text.length * size * 0.55;
};

export const measureCellText: MeasureText = (text, font) => {
  const key = `${font}|${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const ctx = getContext();
  let width: number;
  if (ctx) {
    ctx.font = font;
    width = ctx.measureText(text).width;
  } else {
    width = estimate(text, font);
  }

  // Drop the oldest entry rather than clearing, so a long session does not
  // periodically re-measure everything at once.
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, width);
  return width;
};

/**
 * Forget every cached width. Called once web fonts finish loading: anything
 * measured before then was measured in the fallback face.
 */
export const clearMeasureCache = (): void => {
  cache.clear();
};

/**
 * Font families as the canvas needs them. Canvas cannot resolve CSS custom
 * properties, so they are read from computed styles of the grid itself.
 */
export const resolveFontFamilies = (element: HTMLElement | null): { sans: string; mono: string } => {
  const fallback = { sans: 'system-ui, sans-serif', mono: 'ui-monospace, monospace' };
  if (!element || typeof window === 'undefined') return fallback;
  const sans = window.getComputedStyle(element).fontFamily || fallback.sans;
  const mono =
    window.getComputedStyle(element).getPropertyValue('--font-mono').trim();
  // A custom property can itself hold `var(...)`, which canvas cannot read.
  return { sans, mono: mono && !mono.includes('var(') ? mono : fallback.mono };
};
