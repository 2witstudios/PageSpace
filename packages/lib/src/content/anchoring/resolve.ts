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

// A private instance: diff-utils keeps its own and mutates Diff_Timeout during
// a diff, and neither module should be able to perturb the other's tuning.
// Pinned rather than left to the library defaults so the fuzzy stage stays
// reproducible across dependency bumps.
const dmp = new DiffMatchPatch();
dmp.Match_Threshold = 0.5;
dmp.Match_Distance = 1000;
// 0 disables the deadline, which is the whole point: the library default of one
// second makes diff_main return a SUBOPTIMAL diff when the clock runs out, so
// the same two strings score differently on a fast machine than on a loaded
// one. Anchors have to resolve identically everywhere, and a confidence that
// wobbles across the FUZZY_SIMILARITY_FLOOR would orphan a tag on one host and
// keep it on another. The work is bounded by the caller: textSimilarity only
// ever compares a quote against a slice of its own length.
dmp.Diff_Timeout = 0;

/**
 * dmp's bitap matcher refuses patterns longer than `Match_MaxBits` (32), so the
 * fuzzy stage searches with a truncated probe and scores the full quote against
 * whatever it lands on.
 */
const MAX_FUZZY_PATTERN = 32;

/** Similarity below this and we call the anchored text destroyed. */
export const FUZZY_SIMILARITY_FLOOR = 0.5;

/**
 * Longest quote the fuzzy stage will score. Levenshtein via dmp is quadratic:
 * measured on this repo's diff-match-patch, two fully dissimilar strings take
 * ~36ms at 1KB, ~558ms at 4KB and ~14s at 20KB. Nothing bounds a quote —
 * `createAnchor(text, 0, text.length, …)` is a legal call for a user selecting
 * a whole page — so the ceiling has to live here. Strategies 1 and 2 are linear
 * and still run for any size; only the last-resort approximate match is capped.
 */
const MAX_FUZZY_QUOTE = 1024;

/**
 * How much each strategy is trusted. `ambiguous` applies when several copies of
 * the text matched and only the positional hint chose between them — the guess
 * forward-porting never has to make.
 */
const CONFIDENCE = {
  /** Found at the offsets the anchor recorded. */
  position: 1,
  /** Found by the quote plus its surrounding context. */
  context: { unique: 0.95, ambiguous: 0.8 },
  /** Found by the bare quote, with no context left to corroborate it. */
  quote: { unique: 0.85, ambiguous: 0.7 },
} as const;

type ConfidencePair = { unique: number; ambiguous: number };

/** A fresh object per call: a shared constant would be mutable by callers. */
function orphaned(): AnchorResolution {
  return { status: 'orphaned' };
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
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

/** What to search for, and where the quote itself sits inside it. */
type QuoteSearch = {
  /** The string to look for — the quote, optionally wrapped in its context. */
  needle: string;
  /** How far into `needle` the quote begins. */
  offsetWithin: number;
  /** Length of the quote itself, which is what the result must span. */
  length: number;
};

/**
 * Find `search.needle` in `text`. When several copies match, the one nearest
 * `hint` wins — that hint is the only signal left that distinguishes duplicated
 * prose, and it is exactly the ambiguity forward-porting never has to guess at.
 */
function searchQuote(
  text: string,
  hint: number,
  search: QuoteSearch,
  confidence: ConfidencePair
): AnchorResolution | null {
  const occurrences = findOccurrences(text, search.needle);
  if (occurrences.length === 0) {
    return null;
  }

  // Compare where the QUOTE would land, not where the needle starts, so the
  // context wrapper does not skew the choice.
  const distance = (occurrence: number): number =>
    Math.abs(occurrence + search.offsetWithin - hint);

  let best = occurrences[0];
  for (const candidate of occurrences) {
    if (distance(candidate) < distance(best)) {
      best = candidate;
    }
  }

  const start = best + search.offsetWithin;
  return {
    status: 'shifted',
    start,
    end: start + search.length,
    confidence: occurrences.length === 1 ? confidence.unique : confidence.ambiguous,
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
 * Does the anchor still describe `text` at the offsets it recorded?
 *
 * Exported because `portAnchor` asks the same question of the predecessor
 * content, and the two must agree — particularly about carets, where the naive
 * check is vacuous.
 */
export function positionHolds(text: string, anchor: TextAnchor): boolean {
  // Offsets arrive from storage and are not trustworthy. String.slice forgives
  // every one of these and quietly returns something, which is the problem:
  // a negative start counts back from the end and can fabricate a match; an
  // inverted range yields '', which a caret equals — and a caret whose context
  // is also empty then satisfies the check below vacuously, so `start > end`
  // does need its own test; and a fractional or non-finite offset would be
  // handed straight back to the caller as a position.
  if (
    !Number.isSafeInteger(anchor.start) ||
    !Number.isSafeInteger(anchor.end) ||
    anchor.start < 0 ||
    anchor.start > anchor.end ||
    anchor.end > text.length
  ) {
    return false;
  }
  if (text.slice(anchor.start, anchor.end) !== anchor.exact) {
    return false;
  }
  if (anchor.exact.length > 0) {
    return true;
  }
  // A caret's own text is empty, so the slice check above passes at EVERY
  // in-range offset — it is no evidence at all. Corroborate with the context,
  // or a caret would claim maximum confidence against unrelated content.
  const from = Math.max(0, anchor.start - anchor.prefix.length);
  return text.slice(from, anchor.end + anchor.suffix.length) === anchor.prefix + anchor.suffix;
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
  if (positionHolds(text, anchor)) {
    return {
      status: 'exact',
      start: anchor.start,
      end: anchor.end,
      confidence: CONFIDENCE.position,
    };
  }

  if (exact.length === 0) {
    // A caret has no quote to search for, but it does have context, and the two
    // halves are adjacent precisely because the quote between them is empty.
    if (prefix.length === 0 && suffix.length === 0) {
      return orphaned();
    }
    return (
      searchQuote(
        text,
        hint,
        { needle: prefix + suffix, offsetWithin: prefix.length, length: 0 },
        CONFIDENCE.context
      ) ?? orphaned()
    );
  }

  // 2a. Quote with its surrounding context — the strongest textual evidence.
  if (prefix.length > 0 || suffix.length > 0) {
    const withContext = searchQuote(
      text,
      hint,
      { needle: prefix + exact + suffix, offsetWithin: prefix.length, length: exact.length },
      CONFIDENCE.context
    );
    if (withContext) {
      return withContext;
    }
  }

  // 2b. The quote alone.
  const quoteOnly = searchQuote(
    text,
    hint,
    { needle: exact, offsetWithin: 0, length: exact.length },
    CONFIDENCE.quote
  );
  if (quoteOnly) {
    return quoteOnly;
  }

  // 3. Bounded fuzzy match, biased towards the positional hint.
  if (exact.length > MAX_FUZZY_QUOTE) {
    return orphaned();
  }
  const probe = exact.length > MAX_FUZZY_PATTERN ? exact.slice(0, MAX_FUZZY_PATTERN) : exact;
  const location = dmp.match_main(text, probe, hint);
  if (location === -1) {
    return orphaned();
  }

  const end = Math.min(text.length, location + exact.length);
  const confidence = textSimilarity(text.slice(location, end), exact);
  if (confidence < FUZZY_SIMILARITY_FLOOR) {
    return orphaned();
  }

  return { status: 'fuzzy', start: location, end, confidence };
}
