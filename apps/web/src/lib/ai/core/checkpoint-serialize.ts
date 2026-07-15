import type { UIMessage } from 'ai';
import { appendPart } from '@/lib/ai/streams/appendPart';

/**
 * Shapes the multicast registry's raw buffer into what's actually written to
 * `aiStreamSessions.parts`. Pure — no DB, no I/O.
 *
 * The registry buffers one entry per pushed part: one per text-delta chunk, and a separate
 * frame per tool-call state transition (input-available, then output-available/output-error
 * for the SAME toolCallId). Left unreduced, a checkpoint of a long reply serializes an
 * ever-growing array of single-token fragments plus stale intermediate tool states.
 * `convergeRawParts` folds it down to the same converged shape a client renders — reusing
 * `apps/web/src/lib/ai/streams/appendPart.ts` (the exact reduction the client's own bootstrap
 * fold and live-append path already apply) rather than re-deriving the merge/dedup rule here.
 */

type AnyPart = UIMessage['parts'][number];

export const convergeRawParts = (parts: readonly AnyPart[]): AnyPart[] =>
  convergeRawPartsWithOrigins(parts).parts;

/**
 * Same fold as `convergeRawParts`, but also tracks the RAW index (into `parts`) at which each
 * merged element was FIRST created — i.e. `originRawIndex[m]` is where merged element `m` starts
 * in the raw stream. An update-in-place (a tool part's state transition, replaced by
 * `appendPart`'s `toolCallId` match) does not move an element's position, so it does not change
 * that element's origin — only a brand-new push does.
 *
 * This is what `capPartsToByteBudget` needs to answer "how far into the raw stream does the
 * surviving (capped) snapshot's earliest content start?" — see its `wasCapped` doc for why that
 * position, not the total raw count, must become `rawPartsCount` once capping drops content.
 */
export const convergeRawPartsWithOrigins = (
  parts: readonly AnyPart[],
): { parts: AnyPart[]; originRawIndex: number[] } => {
  let acc: AnyPart[] = [];
  const originRawIndex: number[] = [];
  parts.forEach((part, rawIndex) => {
    const before = acc.length;
    acc = appendPart(acc, part);
    if (acc.length > before) {
      originRawIndex.push(rawIndex);
    }
  });
  return { parts: acc, originRawIndex };
};

/** ~5MB — bounds how large a single checkpoint write's `parts` column can grow. */
export const CHECKPOINT_MAX_SERIALIZED_BYTES = 5 * 1024 * 1024;

/**
 * Trims the oldest parts until the (merged) snapshot fits `maxBytes`, keeping the tail — a
 * client rejoining mid-stream cares about the most recent content, not the earliest.
 *
 * Never returns an empty array for a non-empty input: `getBufferedParts` returning `[]` means
 * "no live registry entry" everywhere else in this file's caller (stream-lifecycle.ts), and a
 * cap-induced `[]` would be indistinguishable from that — silently wiping the crash-recovery
 * snapshot instead of merely truncating it. So even a single part larger than the whole budget
 * is kept alone rather than dropped.
 *
 * `originRawIndex` (from `convergeRawPartsWithOrigins`, one entry per element of `parts`,
 * parallel arrays) is required so a capped result can report `survivingFromRawIndex`: the raw
 * index the surviving `shaped[0]` actually starts at. Trimming here only ever drops a PREFIX of
 * `parts`, so `originRawIndex` is trimmed the same way — no re-derivation needed.
 *
 * WHY THIS MATTERS (D-task yfz5p85c584z3ekvdfc3qx4e): `rawPartsCount`, persisted alongside this
 * capped snapshot, tells a rejoining client how many RAW frames from the (never-capped) live
 * multicast buffer to SKIP, because the seed already reflects their effect. If capping ever drops
 * content, the seed no longer reflects the raw frames that fed the dropped elements — skipping
 * past them anyway (the old unconditional `parts.length` behavior) permanently loses that content,
 * since the live buffer replay is the only remaining place it exists. Reporting
 * `survivingFromRawIndex` instead means the client under-skips (replays some frames whose effect
 * is already in the seed) rather than over-skips — a harmless, self-correcting duplicate-text
 * glitch in the one direction this module's docs already call safe, instead of a silent permanent
 * gap in the other.
 *
 * `wasCapped` (total exceeded `maxBytes`) and `prefixDropped` (a merged element was actually
 * trimmed off the front) are DISTINCT, and the caller must key `rawPartsCount`'s fallback on the
 * latter, not the former. When the single surviving part alone already exceeds `maxBytes` (see
 * the "kept at least that one part" doc above), `wasCapped` is `true` but nothing was droppable —
 * `survivingFromRawIndex` in that case is just where that one part FIRST started, which discards
 * every raw frame that went on to EXTEND it (e.g. a huge merged text run built from thousands of
 * text-delta chunks). Using it as `rawPartsCount` there would tell a rejoining client to skip
 * almost nothing and re-replay the entire already-seeded content on top of itself — a real
 * duplication bug a Codex review caught, distinct from (and not fixed by) `prefixDropped` alone
 * gating the ORIGINAL over-skip bug this function exists to close.
 */
export const capPartsToByteBudget = (
  parts: readonly AnyPart[],
  originRawIndex: readonly number[],
  maxBytes: number = CHECKPOINT_MAX_SERIALIZED_BYTES,
): { parts: AnyPart[]; wasCapped: boolean; survivingFromRawIndex: number; prefixDropped: boolean } => {
  if (parts.length === 0) {
    return { parts: [], wasCapped: false, survivingFromRawIndex: 0, prefixDropped: false };
  }

  const sizes = parts.map((part) => Buffer.byteLength(JSON.stringify(part), 'utf8'));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= maxBytes) {
    return { parts: [...parts], wasCapped: false, survivingFromRawIndex: 0, prefixDropped: false };
  }

  let kept = parts.length;
  let runningTotal = total;
  while (kept > 1 && runningTotal > maxBytes) {
    runningTotal -= sizes[parts.length - kept];
    kept -= 1;
  }
  const droppedCount = parts.length - kept;
  return {
    parts: parts.slice(droppedCount),
    wasCapped: true,
    survivingFromRawIndex: originRawIndex[droppedCount] ?? 0,
    prefixDropped: droppedCount > 0,
  };
};
