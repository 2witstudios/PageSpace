import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { abortStreamByMessageId, wasRecentlyFinishedHere } from '@/lib/ai/core/stream-abort-registry';
import { decideStreamTakeover } from '@/lib/ai/core/stream-liveness';
import {
  awaitAbortSettled,
  markAbortRequestedAsOwner,
  reconcileDeadStreamRows,
} from '@/lib/ai/core/stream-abort-mark';
import { TAKEOVER_SETTLE_TIMEOUT_MS } from '@/lib/ai/core/stream-horizons';

/**
 * Per-conversation in-flight guard. Used by both chat routes (POST /api/ai/chat and
 * POST /api/ai/global/[id]/messages) — every path that starts a generation.
 *
 * ── WHAT THIS DOES NOT GUARANTEE ────────────────────────────────────────────────────────────
 *
 * It does NOT enforce "at most one generation per conversation", and you must not write code
 * that assumes it does. This is a check-then-act with no serialization: the SELECT below and the
 * INSERT in `createStreamLifecycle` — which is what would make a peer see this generation — are
 * not atomic together. Two near-simultaneous sends can BOTH find zero in-flight rows and BOTH
 * proceed: two generations, two sets of tool calls, two bills.
 *
 * Closing it needs DB-level serialization: an advisory lock spanning takeover+insert, or a
 * partial unique index on (conversation_id) WHERE status='streaming' — whose migration would
 * fail outright on any pre-existing duplicate rows, so it needs a reconciliation step first.
 * That is its own change, with its own migration risk. `master` has no takeover at all
 * (concurrent sends there ALWAYS double-generate), so what follows is a strict improvement — it
 * narrows the window, it does not eliminate it.
 *
 * Stated here because the call site's comment used to claim the opposite, and a comment that
 * promises a guarantee the code lacks is how the next person builds on a false premise.
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────────────────────────────
 *
 * Before a new generation starts on a conversation, anything already in flight on that
 * conversation is taken over:
 *
 *   1. EVERY in-flight row gets an abort attempt, as the stream's OWNER. Liveness never
 *      gates this: aborting a messageId this process doesn't know is free, while skipping
 *      an abort for a row we misjudged as dead leaves a real generation running.
 *   2. Only rows we can PROVE are finished — the ones the registry actually aborted, plus
 *      the ones whose heartbeat says their process is gone — are driven terminal. A live
 *      row we could not abort is left alone: marking it 'aborted' and wiping its parts would
 *      hide a running stream from every subscriber and destroy its only crash-recovery snapshot.
 *   3. A live row we could not abort belongs to ANOTHER WEB INSTANCE (the registry is
 *      in-process). It is marked for a cross-instance abort and we wait, briefly, for its owner
 *      to stop it. This used to be the end of the road: the send simply proceeded alongside a
 *      still-running generation — two agents, two sets of write tools, two bills.
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

    // A live row this instance does not own. This USED to be the end of the road — it was logged
    // ("in-flight stream(s) could not be aborted from this instance") and the send proceeded,
    // starting a SECOND generation beside a first that was still running: two agents, two sets of
    // write tools, two bills. The abort registry is in-process, so there was genuinely nothing
    // more this instance could do.
    //
    // There is now. Mark the row and wait for the instance that owns it to consume the mark and
    // stop the stream.
    const unstoppable = rows
      .map((r) => r.messageId)
      .filter((id) => !aborted.includes(id) && !reconcile.includes(id))
      // A generation that FINISHED on this instance is not "unstoppable" — it is over. Its row
      // lingers at 'streaming' with a live heartbeat until the terminal write lands at the end of
      // onFinish (after message persistence and per-tool billing), so without this it looks exactly
      // like a live stream on another instance: we would mark it, wait the full budget for an owner
      // that no longer exists, and warn. On a rapid follow-up send — the common case — every time.
      .filter((id) => !wasRecentlyFinishedHere({ messageId: id }));

    let remotelyAborted: string[] = [];
    let remotelyReconciled: string[] = [];
    let stillLive: string[] = [];

    if (unstoppable.length > 0) {
      // As the stream's OWNER, not the caller — the exact analogue of the abort loop above, and
      // for the same reason: on a SHARED conversation, user B's send must be able to take over
      // user A's generation. See markAbortRequestedAsOwner, which may never be reached from a
      // client-driven Stop.
      const { marked, failed } = await markAbortRequestedAsOwner({ messageIds: unstoppable });

      if (failed) {
        // The abort request was never RECORDED, so nothing will ever consume it. This send is
        // about to start a second generation beside a live one — two agents, two sets of write
        // tools, two bills — and an empty result would read exactly like "there was nothing to
        // stop". Say what actually happened.
        loggers.ai.error('AI Chat API: could not record cross-instance abort for in-flight stream(s); generating alongside them', {
          conversationId,
          channelId,
          messageIds: unstoppable,
        });
      }

      // Bounded: the user is waiting for their message to send. Shorter than a user-facing Stop's
      // budget, and on expiry we proceed exactly as before rather than blocking the send.
      const outcome = await awaitAbortSettled({
        messageIds: marked,
        timeoutMs: TAKEOVER_SETTLE_TIMEOUT_MS,
      });

      remotelyAborted = outcome.aborted;
      remotelyReconciled = outcome.reconcile;
      stillLive = outcome.stillLive;

      // Rows whose owner is provably gone (stale heartbeat) — nothing is running, but nothing
      // wrote their terminal status either. Same licence decideStreamTakeover already grants.
      await reconcileDeadStreamRows({ messageIds: outcome.reconcile });

      if (stillLive.length > 0) {
        // The honest, narrower successor to the old warn. It no longer means "we cannot stop
        // this" — it means "we asked, and it has not stopped yet". In steady state it never
        // fires; during a rolling deploy, where an old worker without the abort watcher still
        // owns the stream, it is the single most valuable line in the log.
        loggers.ai.warn('AI Chat API: in-flight stream(s) marked for cross-instance abort but not confirmed stopped', {
          conversationId,
          channelId,
          messageIds: stillLive,
          waitedMs: TAKEOVER_SETTLE_TIMEOUT_MS,
        });
      }
    }

    const allAborted = [...aborted, ...remotelyAborted];
    // Rows driven terminal by the cross-instance path are reconciled just as surely as the ones
    // this instance reconciled directly. Leaving them out under-reports what the takeover actually
    // did — and this module's own docblock is emphatic that a log which misreports attests to
    // nothing, which is the same defect as a test that cannot fail.
    const allReconciled = [...reconcile, ...remotelyReconciled];

    // Only claim a takeover when one actually happened.
    //
    // This used to log "took over in-flight stream(s)" unconditionally — including when we had
    // taken over NOTHING and were about to generate alongside a live foreign stream. That was the
    // exact moment an operator most needed the truth, and the log said the opposite.
    if (allAborted.length > 0 || allReconciled.length > 0) {
      loggers.ai.info('AI Chat API: took over in-flight stream(s) on this conversation', {
        conversationId,
        channelId,
        aborted: allAborted,
        reconciled: allReconciled,
      });
    }

    return { aborted: allAborted, reconciled: allReconciled };
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
