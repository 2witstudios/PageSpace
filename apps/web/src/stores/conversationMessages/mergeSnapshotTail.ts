import type { UIMessage } from 'ai';

export interface MergeSnapshotTailResult {
  messages: UIMessage[];
  /** True when the snapshot overlapped the cached window and older cached rows were preserved in front of it. */
  overlapped: boolean;
}

/**
 * Merges a background snapshot (the conversation's LATEST page, no cursor) into
 * an already-cached message list that may hold older pages loaded via
 * "load older".
 *
 * A snapshot fetch returns only the newest N rows. Replacing the cache with it
 * wholesale silently discards every older loaded page while `olderCursor`
 * still points below them — the visible history disappears AND the next
 * load-older starts past the discarded range, skipping it entirely (Codex P2,
 * PR #2320). Instead:
 *
 * - Overlap (the common case — the snapshot window reaches back into the
 *   cached rows): every cached row BEFORE the first row the snapshot also has
 *   is older history the snapshot simply didn't reach — keep it, in place, in
 *   front of the snapshot. The oldest row is unchanged, so the existing
 *   `olderCursor` stays exactly correct.
 * - No overlap (pathological — more rows arrived since the cache was current
 *   than the snapshot window holds, or the cache was empty): the cached rows
 *   can't be stitched to the snapshot without inventing a gap in the middle;
 *   return the snapshot alone (fresh-load semantics — the caller resets
 *   pagination from the snapshot's own envelope).
 *
 * Pure — never mutates its inputs. Both lists are assumed DB-ordered.
 */
export const mergeSnapshotTail = (
  cached: readonly UIMessage[],
  snapshot: readonly UIMessage[],
): MergeSnapshotTailResult => {
  if (cached.length === 0 || snapshot.length === 0) {
    return { messages: [...snapshot], overlapped: false };
  }
  const snapshotIds = new Set(snapshot.map((m) => m.id));
  const firstOverlapIdx = cached.findIndex((m) => snapshotIds.has(m.id));
  if (firstOverlapIdx === -1) {
    return { messages: [...snapshot], overlapped: false };
  }
  return { messages: [...cached.slice(0, firstOverlapIdx), ...snapshot], overlapped: true };
};
