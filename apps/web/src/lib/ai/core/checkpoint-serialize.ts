import type { UIMessage } from 'ai';
import { mergeTextDeltas } from '@/lib/ai/streams/mergeTextDeltas';

/**
 * Shapes the multicast registry's raw buffer into what's actually written to
 * `aiStreamSessions.parts`. Pure — no DB, no I/O.
 *
 * The registry buffers one entry per pushed part, including one per text-delta chunk. Left
 * unreduced, a checkpoint of a long reply serializes an ever-growing array of single-token
 * fragments. `mergeConsecutiveTextParts` folds it down to the same shape a client renders —
 * reusing the exact reduction `apps/web/src/lib/ai/streams/mergeTextDeltas.ts` already applies
 * client-side, rather than re-deriving the merge rule here.
 */

type AnyPart = UIMessage['parts'][number];

export const mergeConsecutiveTextParts = (parts: readonly AnyPart[]): AnyPart[] =>
  parts.reduce<AnyPart[]>(
    (acc, part) => (part.type === 'text' ? mergeTextDeltas(acc, part) : [...acc, part]),
    [],
  );

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
 */
export const capPartsToByteBudget = (
  parts: readonly AnyPart[],
  maxBytes: number = CHECKPOINT_MAX_SERIALIZED_BYTES,
): { parts: AnyPart[]; wasCapped: boolean } => {
  if (parts.length === 0) return { parts: [], wasCapped: false };

  const sizes = parts.map((part) => Buffer.byteLength(JSON.stringify(part), 'utf8'));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= maxBytes) return { parts: [...parts], wasCapped: false };

  let kept = parts.length;
  let runningTotal = total;
  while (kept > 1 && runningTotal > maxBytes) {
    runningTotal -= sizes[parts.length - kept];
    kept -= 1;
  }
  return { parts: parts.slice(parts.length - kept), wasCapped: true };
};
