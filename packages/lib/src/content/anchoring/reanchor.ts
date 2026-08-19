/**
 * The PRIMARY mechanism: forward-port an anchor's offsets through the diff
 * between the content it was measured against and the content that replaced it.
 *
 * This is GitHub's model, and it is the accurate one. `applyPageMutation`
 * (apps/web/src/services/api/page-mutation-service.ts) holds `previousContent`
 * and `nextContent` in the same transaction and writes a `page_versions` row on
 * every mutation, so the revision chain is complete rather than sparse. Given
 * both sides of a change, the mapping is exact: no searching, no heuristics, and
 * no ambiguity when the quoted text occurs more than once — which is precisely
 * the case a quote search cannot resolve at all.
 *
 * Anchors orphan only when the anchored text is genuinely destroyed, not on any
 * edit that merely shifts it. That matters because a tag is not a review
 * comment: a PR comment's job ends at merge so decay is free, whereas a tag has
 * to keep working for retrieval indefinitely.
 *
 * Zero I/O — no db, no fetch, no clock, no env — enforced by the purity test in
 * __tests__/purity.test.ts.
 *
 * COST: portAnchor diffs the whole document once per anchor, which is the right
 * shape for a pure function of (anchor, oldText, newText) and the wrong shape
 * for a page carrying many anchors. The diff depends only on the two texts, so
 * the call site that ports a page's anchors in bulk should compute it once and
 * reuse it. That call site does not exist yet — wiring this into
 * applyPageMutation is a later phase — so the hoist belongs there, not here,
 * where it would mean inventing an API with no caller to shape it.
 *
 * @module @pagespace/lib/content/anchoring/reanchor
 */

import { type DiffChange, diffContent } from '../diff-utils';
import { positionHolds, resolveAnchor } from './resolve';
import type { AnchorResolution, TextAnchor } from './types';

/**
 * How much genuine change portAnchor will diff character-by-character, measured
 * after the common prefix and suffix are stripped.
 *
 * A character diff is quadratic in the size of the differing region. Measured
 * on this repo's diff-match-patch, two fully dissimilar strings take ~142ms at
 * 2KB, ~558ms at 4KB and ~13.9s at 20KB — and portAnchor runs once per anchor,
 * so an unbounded diff of a wholesale rewrite would block the event loop for
 * minutes on a page carrying a handful of tags.
 *
 * Capping the CLOCK instead would be worse than useless here: diff-match-patch
 * does not fail when its deadline expires, it returns a valid but suboptimal
 * diff, so the same edit would segment differently on a fast machine than on a
 * loaded one and confidence would wobble across the orphan threshold. Bounding
 * the INPUT keeps the result identical everywhere.
 *
 * An ordinary save never comes close: the affixes strip everything but the
 * keystrokes, and a 60KB document with a 14-character insertion measures 0ms.
 * Above the cap the anchor degrades to the quote-and-context repair path, which
 * is what that path is for — a large enough rewrite is no longer an edit the
 * offsets can be carried through.
 */
export const MAX_EXACT_DIFF_REGION = 2048;

/** A fresh object per call: a shared constant would be mutable by callers. */
function orphaned(): AnchorResolution {
  return { status: 'orphaned' };
}

type OldRange = { from: number; to: number; confidence: number };

/**
 * Where the anchor sits in the OLD text. Normally its recorded offsets still
 * hold there — that is the content it was measured against. If the hint has
 * already drifted (an anchor ported through an earlier revision, say), repair it
 * against the old text first so the forward-port maps the right span.
 */
function locateInOldText(anchor: TextAnchor, oldText: string): OldRange | null {
  if (positionHolds(oldText, anchor)) {
    return { from: anchor.start, to: anchor.end, confidence: 1 };
  }

  const repaired = resolveAnchor(oldText, anchor);
  if (repaired.status === 'orphaned') {
    return null;
  }
  return { from: repaired.start, to: repaired.end, confidence: repaired.confidence };
}

/**
 * A span of text that survived the edit, in both coordinate systems. diff-utils
 * types the offsets as optional because they are absent on the one-sided
 * add/remove changes; on an `unchanged` change all three are always present.
 */
type SurvivingSpan = { oldStart: number; oldEnd: number; newStart: number };

function survivingSpans(changes: readonly DiffChange[]): SurvivingSpan[] {
  const spans: SurvivingSpan[] = [];
  for (const change of changes) {
    const { originalStart, originalEnd, newStart } = change;
    if (
      change.type !== 'unchanged' ||
      originalStart === undefined ||
      originalEnd === undefined ||
      newStart === undefined
    ) {
      continue;
    }
    spans.push({ oldStart: originalStart, oldEnd: originalEnd, newStart });
  }
  return spans;
}

/**
 * Map a single old-text offset forward. Null when it fell inside deleted text.
 * Spans are checked in order, so a caret sitting on the boundary of an edit
 * maps to the earlier side of it — i.e. it stays put rather than jumping over
 * text inserted at its position.
 */
function mapPoint(spans: readonly SurvivingSpan[], point: number): number | null {
  for (const span of spans) {
    if (point >= span.oldStart && point <= span.oldEnd) {
      return span.newStart + (point - span.oldStart);
    }
  }
  return null;
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) {
    i += 1;
  }
  return i;
}

function commonSuffixLength(a: string, b: string, floor: number): number {
  const limit = Math.min(a.length, b.length) - floor;
  let i = 0;
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) {
    i += 1;
  }
  return i;
}

/**
 * How much of the two texts actually differs — the same common-affix strip a
 * character diff would do first, but linear and done up front so the quadratic
 * part can be skipped when it would be too expensive.
 *
 * Exported because it is the policy behind MAX_EXACT_DIFF_REGION: which edits
 * keep the exact path and which degrade to repair is worth being able to state
 * and test directly, rather than only inferring it from a port's output.
 */
export function changedRegionSize(oldText: string, newText: string): number {
  const prefix = commonPrefixLength(oldText, newText);
  const suffix = commonSuffixLength(oldText, newText, prefix);
  return Math.max(oldText.length, newText.length) - prefix - suffix;
}

/**
 * Forward-port `anchor` from `oldText` to `newText`.
 *
 * Both arguments are projections (see text-projection.ts), never stored blobs.
 * Being a pure function of `(anchor, oldText, newText)` — rather than of
 * `(anchor, newText)` alone — is what makes the exact mapping possible.
 *
 * CALLER CONTRACT: `oldText` must be the projection the anchor was measured
 * against, and both projections must have been produced the same way. Neither
 * can be checked from here — this function receives two strings and has no way
 * to know which page or revision they came from — and getting it wrong yields a
 * confident wrong answer rather than an error, because a mislaid quote is still
 * found and still ported. `anchor.textHash` hashes the exact projection the
 * anchor was built against, so a call site that cares can compare it against
 * `hashText(oldText)` before trusting the result. Note that projectContent's
 * strategy is sniffed per revision and can flip on unclosed trailing markup
 * (see its own docs), which is one concrete way the two sides drift apart.
 */
export function portAnchor(
  anchor: TextAnchor,
  oldText: string,
  newText: string
): AnchorResolution {
  if (changedRegionSize(oldText, newText) > MAX_EXACT_DIFF_REGION) {
    return resolveAnchor(newText, anchor);
  }

  const located = locateInOldText(anchor, oldText);
  if (!located) {
    return orphaned();
  }

  // `format` because both sides are projections, which are plain text by
  // construction — saying so skips a sniff that would otherwise attempt to
  // JSON.parse the whole document on every port.
  //
  // `timeout: 0` because diff-utils otherwise imposes a one-second deadline,
  // and an expired deadline yields a valid but differently SEGMENTED diff. The
  // ported offsets would still be correct, but `survived` counts characters per
  // unchanged span, so the reported confidence — and the orphan decision at the
  // floor — would depend on how fast the machine happened to be.
  const spans = survivingSpans(
    diffContent(oldText, newText, { format: 'text', timeout: 0 }).changes
  );

  if (located.from === located.to) {
    const mapped = mapPoint(spans, located.from);
    if (mapped === null) {
      return orphaned();
    }
    return {
      status: mapped === anchor.start ? 'exact' : 'shifted',
      start: mapped,
      end: mapped,
      confidence: located.confidence,
    };
  }

  // Walk the surviving (unchanged) spans that overlap the anchor. Changes are
  // emitted in order, so the first overlap gives the new start and the last
  // gives the new end; anything inserted between them falls inside the ported
  // range, which is the desired behaviour for an edit made inside the quote.
  let portedStart = -1;
  let portedEnd = -1;
  let survived = 0;

  for (const span of spans) {
    const overlapStart = Math.max(located.from, span.oldStart);
    const overlapEnd = Math.min(located.to, span.oldEnd);
    if (overlapEnd <= overlapStart) {
      continue;
    }
    if (portedStart === -1) {
      portedStart = span.newStart + (overlapStart - span.oldStart);
    }
    portedEnd = span.newStart + (overlapEnd - span.oldStart);
    survived += overlapEnd - overlapStart;
  }

  if (survived === 0) {
    return orphaned();
  }

  // 'exact' is reserved for a quote that came through byte-identical AND still
  // sits at the offsets the anchor recorded. A repaired hint (confidence < 1)
  // could only land back on its recorded offsets by accident, so it never
  // claims to be exact.
  let status: 'exact' | 'shifted' | 'fuzzy' = 'fuzzy';
  if (newText.slice(portedStart, portedEnd) === anchor.exact) {
    status = portedStart === anchor.start && located.confidence === 1 ? 'exact' : 'shifted';
  }

  const fidelity = survived / (located.to - located.from);
  return {
    status,
    start: portedStart,
    end: portedEnd,
    confidence: Math.min(1, Math.max(0, fidelity * located.confidence)),
  };
}
