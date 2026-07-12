import { loggers } from '@pagespace/lib/logging/logger-config';
import { abortStream, abortStreamByMessageId } from '@/lib/ai/core/stream-abort-registry';
import { abortConversationStreams } from '@/lib/ai/core/abort-conversation-streams';
import {
  awaitAbortSettled,
  markAbortRequested,
  reconcileDeadStreamRows,
} from '@/lib/ai/core/stream-abort-mark';
import type { AbortCode } from '@/lib/ai/core/stream-abort-decisions';

/**
 * Stop a generation, wherever in the fleet it is actually running.
 *
 * The one entry point behind POST /api/ai/abort. Everything about Stop that used to be
 * best-effort is decided here.
 *
 * TWO STEPS, AND THE ORDER MATTERS:
 *
 *   1. Try the LOCAL registry. If this instance owns the stream, the abort is synchronous and
 *      instant — no DB round trip, no waiting. This is the common case and it must stay fast.
 *   2. Only on a miss, go cross-instance: mark the row and wait for the owner to consume it.
 *
 * The `status='streaming'` predicate on the mark is what makes step 2 safe to run unconditionally
 * after step 1: a stream we just aborted locally has already been driven terminal by its attached
 * finisher, so it is not re-marked. (If its terminal write has not landed yet, the mark is
 * harmless and the wait sees it settle a moment later.)
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
}): Promise<{ aborted: boolean; code: AbortCode; reason: string }> => {
  // Step 1 — the local registry. messageId is the most precise name, then streamId;
  // conversationId is the fallback that works before either exists client-side.
  const localAborted: string[] = messageId
    ? abortStreamByMessageId({ messageId, userId }).aborted ? [messageId] : []
    : streamId
      ? abortStream({ streamId, userId }).aborted ? [streamId] : []
      : conversationId
        ? (await abortConversationStreams({ conversationId, userId })).aborted
        : [];

  // Step 2 — anything not stopped here is either on another instance, already finished, or was
  // never ours. The mark's WHERE clause carries `userId`, so the third case updates zero rows and
  // is reported as 'not_found'. See stream-abort-mark.ts: that predicate IS the authorization.
  const marked = await markAbortRequested({ messageId, streamId, conversationId, userId });

  if (marked.length === 0) {
    return localAborted.length > 0
      ? { aborted: true, code: 'aborted', reason: 'Stream aborted by user request' }
      : { aborted: false, code: 'not_found', reason: 'No in-flight stream on this conversation' };
  }

  const outcome = await awaitAbortSettled({ messageIds: marked });

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

    return {
      aborted: false,
      code: 'unconfirmed',
      reason: 'The stream could not be confirmed stopped and may still be running',
    };
  }

  return {
    aborted: true,
    code: 'aborted',
    reason: 'Stream aborted by user request',
  };
};
