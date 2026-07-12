import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  abortStream,
  abortStreamByMessageId,
  wasRecentlyFinishedHere,
} from '@/lib/ai/core/stream-abort-registry';
import { abortConversationStreams } from '@/lib/ai/core/abort-conversation-streams';
import {
  awaitAbortSettled,
  markAbortRequested,
  reconcileDeadStreamRows,
} from '@/lib/ai/core/stream-abort-mark';
import type { AbortCode } from '@/lib/ai/core/stream-abort-decisions';

export interface AbortOutcomeReport {
  aborted: boolean;
  code: AbortCode;
  reason: string;
}

const ABORTED: AbortOutcomeReport = {
  aborted: true,
  code: 'aborted',
  reason: 'Stream aborted by user request',
};

const NOT_FOUND: AbortOutcomeReport = {
  aborted: false,
  code: 'not_found',
  reason: 'No in-flight stream on this conversation',
};

const UNCONFIRMED: AbortOutcomeReport = {
  aborted: false,
  code: 'unconfirmed',
  reason: 'The stream could not be confirmed stopped and may still be running',
};

/**
 * Stop a generation, wherever in the fleet it is actually running.
 *
 * The one entry point behind POST /api/ai/abort. Everything about Stop that used to be
 * best-effort is decided here.
 *
 * THE ORDER MATTERS. A registry miss is ambiguous, and the three things it can mean demand three
 * different answers:
 *
 *   1. THIS INSTANCE OWNS IT → abort synchronously and return. Instant: no DB round trip, no wait.
 *      The common case, and it must stay fast. A precise name short-circuits here.
 *   2. THIS INSTANCE FINISHED IT, moments ago → nothing is running. `onFinish` unregisters the
 *      controller long before it writes the terminal status, so for that window the row still
 *      reads 'streaming' with a live heartbeat and looks EXACTLY like a stream owned elsewhere.
 *      Escalating would time out against that live heartbeat and warn the user their agent is
 *      "still billing" — about a generation that has already completed. The tombstone
 *      (`wasRecentlyFinishedHere`) is what tells these two apart, and the answer here is SILENT.
 *   3. ANOTHER INSTANCE OWNS IT → mark the row and wait for its owner to consume the mark.
 *
 * WHAT THE CALLER GETS BACK, and why it is three values and not a boolean:
 *
 *   - 'aborted'     — proven stopped.
 *   - 'not_found'   — nothing of the caller's was in flight. A BENIGN race: the stream ended a
 *                     beat before Stop was pressed. Must be silent at the UI.
 *   - 'unconfirmed' — a stream was found, an abort was requested, and it is STILL GENERATING.
 *                     Still calling write tools. Still billing. This is the one the user must be
 *                     told about, and until this change it was indistinguishable from the above.
 */
export const abortStreamAnywhere = async ({
  messageId,
  streamId,
  conversationId,
  userId,
}: {
  messageId?: string;
  streamId?: string;
  conversationId?: string;
  userId: string;
}): Promise<AbortOutcomeReport> => {

  // Step 1 — the local registry. messageId is the most precise name, then streamId;
  // conversationId is the fallback that works before either exists client-side.
  //
  // A local hit on a PRECISE name is the end of the story, and must short-circuit.
  //
  // Aborting the controller is what stops the generation; the row's `status` is only bookkeeping,
  // and `lifecycle.finish` writes it fire-and-forget. So if we fell through to the cross-instance
  // path here, we would mark and then POLL for a terminal status that our own abort had already
  // guaranteed — and a slow or failed bookkeeping write would time the poll out against a
  // heartbeat that is still fresh (it beat seconds ago), yielding 'unconfirmed'. We would warn the
  // user that a generation is "still running and still billing" immediately after killing it
  // in-process. That is the exact false alarm this design exists to prevent, and it would fire on
  // the COMMON path — the stream this instance owns.
  //
  // It also costs a needless DB write and poll on every same-instance Stop, which is most of them.
  if (messageId) {
    if (abortStreamByMessageId({ messageId, userId }).aborted) return ABORTED;
  } else if (streamId) {
    if (abortStream({ streamId, userId }).aborted) return ABORTED;
  }

  // It finished HERE, moments ago. Nothing is running, so say nothing — see the docblock. Without
  // this, the most ordinary Stop of all (pressed as the last tokens render) is indistinguishable
  // from a stream owned by another instance, and gets escalated into a false "still billing" alarm.
  if ((messageId || streamId) && wasRecentlyFinishedHere({ messageId, streamId })) {
    return NOT_FOUND;
  }

  // The conversation path cannot short-circuit the same way: it names a SET, and stopping the
  // rows this instance owns says nothing about a sibling stream owned by another instance. So we
  // stop what we can, then escalate — but we never wait on the ones we ourselves just stopped.
  const locallyAborted = conversationId && !messageId && !streamId
    ? (await abortConversationStreams({ conversationId, userId })).aborted
    : [];

  // Step 2 — anything not stopped here is either on another instance, already finished, or was
  // never ours. The mark's WHERE clause carries `userId`, so the third case updates zero rows and
  // is reported as 'not_found'. See stream-abort-mark.ts: that predicate IS the authorization.
  const { marked, failed } = await markAbortRequested({ messageId, streamId, conversationId, userId });

  if (failed) {
    // The request was never RECORDED — the DB write itself did not happen. That is not the benign
    // "nothing was in flight" (which the UI is designed to stay silent about); it means the Stop
    // reached nobody, and the generation is still running, still calling write tools, and still
    // billing while the button flips back to Send. It has to be loud.
    loggers.ai.error('cross-instance abort: could not record the abort request', {
      userId,
      conversationId,
    });
    return UNCONFIRMED;
  }

  // Rows we aborted in-process a moment ago, or that finished here, may still read 'streaming'
  // (the terminal write is fire-and-forget) and so may still be caught by the mark. Waiting on any
  // of them would reintroduce the false alarm above: nothing will ever "settle" them from our
  // point of view, because there is no longer anything here to do the settling. We do not need a
  // DB row to tell us about a generation this process ran itself.
  const awaiting = marked.filter(
    (id) => !locallyAborted.includes(id) && !wasRecentlyFinishedHere({ messageId: id }),
  );

  // Nothing left to wait for: we stopped (or finished) it all ourselves, or there was nothing of
  // the caller's in flight to stop.
  if (awaiting.length === 0) {
    return locallyAborted.length > 0 ? ABORTED : NOT_FOUND;
  }

  const outcome = await awaitAbortSettled({ messageIds: awaiting });

  // Rows whose owning process is provably gone (stale heartbeat). Nothing is running, but nothing
  // wrote their terminal status either — so write it, exactly as a takeover would.
  await reconcileDeadStreamRows({ messageIds: outcome.reconcile });

  if (outcome.code === 'unconfirmed') {
    // The honest, narrow alarm. In steady state this never fires; during a rolling deploy (an old
    // worker that predates the abort watcher still owns the stream) it is the most valuable line
    // in the log, and the user is being billed for every second of it.
    loggers.ai.warn('cross-instance abort: requested, but the stream is still generating', {
      userId,
      conversationId,
      messageIds: outcome.stillLive,
    });

    return UNCONFIRMED;
  }

  return ABORTED;
};
