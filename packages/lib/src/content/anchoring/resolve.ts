/**
 * The REPAIR path: locate an anchor in a projection when there is no
 * predecessor to diff against.
 *
 * Forward-porting through the diff (reanchor.ts) is the primary mechanism and
 * is always preferred — it is exact. This module is what runs when no such diff
 * exists: `convert-content-mode` rewrites the whole blob through
 * Turndown/marked, restore-from-version jumps revisions, and imports and
 * backfills arrive with no predecessor at all.
 *
 * Three strategies, first hit wins: position, then quote + context, then a
 * bounded fuzzy match. Below the similarity floor the anchor is `orphaned` —
 * precisely GitHub's *outdated* state.
 *
 * Zero I/O — no db, no fetch, no clock, no env — enforced by the purity test in
 * __tests__/purity.test.ts.
 *
 * @module @pagespace/lib/content/anchoring/resolve
 */

import DiffMatchPatch from 'diff-match-patch';
import type { AnchorResolution, TextAnchor } from './types';

const dmp = new DiffMatchPatch();
// Pinned rather than left to the library defaults so the fuzzy stage is
// reproducible across dependency bumps.
dmp.Match_Threshold = 0.5;
dmp.Match_Distance = 1000;

/**
 * dmp's bitap matcher refuses patterns longer than `Match_MaxBits` (32), so the
 * fuzzy stage searches with a truncated probe and scores the full quote against
 * whatever it lands on.
 */
const MAX_FUZZY_PATTERN = 32;

/** Similarity below this and we call the anchored text destroyed. */
export const FUZZY_SIMILARITY_FLOOR = 0.5;

const CONFIDENCE = {
  position: 1,
  uniqueContext: 0.95,
  ambiguousContext: 0.8,
  uniqueQuote: 0.85,
  ambiguousQuote: 0.7,
} as const;

const ORPHANED: AnchorResolution = { status: 'orphaned' };

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** Every index at which `needle` occurs in `haystack`. */
function findOccurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) {
      return found;
    }
    found.push(index);
    from = index + 1;
  }
}

/**
 * Search for `needle`, whose quoted text begins `offsetWithin` chars in. When
 * several copies match, the one nearest the anchor's positional hint wins —
 * that hint is the only signal left that distinguishes duplicated prose, and it
 * is exactly the ambiguity that forward-porting avoids having to guess at.
 */
function searchQuote(
  text: string,
  needle: string,
  offsetWithin: number,
  hint: number,
  quoteLength: number,
  uniqueConfidence: number,
  ambiguousConfidence: number
): AnchorResolution | null {
  const occurrences = findOccurrences(text, needle);
  if (occurrences.length === 0) {
    return null;
  }

  let best = occurrences[0];
  if (occurrences.length > 1) {
    for (const candidate of occurrences) {
      if (Math.abs(candidate + offsetWithin - hint) < Math.abs(best + offsetWithin - hint)) {
        best = candidate;
      }
    }
  }

  const start = best + offsetWithin;
  return {
    status: 'shifted',
    start,
    end: start + quoteLength,
    confidence: occurrences.length === 1 ? uniqueConfidence : ambiguousConfidence,
  };
}

/** 1 - normalised Levenshtein distance, in [0, 1]. */
export function textSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) {
    return 1;
  }
  const distance = dmp.diff_levenshtein(dmp.diff_main(a, b));
  return Math.max(0, 1 - distance / longest);
}

/**
 * Locate `anchor` in `text` (a projection, never a stored blob).
 *
 * Use this only when the predecessor content is unavailable; when both sides of
 * a change are in hand, `portAnchor` is exact and this is not.
 */
export function resolveAnchor(text: string, anchor: TextAnchor): AnchorResolution {
  const { exact, prefix, suffix } = anchor;
  const hint = clamp(anchor.start, 0, text.length);

  // 1. Position — the recorded offsets still hold.
  if (anchor.start >= 0 && anchor.end <= text.length && text.slice(anchor.start, anchor.end) === exact) {
    return { status: 'exact', start: anchor.start, end: anchor.end, confidence: CONFIDENCE.position };
  }

  if (exact.length === 0) {
    // A zero-length anchor carries no quote to search for; once its offsets
    // stop holding there is nothing left to repair from.
    return ORPHANED;
  }

  // 2a. Quote with its surrounding context — the strongest textual evidence.
  if (prefix.length > 0 || suffix.length > 0) {
    const withContext = searchQuote(
      text,
      prefix + exact + suffix,
      prefix.length,
      hint,
      exact.length,
      CONFIDENCE.uniqueContext,
      CONFIDENCE.ambiguousContext
    );
    if (withContext) {
      return withContext;
    }
  }

  // 2b. The quote alone.
  const quoteOnly = searchQuote(
    text,
    exact,
    0,
    hint,
    exact.length,
    CONFIDENCE.uniqueQuote,
    CONFIDENCE.ambiguousQuote
  );
  if (quoteOnly) {
    return quoteOnly;
  }

  // 3. Bounded fuzzy match, biased towards the positional hint.
  const probe = exact.length > MAX_FUZZY_PATTERN ? exact.slice(0, MAX_FUZZY_PATTERN) : exact;
  const location = dmp.match_main(text, probe, hint);
  if (location === -1) {
    return ORPHANED;
  }

  const end = Math.min(text.length, location + exact.length);
  const confidence = textSimilarity(text.slice(location, end), exact);
  if (confidence < FUZZY_SIMILARITY_FLOOR) {
    return ORPHANED;
  }

  return { status: 'fuzzy', start: location, end, confidence };
}
