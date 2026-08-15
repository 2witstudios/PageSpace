import { db } from '@pagespace/db/db';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { parseGlobalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { broadcastAiStreamComplete } from '@/lib/websocket';
import { buildAssistantPersistencePayload } from '@/lib/ai/core/persistAssistantParts';
import { extractStructuredContentFromParts } from '@/lib/ai/core/message-utils';
import { notifyMentionedUsers } from '@/lib/channels/notify-mentioned-users';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { messageRepository } from '@/lib/repositories/message-repository';
import { conversationEvents } from '@/lib/websocket/conversation-events';
import { readFrames } from '@/lib/ai/core/frame-log';
import { releaseFramesForMessage } from '@/lib/ai/core/frame-log-writer';
import { claimDeadStream, reapClaimFence, type ReapClaim } from '@/lib/ai/core/stream-reap-claim';
import { foldChunksToParts } from '@/lib/ai/streams/foldChunksToParts';
import type { UIMessagePart } from '@/lib/ai/core/stream-channel-registry';

/**
 * Turn a provably-dead stream into an honest, terminal assistant message instead of a
 * silent loss.
 *
 * ── IT TAKES A messageId AND CLAIMS THE ROW ITSELF ──────────────────────────────────────────
 *
 * It used to take a wide, pre-read row, and all three callers (`reconcileDeadStreamRows`,
 * `takeOverConversationStreams`, the `/active-streams` lazy sweep) ran their own SELECT of the
 * same seven columns to produce one. That was duplication with teeth rather than duplication as
 * a wart: the row a caller handed in was read seconds before the destructive write landed, so
 * every caller independently owned the same TOCTOU — and at N>1 the window is exactly where a
 * live generation on another instance gets destroyed.
 *
 * So the claim is taken HERE, and `RETURNING` supplies the row. What gets acted on is what the
 * row held at the instant the claim was won, in one statement, on Postgres's clock.
 *
 * THE CALLER STILL DECIDES ELIGIBILITY. `claimDeadStream`'s SQL predicate is deliberately
 * narrower than `isProvablyDead` — it cannot cheaply express `heartbeatStoppedAtCap` or
 * `isBeyondReconcileBackstop`, and a stream still alive at the heartbeat cap looks identical to
 * a dead one through it. Callers gate on `isProvablyDead` FIRST; the claim is the fence that
 * makes their (correct, but stale) decision safe to act on. See stream-reap-claim.ts.
 *
 * Three things then happen, in an order chosen so a failure at any step leaves the row eligible
 * for the NEXT sweep to retry rather than half-materialized:
 *
 *   1. Build the message payload from the parts snapshot (`buildAssistantPersistencePayload`,
 *      then `extractStructuredContentFromParts` — the SAME two-step pipeline execute-end and
 *      onFinish already use in `saveMessageToDatabase`/`saveGlobalAssistantMessageToDatabase`,
 *      so a materialized reply preserves file/data parts and ordering exactly like one the
 *      model actually finished, instead of degrading to flat extracted text).
 *   2. Upsert the assistant message row as `status: 'interrupted'` — but ONLY if it is still
 *      `'streaming'` (the placeholder state). That guard is the #2022 invariant, and it is
 *      deliberately compare-and-swap rather than a blanket "not complete": the old worker's own
 *      terminal write is fire-and-forget and can land in the gap between the caller's liveness
 *      read and this write — and it can ALSO leave a row `'interrupted'` (a clean Stop whose
 *      onFinish wrote full content but whose session-row settle then failed). Guarding on
 *      `!= 'complete'` would still let a later sweep clobber that already-correct interrupted
 *      row with an older debounced checkpoint; guarding on `== 'streaming'` cannot, because a
 *      row leaves `'streaming'` exactly once. A `setWhere` on the conflict clause makes the
 *      guard atomic — there is no separate read to race.
 *   3. Only once the message write is confirmed: settle the `ai_stream_sessions` row
 *      terminal (`status: 'aborted'`, parts cleared) and broadcast `stream_complete`.
 *      Settling first would let a crashed sweep lose the row's only content — the session
 *      row would read terminal while no terminal message ever got written. The settle carries
 *      the reap fence, so a claim that has been superseded — or an owner that started beating
 *      again after the claim committed — matches zero rows instead of hiding a live stream.
 *
 * THE RESIDUAL RACE, named rather than glossed: a heartbeat landing between the claim
 * committing and the fenced writes is caught by the FENCE, so neither the settle nor the frame
 * delete lands — but step 2's `messages` write has already happened by then, prematurely
 * marking the reply `'interrupted'`. That is recoverable and self-healing: the still-live
 * generation's own `saveUnifiedPageMessage` carries no `setWhere`, so its terminal write
 * overwrites the premature one with the real content. The row stays `'streaming'` throughout,
 * so the stream also stays visible, joinable and Stoppable in the meantime.
 *
 * Never throws. Every step logs and degrades — a reap that fails partway must not take
 * down the caller's loop over the rest of its batch (takeover, the abort-mark reconciler,
 * and the active-streams lazy sweep all call this per-row, in a loop). This is why step 1
 * — building the payload from `row.parts` — lives INSIDE the same try/catch as the DB write:
 * a malformed parts snapshot must degrade exactly like a failed write, not escape uncaught to
 * a caller that assumes this function never throws.
 *
 * Returns whether the row was actually driven fully terminal (message written AND the session
 * row settled) — `false` on any failure. Callers that aggregate this into a "reconciled" count
 * or log line MUST use the return value rather than assuming every call they made succeeded:
 * a `Promise.all` over several rows tells you nothing about which ones actually landed, and a
 * batch reported as "reconciled" when some rows silently stayed `'streaming'` is exactly the
 * misreporting bug (a log that attests to nothing) this module's sibling functions already
 * guard against.
 */
/**
 * Best-effort mirror of the finalize path's mention notifications for a page-chat reply this
 * sweep just materialized. The normal path (saveMessageToDatabase, message-utils.ts) fires
 * `notifyMentionedUsers` for an assistant save when the route's gate passes — the page has a
 * driveId, a user triggered the generation, and the conversation is explicitly shared. A dead
 * stream's materialization is the same terminal assistant write arriving by a different door,
 * so it re-derives that exact gate here (the route's in-memory `page` / `isConversationShared`
 * are gone with the dead process): page lookup for driveId + title (title doubles as the
 * mentioner name, same as the route's `mentionerName: page.title`), conversation lookup for
 * `isShared` — a missing row fails closed as private, matching the route's own comment.
 *
 * Best-effort by design: a failure here (lookup or notify) is warned, never propagated — the
 * reply itself was already durably materialized, and a notification must never un-succeed that.
 * Global-assistant rows never reach this (a global conversation has no page mention surface,
 * and the global save path has no mentionNotify seam either).
 */
const notifyMentionsBestEffort = async (row: ReapClaim, content: string): Promise<void> => {
  try {
    // The same readers the live paths use (never re-derived selects, per the reuse rail):
    // pageRepository.findById excludes trashed pages by default, so a page trashed between
    // stream death and this reap can't page drive members about content they can no longer
    // open; getConversation is the route's own source of isConversationShared.
    const page = await pageRepository.findById(row.channelId);
    if (!page) return;

    const conversation = await conversationRepository.getConversation(row.conversationId);
    if (conversation?.isShared !== true) return;

    await notifyMentionedUsers({
      content,
      pageId: row.channelId,
      driveId: page.driveId,
      triggeredByUserId: row.userId,
      mentionerNameOverride: page.title,
    });
  } catch (error) {
    loggers.ai.warn('materializeInterruptedStream: mention notification failed (best-effort)', {
      messageId: row.messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
};

/**
 * The dead stream's content, at the best fidelity anything left behind can give.
 *
 * PREFERS THE DURABLE FRAME LOG, which is the point of this whole leaf. `row.parts` is a
 * DEBOUNCED, FOLDED snapshot — up to one checkpoint interval stale by construction, and
 * historically bounded by the memory ring it was folded from. `ai_stream_frames` holds the
 * generation's own `UIMessageChunk`s, written in batches within ~200ms of being produced, so
 * folding them here reconstructs the same message a live client assembled from the same
 * frames. Same reduction (`foldChunksToParts`), same input: same reply.
 *
 * FALLS BACK TO `parts`, and must. A stream started by a worker from before this table had a
 * writer leaves no frames at all, and neither does one whose frames were already released by
 * a terminal write that then failed to settle its session row. `readFrames` answers `null`
 * for both — and for a read that failed outright — which is exactly the case where the older
 * snapshot is the only content there is. A `null`/`[]` distinction is load-bearing here:
 * treating "no frames" as "an empty reply" would materialize emptiness over a snapshot that
 * had content.
 *
 * BUT "THE LOG EXISTS" IS NOT "THE LOG IS LONGER", and an unconditional preference was a real
 * truncation bug (review finding — chatgpt-codex-connector, PR #2409). The two records are
 * written by INDEPENDENT mechanisms that stop for independent reasons: the writer gives up at
 * its first failed batch and at its durable-byte ceiling, leaving a valid but short contiguous
 * prefix, while the checkpoint fold carries on from memory. Preferring a 100-frame log over a
 * 5000-frame snapshot would silently materialize a truncated reply — the very failure this
 * leaf exists to prevent, introduced by its own fix.
 *
 * So they are COMPARED, on the one measure both express in the same unit: frames. The log's
 * length is its contiguous prefix; the snapshot's is `rawPartsCount`, which is exactly why
 * that column counts raw frames rather than merged parts. Ties go to the log — equal length
 * means equal content, and the log is the losslessly-folded original rather than a snapshot
 * that has already been through a fold.
 */
const recoverParts = async (row: ReapClaim): Promise<UIMessagePart[]> => {
  const frames = await readFrames(row.messageId);
  if (frames === null) return row.parts as UIMessagePart[];

  const snapshotFrames = row.rawPartsCount;
  if (frames.length < snapshotFrames) {
    loggers.ai.warn('materializeInterruptedStream: frame log is shorter than the checkpoint — using the snapshot', {
      messageId: row.messageId,
      loggedFrames: frames.length,
      snapshotFrames,
    });
    return row.parts as UIMessagePart[];
  }

  return foldChunksToParts(frames);
};

export const materializeInterruptedStream = async ({
  messageId,
  staleAfterMs,
}: {
  messageId: string;
  /** Overrides the staleness horizon the claim is taken at. Tests only — production callers
   *  share `STREAM_HEARTBEAT_STALE_MS` with `isProvablyDead`, and a caller that widened one
   *  without the other would gate on a different horizon than it reaps at. */
  staleAfterMs?: number;
}): Promise<boolean> => {
  const now = new Date();

  // Nothing below runs without a won claim. A `null` here is not a failure: it means the row
  // settled itself, its heartbeat is fresh after all, or another instance is already reaping it
  // — and in all three the correct action is to do nothing.
  const row = await claimDeadStream({ messageId, staleAfterMs });
  if (row === null) return false;

  try {
    const payload = buildAssistantPersistencePayload(row.messageId, await recoverParts(row));
    const structuredContent = payload.uiMessage.parts.length > 0
      ? await extractStructuredContentFromParts(payload.uiMessage.parts, payload.content)
      : payload.content;
    const toolCallsJson = payload.toolCalls ? JSON.stringify(payload.toolCalls) : null;
    const toolResultsJson = payload.toolResults ? JSON.stringify(payload.toolResults) : null;

    const globalOwnerId = parseGlobalChannelId(row.channelId);

    if (globalOwnerId !== null) {
      // Repository-owned CAS terminal write (#2022 invariant preserved:
      // `setWhere status = 'streaming'` inside the method) — bumps rev and
      // emits `conversation:message_updated` when the write lands.
      await messageRepository.materializeGlobalInterruptedMessage({
        messageId: row.messageId,
        conversationId: row.conversationId,
        userId: row.userId,
        structuredContent,
        toolCallsJson,
        toolResultsJson,
        // Only reached if the placeholder insert (PR 2's seam) never happened — the stream's
        // actual start, not reap time, so a recovered reply still sorts correctly against a
        // user's later follow-up message.
        createdAt: row.startedAt,
        eventMessage: payload.uiMessage,
      });

      // The route's own terminal writes bump this after every persist
      // (execute-end, onFinish) — the materializer is a terminal write by a
      // different door and must not skip it, or the recovered conversation
      // sorts stale in the history list (#2153). Deliberately inside this
      // same try/catch as the message write: a failure here must degrade
      // exactly like a failed write, leaving the row `'streaming'` for the
      // next sweep to retry, not a half-materialized row whose session gets
      // settled anyway.
      await messageRepository.recomputeLastMessageAt(row.conversationId);
    } else {
      // Repository-owned CAS terminal write; returns whether the CAS landed.
      // When false, the row already left 'streaming' via one of the route's
      // own terminal writes — and the route guarantees whichever of those
      // lands first carries this exact notification behind the same gate
      // (`mentionNotifyFor` + its once-flag, route.ts; Codex P2 on PR #2097)
      // — so notifying again here would double-page the mentioned user.
      const written = await messageRepository.materializePageInterruptedMessage({
        messageId: row.messageId,
        pageId: row.channelId,
        conversationId: row.conversationId,
        structuredContent,
        toolCallsJson,
        toolResultsJson,
        // Only reached if the placeholder insert (PR 2's seam) never happened — the stream's
        // actual start, not reap time, so a recovered reply still sorts correctly against a
        // user's later follow-up message.
        createdAt: row.startedAt,
        eventMessage: payload.uiMessage,
      });

      // Same gate order as the repository's own save path: assistant role is implicit here,
      // and the content.trim() check keeps an empty recovered reply (no parts survived) from
      // paying for two gate lookups that can never produce a mention. Fire-and-forget, like
      // the finalize path's own `void notifyMentionedUsers` — the helper never rejects.
      if (written && payload.content.trim()) {
        void notifyMentionsBestEffort(row, payload.content);
      }
    }
  } catch (error) {
    loggers.ai.warn('materializeInterruptedStream: message upsert failed', {
      messageId: row.messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    // Leave the session row at 'streaming' — the next sweep (takeover, reconciler, or the
    // active-streams lazy pass) will find this row again and retry the whole thing. Settling
    // it here would report the stream over while its reply was never actually saved.
    return false;
  }

  // The message write is CONFIRMED — the try above returns early on any failure — so the
  // frames have done their job and become storage. Released here and nowhere earlier: this is
  // the one point on this path where a durable `messages` row provably holds the reply, and
  // deleting before it would throw away the only copy of a reply nothing else recorded.
  //
  // Deliberately before the session-row settle rather than after. Settling can fail (it is
  // conditional, and its own catch swallows), and this function is retried by the next sweep;
  // a retry re-reads no frames and falls back to `parts`, which is the same content one fold
  // earlier. Ordering it the other way would leave frames behind on exactly the rows that get
  // retried most.
  await releaseFramesForMessage(row.messageId, { kind: 'reap-claim', claim: row });

  let settled: boolean;
  try {
    const result = await db
      .update(aiStreamSessions)
      .set({ status: 'aborted', completedAt: now, parts: [], rawPartsCount: 0, abortRequestedAt: null })
      // THE FENCE, not merely `status = 'streaming'`. That predicate alone cannot stop the
      // write this function exists to make safe: a LIVE owner has not changed its status, so a
      // reaper that misjudged it would win a status-only CAS every time and settle a generating
      // stream to `aborted` with `parts: []` — hiding it from /active-streams, making it
      // unjoinable, and making it un-Stoppable (`markAbortRequested` carries
      // `eq(status,'streaming')`). `reapClaimFence` adds the two clauses that CAN say no: we
      // still hold the claim, and the owner has not beaten since we took it.
      .where(reapClaimFence(row));
    // A conditional UPDATE that matches zero rows does not throw — it succeeds and changes
    // nothing. Under the fence that now means one of two things, and BOTH are correct outcomes:
    // the row already left 'streaming' by another path, or the fence itself said no (the claim
    // was superseded, or the owner beat again and was never dead). `rowCount` is the only way to
    // tell "I settled it" from "I was fenced off" — matching the established pattern for the
    // same class of conditional update (compaction-repository.ts).
    settled = (result.rowCount ?? 0) > 0;
  } catch (error) {
    settled = false;
    loggers.ai.warn('materializeInterruptedStream: could not settle session row', {
      messageId: row.messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }

  const streamCompletePayload = {
    messageId: row.messageId,
    pageId: row.channelId,
    conversationId: row.conversationId,
    aborted: true,
  };
  broadcastAiStreamComplete(streamCompletePayload).catch((error) => {
    loggers.ai.warn('materializeInterruptedStream: broadcast failed', {
      messageId: row.messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  });
  // Transitional conv-room mirror — same as stream-lifecycle.ts's finish().
  conversationEvents
    .streamLifecycleMirror(row.conversationId, 'chat:stream_complete', streamCompletePayload)
    .catch(() => {});

  return settled;
};
