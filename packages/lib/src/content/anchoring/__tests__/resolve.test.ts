import { describe, expect, it } from 'vitest';
import { createAnchor } from '../anchor';
import { FUZZY_SIMILARITY_FLOOR, resolveAnchor, textSimilarity } from '../resolve';
import {
  DOC,
  DUPLICATED,
  FIRST_TARGET,
  QUOTE,
  QUOTE_END as END,
  QUOTE_START as START,
  SECOND_TARGET,
  SEG,
  TARGET,
  expectPlaced,
} from './fixtures';


const ANCHOR = createAnchor(DOC, START, END, { revision: 3 });

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

  it('repairs a zero-length (caret) anchor from the context around it', () => {
    const caret = createAnchor(DOC, START, START, { revision: 3 });

    expect(resolveAnchor(DOC, caret)).toEqual({
      status: 'exact',
      start: START,
      end: START,
      confidence: 1,
    });
    // A caret's own text is empty, so `text.slice(start, end) === exact` passes
    // at EVERY in-range offset and is no evidence at all. The prefix and suffix
    // are adjacent precisely because the quote between them is empty, so they
    // relocate the caret exactly.
    expect(resolveAnchor(`xx${DOC}`, caret)).toEqual({
      status: 'shifted',
      start: START + 2,
      end: START + 2,
      confidence: 0.95,
    });
    // Once the offsets fall outside the content there is nothing left to repair.
    expect(resolveAnchor('', caret)).toEqual({ status: 'orphaned' });
    expect(resolveAnchor('nothing like the anchored prose', caret)).toEqual({
      status: 'orphaned',
    });
  });

  it('never claims a caret is exact just because its offsets are in range', () => {
    // The regression this guards: an unqualified slice check reports a caret as
    // status 'exact' with confidence 1 against arbitrary unrelated content, and
    // a consumer gating on confidence === 1 cannot tell that apart from a hit.
    const caret = createAnchor(DOC, START, START, { revision: 3 });
    const unrelated = 'x'.repeat(DOC.length);

    expect(caret.end).toBeLessThanOrEqual(unrelated.length);
    expect(unrelated.slice(caret.start, caret.end)).toBe(caret.exact);
    expect(resolveAnchor(unrelated, caret)).toEqual({ status: 'orphaned' });
  });

  it('orphans a caret that has no context either — nothing is left to go on', () => {
    const caret = createAnchor('', 0, 0, { revision: 1 });
    expect(caret.prefix).toBe('');
    expect(caret.suffix).toBe('');

    expect(resolveAnchor('', caret)).toEqual({
      status: 'exact',
      start: 0,
      end: 0,
      confidence: 1,
    });
    expect(resolveAnchor('anything at all', { ...caret, start: 99, end: 99 })).toEqual({
      status: 'orphaned',
    });
  });

  it('does not attempt a quadratic fuzzy score on a document-sized quote', () => {
    // dmp's Levenshtein is quadratic and nothing bounds a quote: selecting a
    // whole page is a legal anchor. Strategies 1 and 2 are linear and still run
    // at any size; only the last-resort approximate match is capped.
    const huge = 'lorem ipsum dolor sit amet '.repeat(120); // > 1024 chars
    const doc = `head ${huge} tail`;
    const anchor = createAnchor(doc, 5, 5 + huge.length, { revision: 1 });

    expect(anchor.exact.length).toBeGreaterThan(1024);
    // Intact and merely moved: found by the linear quote search, not by fuzzy.
    const moved = expectPlaced(resolveAnchor(`xx${doc}`, anchor));
    expect(moved.status).toBe('shifted');
    // Edited inside, so only the fuzzy stage could place it — and it declines.
    const edited = doc.replace('lorem ipsum dolor', 'LOREM IPSUM DOLOR');
    expect(resolveAnchor(edited, anchor)).toEqual({ status: 'orphaned' });
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

  it('rejects a negative start, which String.slice would read from the far end', () => {
    // slice(-5, 65) returns the LAST five characters, so an anchor with a
    // negative start can match its own quote and be reported as exact — at a
    // negative offset no consumer could use.
    const tailQuote = DOC.slice(-5);
    const anchor = createAnchor(DOC, DOC.length - 5, DOC.length, { revision: 1 });
    const negative = { ...anchor, start: -5, end: DOC.length };

    expect(DOC.slice(negative.start, negative.end)).toBe(tailQuote);

    const resolved = expectPlaced(resolveAnchor(DOC, negative));
    expect(resolved.start).toBe(DOC.length - 5);
    expect(resolved.status).toBe('shifted');
  });

  it('rejects an inverted caret whose context is empty too', () => {
    // Every check downstream is vacuous for this one: slice(1, 0) returns '',
    // which the empty quote equals, and the empty context corroborates it. It
    // would otherwise be reported as exact over an inverted, unusable range.
    const degenerate = {
      ...createAnchor('', 0, 0, { revision: 1 }),
      start: 1,
      end: 0,
    };

    expect(DOC.slice(degenerate.start, degenerate.end)).toBe(degenerate.exact);
    expect(degenerate.prefix + degenerate.suffix).toBe('');
    expect(resolveAnchor(DOC, degenerate)).toEqual({ status: 'orphaned' });
  });

  it('rejects fractional and non-finite offsets rather than handing them back', () => {
    // The returned start/end are offsets a consumer will slice with, so they
    // have to be integers even when the stored anchor is not.
    // Each side is checked separately: with only one offset fractional the
    // other bounds checks all pass, so nothing else would catch it. Note
    // slice() truncates rather than rejecting, so `end: END + 0.5` would
    // otherwise match the quote and hand back a fractional end.
    for (const broken of [
      { ...ANCHOR, start: START + 0.5 },
      { ...ANCHOR, end: END + 0.5 },
      { ...ANCHOR, start: Number.NaN },
      { ...ANCHOR, end: Number.NaN },
    ]) {
      const placed = expectPlaced(resolveAnchor(DOC, broken));
      expect(placed.status).not.toBe('exact');
      expect(Number.isSafeInteger(placed.start)).toBe(true);
      expect(Number.isSafeInteger(placed.end)).toBe(true);
      expect(placed.start).toBe(START);
    }

    const caret = createAnchor(DOC, START, START, { revision: 1 });
    expect(resolveAnchor(DOC, { ...caret, start: Number.NaN, end: Number.NaN })).toEqual({
      status: 'shifted',
      start: START,
      end: START,
      confidence: 0.95,
    });
    expect(
      resolveAnchor(DOC, { ...caret, start: Number.POSITIVE_INFINITY, end: Number.POSITIVE_INFINITY })
    ).toEqual({ status: 'shifted', start: START, end: START, confidence: 0.95 });
  });

  it('rejects an inverted range instead of reading it as a vacuous match', () => {
    // String.slice(30, 20) returns '' rather than throwing, so a caret whose
    // offsets are the wrong way round would otherwise "hold" anywhere.
    const inverted = { ...createAnchor(DOC, START, START, { revision: 1 }), start: END, end: START };
    expect(DOC.slice(inverted.start, inverted.end)).toBe(inverted.exact);
    expect(resolveAnchor(DOC, inverted).status).not.toBe('exact');
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

  it('prefers the occurrence nearest the positional hint', () => {
    const secondAnchor = createAnchor(DUPLICATED, SECOND_TARGET, SECOND_TARGET + TARGET.length, { revision: 1 });
    const shifted = `xx${DUPLICATED}`;
    const resolved = expectPlaced(resolveAnchor(shifted, secondAnchor));

    expect(resolved.status).toBe('shifted');
    expect(resolved.start).toBe(SECOND_TARGET + 2);

    const firstAnchor = createAnchor(DUPLICATED, FIRST_TARGET, FIRST_TARGET + TARGET.length, { revision: 1 });
    const resolvedFirst = expectPlaced(resolveAnchor(shifted, firstAnchor));
    expect(resolvedFirst.start).toBe(FIRST_TARGET + 2);
  });

  it('measures distance to where the QUOTE lands, not where the context starts', () => {
    // Two context matches whose needles start at 0 and 100, so the quotes
    // themselves sit at 32 and 132. With the hint at 60 the first quote is the
    // nearer one (28 away vs 72) even though the second NEEDLE is nearer (40
    // away vs 60). Comparing needle starts instead of quote starts picks the
    // wrong copy, and only a hint inside this window exposes it.
    const needle = `${SEG}${TARGET}${SEG}`;
    const doc = `${needle}${'-'.repeat(100 - needle.length)}${needle}`;

    expect(doc.indexOf(needle)).toBe(0);
    expect(doc.lastIndexOf(needle)).toBe(100);

    const drifted = { ...createAnchor(doc, SEG.length, SEG.length + TARGET.length, { revision: 1 }), start: 60, end: 66 };
    expect(doc.slice(drifted.start, drifted.end)).not.toBe(TARGET);

    const resolved = expectPlaced(resolveAnchor(doc, drifted));
    expect(resolved.start).toBe(SEG.length);
    expect(resolved.end).toBe(SEG.length + TARGET.length);
  });

  it('reports lower confidence when the match was ambiguous', () => {
    const secondAnchor = createAnchor(DUPLICATED, SECOND_TARGET, SECOND_TARGET + TARGET.length, { revision: 1 });
    const ambiguous = expectPlaced(resolveAnchor(`xx${DUPLICATED}`, secondAnchor));

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
