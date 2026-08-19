import { describe, expect, it } from 'vitest';
import { createAnchor } from '../anchor';
import { MAX_EXACT_DIFF_REGION, changedRegionSize, portAnchor } from '../reanchor';
import { resolveAnchor } from '../resolve';
import type { AnchorResolution } from '../types';
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

describe('portAnchor — forward-porting through the diff', () => {
  const PREAMBLE = 'Once upon a time. ';

  const cases: Array<{
    name: string;
    newText: string;
    expected: AnchorResolution;
  }> = [
    {
      name: 'unchanged document keeps the anchor exactly where it was',
      newText: DOC,
      expected: { status: 'exact', start: START, end: END, confidence: 1 },
    },
    {
      name: 'insert before the anchor shifts it by exactly the inserted length',
      newText: PREAMBLE + DOC,
      expected: {
        status: 'shifted',
        start: START + PREAMBLE.length,
        end: END + PREAMBLE.length,
        confidence: 1,
      },
    },
    {
      name: 'insert further inside, still before the anchor, shifts by that length',
      newText: DOC.replace('brown ', 'brown speckled '),
      expected: {
        status: 'shifted',
        start: START + 'speckled '.length,
        end: END + 'speckled '.length,
        confidence: 1,
      },
    },
    {
      name: 'insert after the anchor leaves its offsets untouched',
      newText: `${DOC} And then some more happened.`,
      expected: { status: 'exact', start: START, end: END, confidence: 1 },
    },
    {
      name: 'delete after the anchor leaves its offsets untouched',
      newText: DOC.replace(' The end of the tale.', ''),
      expected: { status: 'exact', start: START, end: END, confidence: 1 },
    },
    {
      name: 'an edit inside the quote widens the range over the inserted text',
      newText: DOC.replace(QUOTE, 'jumps clean over'),
      expected: { status: 'fuzzy', start: START, end: START + 'jumps clean over'.length, confidence: 1 },
    },
    {
      name: 'a partial deletion inside the quote scores confidence by what survived',
      newText: DOC.replace(QUOTE, 'jumps'),
      // 'jumps over the' -> 'jumps the': the quote's trailing space survives
      // along with 'jumps', so 6 of its 10 characters are still there.
      // The exact figure is only stable because portAnchor pins the diff
      // deadline; on a timed-out diff the segmentation, and so this count,
      // would depend on machine speed.
      expected: { status: 'fuzzy', start: START, end: START + 'jumps '.length, confidence: 0.6 },
    },
    {
      name: 'the quote deleted entirely orphans the anchor',
      newText: DOC.replace(`${QUOTE} `, ''),
      expected: { status: 'orphaned' },
    },
    {
      name: 'the whole document replaced orphans the anchor',
      newText: 'Entirely different prose about shipping containers.',
      expected: { status: 'orphaned' },
    },
    {
      name: 'the document emptied orphans the anchor',
      newText: '',
      expected: { status: 'orphaned' },
    },
  ];

  it.each(cases)('$name', ({ newText, expected }) => {
    expect(portAnchor(ANCHOR, DOC, newText)).toEqual(expected);
  });

  it('ports a zero-length caret anchor, and orphans it when its position is deleted', () => {
    const caret = createAnchor(DOC, START, START, { revision: 3 });

    expect(portAnchor(caret, DOC, `${'x '}${DOC}`)).toEqual({
      status: 'shifted',
      start: START + 2,
      end: START + 2,
      confidence: 1,
    });
    expect(portAnchor(caret, DOC, DOC)).toEqual({
      status: 'exact',
      start: START,
      end: START,
      confidence: 1,
    });
    expect(portAnchor(caret, DOC, 'Entirely different prose about shipping containers.')).toEqual({
      status: 'orphaned',
    });
  });

  it('repairs a drifted hint against the old text before porting it forward', () => {
    // An anchor whose offsets no longer describe the old content — e.g. one
    // written against an earlier revision. The quote is still there, so it is
    // located first and then ported, rather than mapping a garbage span.
    const drifted = { ...ANCHOR, start: 0, end: QUOTE.length };
    const ported = expectPlaced(portAnchor(drifted, DOC, `xx${DOC}`));

    expect(ported.start).toBe(START + 2);
    expect(ported.end).toBe(END + 2);
    expect(ported.confidence).toBeGreaterThan(0.5);
  });

  it('a repaired anchor never claims exact, even landing back on its stale offsets', () => {
    // Hint is 2 too far right, so it has to be repaired against the old text
    // (found at 20). The edit then shifts the quote 2 to the right, back onto
    // the very offset the anchor recorded — a coincidence, not evidence.
    const drifted = { ...ANCHOR, start: START + 2, end: END + 2 };
    const ported = expectPlaced(portAnchor(drifted, DOC, `xx${DOC}`));

    expect(ported.start).toBe(drifted.start);
    expect(ported.status).toBe('shifted');
    expect(ported.confidence).toBeLessThan(1);
  });

  it('still ports exactly through a small edit in a very large document', () => {
    // The cap is on the CHANGED region, not on document size: the common
    // prefix and suffix strip everything but the keystrokes, so an ordinary
    // save on a big page keeps the exact path no matter how big the page is.
    const filler = 'lorem ipsum dolor sit amet consectetur '.repeat(1000); // ~39KB
    const old = `${filler}${QUOTE}${filler}`;
    const inserted = 'NEW ';
    const updated = `${inserted}${old}`;

    const bigAnchor = createAnchor(old, filler.length, filler.length + QUOTE.length, {
      revision: 1,
    });

    expect(portAnchor(bigAnchor, old, updated)).toEqual({
      status: 'shifted',
      start: filler.length + inserted.length,
      end: filler.length + QUOTE.length + inserted.length,
      confidence: 1,
    });
  });

  it('measures the changed region from both ends', () => {
    const filler = 'lorem ipsum dolor sit amet consectetur '.repeat(1000); // ~39KB

    // Shared text only in FRONT of the change — the prefix scan carries it.
    expect(changedRegionSize(`${filler}tail`, `${filler}TAIL`)).toBe(4);
    // Shared text only BEHIND the change — the suffix scan carries it.
    expect(changedRegionSize(`head${filler}`, `HEAD${filler}`)).toBe(4);
    // Shared text on both sides of it.
    expect(changedRegionSize(`${filler}mid${filler}`, `${filler}MID${filler}`)).toBe(3);
    // Nothing shared at all: the whole of the longer text is the change.
    expect(changedRegionSize('abcdef', 'uvwxyz!!')).toBe(8);
    // Identical texts have no changed region, however large they are.
    expect(changedRegionSize(filler, filler)).toBe(0);
    // An insertion is measured by what was inserted, not by what surrounds it.
    expect(changedRegionSize(`${filler}${filler}`, `${filler}xyz${filler}`)).toBe(3);

    // And the cap is what turns that measurement into a routing decision.
    const under = 'q'.repeat(MAX_EXACT_DIFF_REGION);
    const over = 'q'.repeat(MAX_EXACT_DIFF_REGION + 1);
    expect(changedRegionSize(filler, `${filler}${under}`)).toBe(MAX_EXACT_DIFF_REGION);
    expect(changedRegionSize(filler, `${filler}${over}`)).toBeGreaterThan(MAX_EXACT_DIFF_REGION);
  });

  it('keeps the exact path for a trailing edit in a very large document', () => {
    // Guards the common-prefix half of the strip specifically: here the shared
    // text is all in front of the change, so only the prefix scan can keep this
    // under the cap and on the exact path.
    const filler = 'lorem ipsum dolor sit amet consectetur '.repeat(1000); // ~39KB
    const old = `${filler}${QUOTE} middle`;
    const updated = `${old} and a short tail`;

    const bigAnchor = createAnchor(old, filler.length, filler.length + QUOTE.length, {
      revision: 1,
    });

    expect(portAnchor(bigAnchor, old, updated)).toEqual({
      status: 'exact',
      start: filler.length,
      end: filler.length + QUOTE.length,
      confidence: 1,
    });
  });

  it('a repaired caret never claims exact either, landing back on its own offset', () => {
    // The caret counterpart of the range case above. The hint is 2 too far
    // right so the caret has to be repaired against the old text, and the edit
    // then shifts it back onto the very offset it recorded — a coincidence,
    // not evidence, and 'exact' has to mean confidence 1 everywhere.
    const caret = createAnchor(DOC, START, START, { revision: 3 });
    const drifted = { ...caret, start: START + 2, end: START + 2 };
    const ported = expectPlaced(portAnchor(drifted, DOC, `xx${DOC}`));

    expect(ported.start).toBe(drifted.start);
    expect(ported.status).toBe('shifted');
    expect(ported.confidence).toBeLessThan(1);
  });

  it('orphans when the anchor cannot be found in the old text either', () => {
    expect(portAnchor(ANCHOR, 'nothing like the anchored prose at all', DOC)).toEqual({
      status: 'orphaned',
    });
  });
});

describe('portAnchor beats a text search on duplicated quote text', () => {
  // Two occurrences of the same quote with byte-identical 32-char context on
  // both sides: prefix + exact + suffix matches BOTH, so a quote search has
  // nothing left but the positional hint to guess with. The diff has no such
  // problem — it knows which copy the offsets belonged to.
  const INSERTION = 'qqqq '.repeat(40); // longer than the gap between the two copies
  const NEW = DUPLICATED.slice(0, SEG.length * 2 + TARGET.length) + INSERTION + DUPLICATED.slice(SEG.length * 2 + TARGET.length);

  const anchor = createAnchor(DUPLICATED, SECOND_TARGET, SECOND_TARGET + TARGET.length, { revision: 1 });

  it('the fixture really is ambiguous — both copies carry identical context', () => {
    expect(SEG).toHaveLength(32);
    expect(anchor.prefix).toBe(SEG);
    expect(anchor.suffix).toBe(SEG);
    expect(createAnchor(DUPLICATED, FIRST_TARGET, FIRST_TARGET + TARGET.length, { revision: 1 }).prefix).toBe(anchor.prefix);
    expect(NEW.split(TARGET)).toHaveLength(3);
  });

  it('forward-porting lands on the right copy', () => {
    expect(portAnchor(anchor, DUPLICATED, NEW)).toEqual({
      status: 'shifted',
      start: SECOND_TARGET + INSERTION.length,
      end: SECOND_TARGET + INSERTION.length + TARGET.length,
      confidence: 1,
    });
    expect(NEW.slice(SECOND_TARGET + INSERTION.length, SECOND_TARGET + INSERTION.length + TARGET.length)).toBe(TARGET);
  });

  it('degrades to the search once the rewrite is too large to diff exactly', () => {
    // The character diff is quadratic in the size of the change, so above the
    // cap portAnchor stops paying for it and takes the repair path instead.
    // The visible cost of that trade is exactly the disambiguation above: with
    // a big enough rewrite, the port and the search agree — on the wrong copy.
    const bigInsertion = 'qqqq '.repeat(600); // 3000 chars, over the 2048 cap
    const cut = SEG.length * 2 + TARGET.length;
    const rewritten = DUPLICATED.slice(0, cut) + bigInsertion + DUPLICATED.slice(cut);

    expect(portAnchor(anchor, DUPLICATED, rewritten)).toEqual(resolveAnchor(rewritten, anchor));
    expect(expectPlaced(portAnchor(anchor, DUPLICATED, rewritten)).start).toBe(FIRST_TARGET);
  });

  it('a text search — the fallback — lands on the WRONG copy, which is the point', () => {
    const searched = expectPlaced(resolveAnchor(NEW, anchor));

    expect(searched.status).toBe('shifted');
    expect(searched.start).toBe(FIRST_TARGET);
    expect(searched.start).not.toBe(SECOND_TARGET + INSERTION.length);
    // It cannot even tell you it guessed wrong; it only knows it was ambiguous.
    expect(searched.confidence).toBeLessThan(1);
  });
});
