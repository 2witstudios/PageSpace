/**
 * A per-conversation count of Stop presses — the one signal that makes Stop honest during the
 * window where the SERVER has nothing to stop.
 *
 * `markAbortRequested` can only mark rows that already exist with `status = 'streaming'`. It has
 * no way to record an abort for a generation that has not started, so a Stop pressed before the
 * POST is out matches zero rows, answers `not_found`, and `reportAbortOutcome` is deliberately
 * silent about that. For a send that window is server-side TTFB only. For a RETRY it is bigger
 * and it is ours: `useMessageActions.handleRetry` awaits a full DELETE round trip before it
 * issues the regenerate, and the composer has been showing Stop for all of it (the retry now
 * runs inside `wrapSend`). Press Stop there and the old behaviour was the worst one available —
 * the abort found nothing, said nothing, and the client then started the generation anyway.
 *
 * So the client records the press and the retry checks for it before dispatching. A COUNTER
 * rather than a flag, compared against a snapshot taken before the await, because that is
 * race-free without any clearing: nothing has to decide when a stop request has "expired", and a
 * Stop pressed BEFORE a retry (the ordinary case — stop a stream, then retry it) moves the
 * counter before the snapshot is taken and therefore cannot cancel it.
 *
 * Keyed by conversation for the same reason everything else in this path is: concurrent sends in
 * different conversations are supported by design, and a Stop in A must not cancel a retry in B.
 *
 * Module state rather than a store — the one stateful thing in this directory, and deliberately
 * so. Nothing renders off it, so a store subscription would buy nothing but re-renders; it is
 * read at dispatch time, exactly like the `useEditingStore.getState()` call next to it. Nothing
 * is ever removed because nothing can be: an entry is one integer, gained only when the user
 * actually presses Stop in a conversation, in a map that dies with the page. Any eviction rule
 * would be a second thing that has to be right for Stop to stay honest.
 */
const stopEpochs = new Map<string, number>();

/** Record that Stop was pressed for this conversation. Call synchronously, at the click. */
export const recordStopRequest = (conversationId: string): void => {
  stopEpochs.set(conversationId, (stopEpochs.get(conversationId) ?? 0) + 1);
};

/**
 * The conversation's Stop count. Snapshot it before an await; if it has moved by the time the
 * await resolves, a Stop landed in between and whatever the await was leading up to must not run.
 */
export const readStopEpoch = (conversationId: string): number => stopEpochs.get(conversationId) ?? 0;
