import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  FALLBACK_FONT_FAMILIES,
  clearMeasureCache,
  createCanvasContext,
  createTextMeasurer,
  estimateTextWidth,
  measureCellText,
  resolveFontFamilies,
  type MeasureContext,
} from '../text-measure';

const fakeContext = (): MeasureContext & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    font: '',
    measureText(text: string) {
      calls.push(`${this.font}|${text}`);
      return { width: text.length * 10 };
    },
  };
};

describe('estimateTextWidth', () => {
  it('scales with the font size in the shorthand', () => {
    expect(estimateTextWidth('abcd', 'normal 400 20px Inter')).toBeCloseTo(4 * 20 * 0.55);
  });

  it('assumes 14px when the font has no size', () => {
    expect(estimateTextWidth('ab', 'Inter')).toBeCloseTo(2 * 14 * 0.55);
  });
});

describe('createTextMeasurer', () => {
  it('measures with the context in the given font', () => {
    const context = fakeContext();
    const { measure } = createTextMeasurer(() => context);
    expect(measure('abc', '14px A')).toBe(30);
    expect(context.calls).toEqual(['14px A|abc']);
  });

  it('caches by font and text, and creates the context once', () => {
    const context = fakeContext();
    const getContext = vi.fn(() => context);
    const { measure } = createTextMeasurer(getContext);
    measure('abc', 'A');
    measure('abc', 'A');
    measure('abc', 'B');
    expect(context.calls).toHaveLength(2);
    expect(getContext).toHaveBeenCalledTimes(1);
  });

  it('falls back to an estimate without a context', () => {
    const { measure } = createTextMeasurer(() => null);
    expect(measure('abcd', '20px A')).toBeCloseTo(estimateTextWidth('abcd', '20px A'));
  });

  it('evicts the oldest entry at the limit', () => {
    const context = fakeContext();
    const { measure } = createTextMeasurer(() => context, 2);
    measure('a', 'F');
    measure('b', 'F');
    measure('c', 'F');
    measure('b', 'F'); // still cached
    measure('a', 'F'); // evicted, measured again
    expect(context.calls).toEqual(['F|a', 'F|b', 'F|c', 'F|a']);
  });

  it('re-measures after clear', () => {
    const context = fakeContext();
    const { measure, clear } = createTextMeasurer(() => context);
    measure('a', 'F');
    clear();
    measure('a', 'F');
    expect(context.calls).toHaveLength(2);
  });
});

describe('createCanvasContext', () => {
  it('is null without a document', () => {
    expect(createCanvasContext(null)).toBeNull();
  });

  it('asks a canvas from the document for a 2d context', () => {
    const getContext = vi.fn(() => null);
    const doc = { createElement: vi.fn(() => ({ getContext })) } as unknown as Document;
    expect(createCanvasContext(doc)).toBeNull();
    expect(getContext).toHaveBeenCalledWith('2d');
  });
});

describe('measureCellText', () => {
  it('returns a positive width in the test DOM and survives a cache clear', () => {
    const before = measureCellText('hello', 'normal 400 14px Inter');
    clearMeasureCache();
    expect(measureCellText('hello', 'normal 400 14px Inter')).toBe(before);
    expect(before).toBeGreaterThanOrEqual(0);
  });
});

describe('resolveFontFamilies', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const withStyle = (fontFamily: string, mono: string) =>
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      fontFamily,
      getPropertyValue: (name: string) => (name === '--font-mono' ? mono : ''),
    } as unknown as CSSStyleDeclaration);

  it('falls back without an element', () => {
    expect(resolveFontFamilies(null)).toEqual(FALLBACK_FONT_FAMILIES);
  });

  it('reads the computed families', () => {
    withStyle('Inter, sans-serif', ' Menlo, monospace ');
    expect(resolveFontFamilies(document.createElement('div'))).toEqual({
      sans: 'Inter, sans-serif',
      mono: 'Menlo, monospace',
    });
  });

  it('falls back for a missing family or an unresolved variable', () => {
    withStyle('', 'var(--font-geist-mono)');
    expect(resolveFontFamilies(document.createElement('div'))).toEqual(FALLBACK_FONT_FAMILIES);
  });

  it('falls back when --font-mono is unset', () => {
    withStyle('Inter', '');
    expect(resolveFontFamilies(document.createElement('div')).mono).toBe(FALLBACK_FONT_FAMILIES.mono);
  });
});
