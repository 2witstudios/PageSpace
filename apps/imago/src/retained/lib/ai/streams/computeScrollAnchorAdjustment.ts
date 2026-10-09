export interface ScrollAnchorInput {
  prevMessageIds: readonly string[];
  nextMessageIds: readonly string[];
  prevScrollHeight: number;
  nextScrollHeight: number;
}

/**
 * Decides whether a "load older" prepend (epic leaf 6.6, M11) needs a
 * scrollTop compensation to keep the viewport anchored, and by how much.
 * Returns 0 for anything that is not a genuine prepend — most importantly a
 * live stream appending a new tail message (or growing its own last
 * message's content in place), which must never be compensated: only the
 * TOP of the list moved for a prepend, so the last id staying identical
 * while the array grows is the one reliable signal.
 */
export const computeScrollAnchorAdjustment = (input: ScrollAnchorInput): number => {
  const { prevMessageIds, nextMessageIds, prevScrollHeight, nextScrollHeight } = input;
  if (prevMessageIds.length === 0) return 0;
  if (nextMessageIds.length <= prevMessageIds.length) return 0;

  const prevLast = prevMessageIds[prevMessageIds.length - 1];
  const nextLast = nextMessageIds[nextMessageIds.length - 1];
  if (prevLast !== nextLast) return 0;

  const delta = nextScrollHeight - prevScrollHeight;
  return delta > 0 ? delta : 0;
};
