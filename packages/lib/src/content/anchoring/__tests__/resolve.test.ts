import { describe, expect, it } from 'vitest';
import { createAnchor } from '../anchor';
import { FUZZY_SIMILARITY_FLOOR, resolveAnchor, textSimilarity } from '../resolve';
import type { AnchorResolution } from '../types';

const DOC = 'The quick brown fox jumps over the lazy dog. The end of the tale.';
const QUOTE = 'jumps over';
const START = DOC.indexOf(QUOTE);
const END = START + QUOTE.length;

const ANCHOR = createAnchor(DOC, START, END, { revision: 3 });

function expectPlaced(
  resolution: AnchorResolution
): Extract<AnchorResolution, { status: 'exact' | 'shifted' | 'fuzzy' }> {
  if (resolution.status === 'orphaned') {
    throw new Error('expected the anchor to be placed, got orphaned');
  }
  return resolution;
}

describe('resolveAnchor — the repair path, with no predecessor supplied', () => {
  it('finds the anchor at its recorded offsets in unchanged content', () => {
    expect(resolveAnchor(DOC, ANCHOR)).toEqual({
      status: 'exact',
      start: START,
      end: END,
      confidence: 1,
    });
  });

  it('an edit BEFORE the anchor shifts it — found by quote plus context', () => {
    const preamble = 'Once upon a time. ';
    const resolved = expectPlaced(resolveAnchor(preamble + DOC, ANCHOR));

    expect(resolved.status).toBe('shifted');
    expect(resolved.start).toBe(START + preamble.length);
    expect(resolved.end).toBe(END + preamble.length);
    expect(resolved.confidence).toBeGreaterThan(0.9);
  });

  it('an edit AFTER the anchor leaves the recorded offsets valid', () => {
    const resolved = resolveAnchor(`${DOC} And then some more happened.`, ANCHOR);
    expect(resolved).toEqual({ status: 'exact', start: START, end: END, confidence: 1 });
  });

  it('falls back to the bare quote when the surrounding context has changed too', () => {
    // Both the prefix and suffix are rewritten, so only `exact` itself is left.
    const rewritten = DOC.replace('The quick brown fox ', 'A sluggish grey badger ')
      .replace(' the lazy dog.', ' a wall.');
    const resolved = expectPlaced(resolveAnchor(rewritten, ANCHOR));

    expect(resolved.status).toBe('shifted');
    expect(rewritten.slice(resolved.start, resolved.end)).toBe(QUOTE);
    expect(resolved.confidence).toBeLessThan(0.9);
  });

  it('an edit INSIDE the quote degrades to a fuzzy match', () => {
    const edited = DOC.replace(QUOTE, 'jumped over');
    const resolved = expectPlaced(resolveAnchor(edited, ANCHOR));

    expect(resolved.status).toBe('fuzzy');
    expect(resolved.confidence).toBeGreaterThanOrEqual(FUZZY_SIMILARITY_FLOOR);
    expect(resolved.confidence).toBeLessThan(1);
    expect(edited.slice(resolved.start, resolved.start + 'jumped'.length)).toBe('jumped');
  });

  it('orphans when only the head of a long quote survives', () => {
    // dmp's bitap matcher caps patterns at 32 chars, so the fuzzy stage probes
    // with a truncated quote. This is the case that would otherwise sneak
    // through it: the probe matches, but the quote as a whole is gone.
    const longQuote = 'The quick brown fox jumps over the lazy dog and then keeps running.';
    const doc = `Before. ${longQuote} After.`;
    const anchor = createAnchor(doc, doc.indexOf(longQuote), doc.indexOf(longQuote) + longQuote.length, {
      revision: 1,
    });
    const gutted = `${longQuote.slice(0, 32)} ZZZ`;

    expect(gutted).toContain(longQuote.slice(0, 32));
    expect(resolveAnchor(gutted, anchor)).toEqual({ status: 'orphaned' });
  });

  it('orphans the anchor when the quoted text is destroyed', () => {
    expect(resolveAnchor('Entirely different prose about shipping containers.', ANCHOR)).toEqual({
      status: 'orphaned',
    });
  });

  it('orphans the anchor against empty and whitespace-only content', () => {
    expect(resolveAnchor('', ANCHOR)).toEqual({ status: 'orphaned' });
    expect(resolveAnchor('   \n\t  \n ', ANCHOR)).toEqual({ status: 'orphaned' });
  });

  it('orphans a zero-length anchor once its offsets stop holding', () => {
    const caret = createAnchor(DOC, START, START, { revision: 3 });

    expect(resolveAnchor(DOC, caret)).toEqual({
      status: 'exact',
      start: START,
      end: START,
      confidence: 1,
    });
    // A caret carries no quote, so there is no evidence a shift even happened:
    // its offsets trivially still "hold" and it silently stays put. That is the
    // accuracy floor this path represents, and precisely why portAnchor — which
    // maps a caret through the diff exactly — is the primary mechanism.
    expect(resolveAnchor(`xx${DOC}`, caret)).toEqual({
      status: 'exact',
      start: START,
      end: START,
      confidence: 1,
    });
    // Once the offsets fall outside the content there is nothing left to repair.
    expect(resolveAnchor('', caret)).toEqual({ status: 'orphaned' });
  });

  it('searches on the quote alone when the anchor has no context at all', () => {
    // The quote spans the whole document, so there is no prefix or suffix to
    // strengthen the search with.
    const whole = 'jumps over';
    const anchor = createAnchor(whole, 0, whole.length, { revision: 1 });
    expect(anchor.prefix).toBe('');
    expect(anchor.suffix).toBe('');

    const resolved = expectPlaced(resolveAnchor(`padding ${whole}`, anchor));
    expect(resolved.status).toBe('shifted');
    expect(resolved.start).toBe('padding '.length);
  });

  it('does not read past the end of shorter content when checking the offsets', () => {
    expect(resolveAnchor('short', ANCHOR)).toEqual({ status: 'orphaned' });
  });

  it('tolerates a negative or non-finite positional hint', () => {
    const broken = { ...ANCHOR, start: Number.NaN, end: Number.NaN };
    const resolved = expectPlaced(resolveAnchor(DOC, broken));

    expect(resolved.status).toBe('shifted');
    expect(resolved.start).toBe(START);
  });
});

describe('resolveAnchor with duplicated quote text', () => {
  const SEG = 'aaaa bbbb cccc dddd eeee ffff gg';
  const TARGET = 'TARGET';
  const DUP = `${SEG}${TARGET}${SEG}|${SEG}${TARGET}${SEG}`;
  const FIRST = DUP.indexOf(TARGET);
  const SECOND = DUP.lastIndexOf(TARGET);

  it('prefers the occurrence nearest the positional hint', () => {
    const secondAnchor = createAnchor(DUP, SECOND, SECOND + TARGET.length, { revision: 1 });
    const shifted = `xx${DUP}`;
    const resolved = expectPlaced(resolveAnchor(shifted, secondAnchor));

    expect(resolved.status).toBe('shifted');
    expect(resolved.start).toBe(SECOND + 2);

    const firstAnchor = createAnchor(DUP, FIRST, FIRST + TARGET.length, { revision: 1 });
    const resolvedFirst = expectPlaced(resolveAnchor(shifted, firstAnchor));
    expect(resolvedFirst.start).toBe(FIRST + 2);
  });

  it('reports lower confidence when the match was ambiguous', () => {
    const secondAnchor = createAnchor(DUP, SECOND, SECOND + TARGET.length, { revision: 1 });
    const ambiguous = expectPlaced(resolveAnchor(`xx${DUP}`, secondAnchor));

    const uniqueDoc = `${SEG}${TARGET}${SEG}`;
    const uniqueAnchor = createAnchor(uniqueDoc, SEG.length, SEG.length + TARGET.length, {
      revision: 1,
    });
    const unique = expectPlaced(resolveAnchor(`xx${uniqueDoc}`, uniqueAnchor));

    expect(ambiguous.confidence).toBeLessThan(unique.confidence);
  });
});

describe('textSimilarity', () => {
  it('scores identical, disjoint and empty inputs sanely', () => {
    expect(textSimilarity('hello world', 'hello world')).toBe(1);
    expect(textSimilarity('', '')).toBe(1);
    expect(textSimilarity('hello world', '')).toBe(0);
    expect(textSimilarity('hello world', 'hello werld')).toBeGreaterThan(0.8);
    expect(textSimilarity('hello world', 'zzzzzzzzzzz')).toBeLessThan(FUZZY_SIMILARITY_FLOOR);
  });
});
