import { describe, expect, it } from 'vitest';
import { ANCHOR_CONTEXT_LENGTH, createAnchor, hashText } from '../anchor';

const TEXT = 'The quick brown fox jumps over the lazy dog. The end of the tale.';
const QUOTE = 'jumps over';
const START = TEXT.indexOf(QUOTE);
const END = START + QUOTE.length;

describe('createAnchor', () => {
  it('captures the quote plus bounded context on both sides', () => {
    const anchor = createAnchor(TEXT, START, END, { revision: 7 });

    expect(anchor.v).toBe(1);
    expect(anchor.exact).toBe(QUOTE);
    expect(anchor.start).toBe(START);
    expect(anchor.end).toBe(END);
    expect(anchor.revision).toBe(7);
    expect(anchor.prefix).toBe(TEXT.slice(Math.max(0, START - ANCHOR_CONTEXT_LENGTH), START));
    expect(anchor.suffix).toBe(TEXT.slice(END, END + ANCHOR_CONTEXT_LENGTH));
    expect(anchor.prefix.length).toBeLessThanOrEqual(ANCHOR_CONTEXT_LENGTH);
    expect(anchor.suffix.length).toBeLessThanOrEqual(ANCHOR_CONTEXT_LENGTH);
    expect(anchor.textHash).toBe(hashText(TEXT));
  });

  it('truncates context at the document edges instead of over-reading', () => {
    const anchor = createAnchor(TEXT, 0, 3, { revision: 1 });
    expect(anchor.prefix).toBe('');
    expect(anchor.exact).toBe('The');

    const tail = createAnchor(TEXT, TEXT.length - 5, TEXT.length, { revision: 1 });
    expect(tail.suffix).toBe('');
  });

  it('clamps out-of-range offsets and normalises a reversed selection', () => {
    expect(createAnchor(TEXT, -50, 3, { revision: 1 }).start).toBe(0);
    expect(createAnchor(TEXT, 0, TEXT.length + 500, { revision: 1 }).end).toBe(TEXT.length);

    const reversed = createAnchor(TEXT, END, START, { revision: 1 });
    expect(reversed.start).toBe(START);
    expect(reversed.end).toBe(END);
    expect(reversed.exact).toBe(QUOTE);

    const nonFinite = createAnchor(TEXT, Number.NaN, Number.POSITIVE_INFINITY, { revision: 1 });
    expect(nonFinite.start).toBe(0);
    expect(nonFinite.end).toBe(TEXT.length);

    const fractional = createAnchor(TEXT, 4.9, 9.9, { revision: 1 });
    expect(fractional.start).toBe(4);
    expect(fractional.end).toBe(9);
  });

  it('supports a zero-length (caret) anchor', () => {
    const caret = createAnchor(TEXT, START, START, { revision: 2 });
    expect(caret.exact).toBe('');
    expect(caret.start).toBe(caret.end);
  });
});

describe('hashText', () => {
  it('is stable, fixed-width, and sensitive to every character', () => {
    expect(hashText(TEXT)).toBe(hashText(TEXT));
    expect(hashText('')).toHaveLength(16);
    expect(hashText(TEXT)).toMatch(/^[0-9a-f]{16}$/);
    expect(hashText('abc')).not.toBe(hashText('abd'));
    expect(hashText('ab')).not.toBe(hashText('ba'));
    // Non-ASCII must survive: the projection is not ASCII-only.
    expect(hashText('café 日本語 🙂')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashText('café')).not.toBe(hashText('cafe'));
  });
});
