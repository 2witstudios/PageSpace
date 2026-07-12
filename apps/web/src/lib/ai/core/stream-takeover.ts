import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { abortStreamByMessageId } from '@/lib/ai/core/stream-abort-registry';
import { decideStreamTakeover } from '@/lib/ai/core/stream-liveness';

/**
 * Per-conversation in-flight guard. Used by both chat routes (POST /api/ai/chat and
 * POST /api/ai/global/[id]/messages) — every path that starts a generation.
 *
 * Before a new generation starts on a conversation, anything already in flight on that
 * conversation is taken over:
 *
 *   1. EVERY in-flight row gets an abort attempt, as the stream's OWNER. Liveness never
 *      gates this: aborting a messageId this process doesn't know is free, while skipping
 *      an abort for a row we misjudged as dead leaves a real generation running.
 *   2. Only rows we can PROVE are finished — the ones the registry actually aborted, plus
 *      the ones whose heartbeat says their process is gone — are driven terminal. A live
 *      row we could not abort (it belongs to another web instance) is left alone: marking
 *      it 'aborted' and wiping its parts would hide a running stream from every subscriber
 *      and destroy its only crash-recovery snapshot.
 *
 * The new generation then proceeds regardless — see `stream-liveness.ts` for why this is a
 * takeover and never a 409.
 *
 * Without this, a second send simply starts a second generation on the same conversation —
 * two agents editing the same pages, two assistant rows, two bills. (The only pre-existing
 * limiter is the credit gate's per-USER `maxInFlight`, which is per-user, not
 * per-conversation, and is skipped entirely for metering-exempt providers.)
 */
export const takeOverConversationStreams = async ({
  conversationId,
  channelId,
  now = Date.now(),
}: {
  conversationId: string;
  channelId: string;
  now?: number;
}): Promise<{ aborted: string[]; reconciled: string[] }> => {
  try {
    const rows = await db
      .select({
        messageId: aiStreamSessions.messageId,
        // The stream's OWNER — not the caller. See the abort loop below.
        userId: aiStreamSessions.userId,
        lastHeartbeatAt: aiStreamSessions.lastHeartbeatAt,
        startedAt: aiStreamSessions.startedAt,
      })
      .from(aiStreamSessions)
      .where(and(
        eq(aiStreamSessions.conversationId, conversationId),
        eq(aiStreamSessions.channelId, channelId),
        eq(aiStreamSessions.status, 'streaming'),
      ));

    if (rows.length === 0) return { aborted: [], reconciled: [] };

    // Abort EVERY in-flight row, without consulting liveness. An abort for a messageId
    // this process doesn't own is a no-op that returns `{aborted:false}`; SKIPPING an
    // abort for a row we wrongly judged dead leaves a real generation running and starts
    // a second one beside it. Only the outcome of these calls is trustworthy — never our
    // liveness guess. (`decideStreamTakeover().abort` encodes exactly this set: every
    // row. Iterating `rows` here is the same thing, and keeps the owner id in hand.)
    //
    // Abort as the stream's OWNER, not as the caller. `abortStream` refuses an abort
    // whose userId doesn't match the stream's — an IDOR guard that exists for the
    // client-facing POST /api/ai/abort endpoint. This is not that: it is a trusted
    // server-side path, and the caller's right to write to this conversation was already
    // established upstream (page edit access, plus the ownership/shared check on
    // conversationId in the route; the global route hard-throws on a foreign
    // conversation). Passing the caller's id would make the guard refuse every
    // cross-user abort, so on a SHARED conversation user B's send would leave user A's
    // generation running — still calling tools, still editing pages, still billing —
    // while B's new one started beside it. Which is the entire thing this guard exists
    // to prevent.
    const aborted: string[] = [];
    for (const row of rows) {
      const result = abortStreamByMessageId({ messageId: row.messageId, userId: row.userId });
      if (result.aborted) aborted.push(row.messageId);
    }

    // Only NOW decide what may be driven terminal: what we actually stopped, plus what is
    // provably dead. A row we could NOT abort and that still looks alive belongs to
    // another web instance (the registry is single-process). It is still generating —
    // marking it 'aborted' and wiping its parts would hide a live stream from every
    // subscriber and destroy its only crash-recovery snapshot.
    const { reconcile } = decideStreamTakeover({ rows, abortedMessageIds: aborted, now });

    if (reconcile.length > 0) {
      // Its OWN catch, deliberately.
      //
      // By this point the aborts above have already landed: real in-process generations have
      // been STOPPED. If this UPDATE then throws and the outer catch swallows it, we return
      // `{aborted: [], reconciled: []}` — "nothing happened" — which is a lie. Streams were
      // stopped, and their rows are still `status='streaming'`, so every reader treats them as
      // live: /active-streams advertises them, clients render a Stop button for a generation that
      // is already dead. The one thing the caller must be told accurately is what was actually
      // aborted, and the old shape guaranteed it would be told the opposite.
      //
      // The rows self-heal: a stopped generation stops beating, so within
      // STREAM_HEARTBEAT_STALE_MS the liveness predicate calls them dead, /active-streams stops
      // serving them, and the next takeover reconciles them. That is exactly the failure mode the
      // heartbeat exists to absorb — so the right move is to report the truth and let it, not to
      // fail the send.
      try {
        // Conditional on status so a stream that terminated on its own between the
        // SELECT and here isn't retroactively relabelled 'aborted'.
        await db
          .update(aiStreamSessions)
          .set({ status: 'aborted', completedAt: new Date(), parts: [] })
          .where(and(
            inArray(aiStreamSessions.messageId, reconcile),
            eq(aiStreamSessions.status, 'streaming'),
          ));
      } catch (error) {
        loggers.ai.warn('AI Chat API: takeover aborted streams but could not reconcile their rows', {
          conversationId,
          channelId,
          // The streams ARE stopped. These rows will read 'streaming' until their heartbeat
          // goes stale (~2 min), then be reconciled by the next takeover.
          aborted,
          unreconciled: reconcile,
          error: error instanceof Error ? error.message : 'unknown',
        });
        return { aborted, reconciled: [] };
      }
    }

    const unstoppable = rows
      .map((r) => r.messageId)
      .filter((id) => !aborted.includes(id) && !reconcile.includes(id));
    if (unstoppable.length > 0) {
      // Known limitation, logged rather than papered over: the abort registry is
      // in-process, so a live stream owned by another web instance cannot be stopped
      // from here. It will finish and persist normally; this send runs alongside it.
      loggers.ai.warn('AI Chat API: in-flight stream(s) could not be aborted from this instance', {
        conversationId,
        channelId,
        messageIds: unstoppable,
      });
    }

    loggers.ai.info('AI Chat API: took over in-flight stream(s) on this conversation', {
      conversationId,
      channelId,
      aborted,
      reconciled: reconcile,
    });

    return { aborted, reconciled: reconcile };
  } catch (error) {
    // Never block the send on a failed takeover — the worst case is the
    // pre-existing behaviour (a concurrent generation), not a locked chat.
    loggers.ai.warn('AI Chat API: stream takeover failed', {
      conversationId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return { aborted: [], reconciled: [] };
  }
};
