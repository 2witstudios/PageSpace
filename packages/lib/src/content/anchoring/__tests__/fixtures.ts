/**
 * Shared fixtures and assertion helpers for the anchoring tests.
 *
 * Not a test file: vitest only collects `*.test.ts`, and knip ignores
 * `src/**\/__tests__/**` entirely, so this needs no entry or exports registration.
 */
import { expect } from 'vitest';
import type { AnchorResolution } from '../types';

/** The document every single-quote case is measured against. */
export const DOC = 'The quick brown fox jumps over the lazy dog. The end of the tale.';
export const QUOTE = 'jumps over';
export const QUOTE_START = DOC.indexOf(QUOTE);
export const QUOTE_END = QUOTE_START + QUOTE.length;

/**
 * Exactly ANCHOR_CONTEXT_LENGTH characters, so a quote surrounded by it on both
 * sides produces an anchor whose prefix and suffix are this string in full —
 * which is what makes two copies of that quote genuinely indistinguishable to a
 * text search.
 */
export const SEG = 'aaaa bbbb cccc dddd eeee ffff gg';
export const TARGET = 'TARGET';

/** Two copies of TARGET carrying byte-identical context on both sides. */
export const DUPLICATED = `${SEG}${TARGET}${SEG}|${SEG}${TARGET}${SEG}`;
export const FIRST_TARGET = DUPLICATED.indexOf(TARGET);
export const SECOND_TARGET = DUPLICATED.lastIndexOf(TARGET);

/** Narrow away `orphaned` so a test can read start/end/confidence directly. */
export function expectPlaced(
  resolution: AnchorResolution
): Extract<AnchorResolution, { status: 'exact' | 'shifted' | 'fuzzy' }> {
  expect(resolution.status).not.toBe('orphaned');
  if (resolution.status === 'orphaned') {
    throw new Error('expected the anchor to be placed, got orphaned');
  }
  return resolution;
}
