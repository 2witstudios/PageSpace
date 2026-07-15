import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { chatMessages } from '@pagespace/db/schema/core';
import { messages } from '@pagespace/db/schema/conversations';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { parseGlobalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { broadcastAiStreamComplete } from '@/lib/websocket';
import { buildAssistantPersistencePayload } from '@/lib/ai/core/persistAssistantParts';
import { extractStructuredContentFromParts } from '@/lib/ai/core/message-utils';
import type { UIMessagePart } from '@/lib/ai/core/stream-multicast-registry';

/**
 * An `ai_stream_sessions` row the CALLER has already proven dead (`isProvablyDead` —
 * stream-liveness.ts). This module does not re-derive eligibility; it only re-guards the
 * one invariant that survives even a correct eligibility call: the #2022 race where the old
 * worker's own terminal write lands between the caller's read and this write.
 */
export interface MaterializableStreamRow {
  messageId: string;
  /** The stream's channel — a real pageId for page-chat, or a synthetic `user:<id>:global`
   *  id for the global assistant (see `parseGlobalChannelId`). Decides which message table
   *  this row belongs to. */
  channelId: string;
  conversationId: string;
  /** The stream's owner. For a global-assistant row this doubles as `messages.userId`
   *  (NOT NULL there) — the same field the normal save path already uses. */
  userId: string;
  /** The last debounced parts snapshot — possibly stale by up to one checkpoint interval,
   *  never by more (see PR 1's time-based cadence). This is the only content a dead process
   *  leaves behind; there is no live buffer to fall back to. */
  parts: unknown[];
  /** The stream's actual start time. Used ONLY as the `createdAt` for the defensive
   *  insert-if-missing branch below (the placeholder row should already exist per PR 2, but a
   *  failed placeholder insert is the one case this function must still degrade gracefully
   *  for) — never reap/takeover time, or a recovered reply can sort after a user's later
   *  follow-up message that was saved in the interim. */
  startedAt: Date;
}

/**
 * Turn a provably-dead stream into an honest, terminal assistant message instead of a
 * silent loss.
 *
 * Three things happen, in an order chosen so a failure at any step leaves the row eligible
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
 *      row would read terminal while no terminal message ever got written.
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
export const materializeInterruptedStream = async (row: MaterializableStreamRow): Promise<boolean> => {
  const now = new Date();

  try {
    const payload = buildAssistantPersistencePayload(row.messageId, row.parts as UIMessagePart[]);
    const structuredContent = payload.uiMessage.parts.length > 0
      ? await extractStructuredContentFromParts(payload.uiMessage.parts, payload.content)
      : payload.content;
    const toolCallsJson = payload.toolCalls ? JSON.stringify(payload.toolCalls) : null;
    const toolResultsJson = payload.toolResults ? JSON.stringify(payload.toolResults) : null;

    const globalOwnerId = parseGlobalChannelId(row.channelId);

    if (globalOwnerId !== null) {
      await db
        .insert(messages)
        .values({
          id: row.messageId,
          conversationId: row.conversationId,
          userId: row.userId,
          role: 'assistant',
          content: structuredContent,
          toolCalls: toolCallsJson,
          toolResults: toolResultsJson,
          // Only reached if the placeholder insert (PR 2's seam) never happened — the stream's
          // actual start, not reap time, so a recovered reply still sorts correctly against a
          // user's later follow-up message.
          createdAt: row.startedAt,
          isActive: true,
          status: 'interrupted',
        })
        .onConflictDoUpdate({
          target: messages.id,
          set: {
            content: structuredContent,
            toolCalls: toolCallsJson,
            toolResults: toolResultsJson,
            // Re-synced on conflict, mirroring saveMessageToDatabase's own update-set — a
            // message reprocessed/reparented into a different conversation before this sweep
            // ran should not have its conversationId left stale.
            conversationId: row.conversationId,
            status: 'interrupted',
          },
          // The #2022 invariant, enforced atomically as a compare-and-swap: only a row still
          // `'streaming'` may be relabelled. Never re-touch a row already `'interrupted'` or
          // `'complete'` — see the docblock above for why `!= 'complete'` alone isn't enough.
          setWhere: eq(messages.status, 'streaming'),
        });
    } else {
      await db
        .insert(chatMessages)
        .values({
          id: row.messageId,
          pageId: row.channelId,
          conversationId: row.conversationId,
          role: 'assistant',
          content: structuredContent,
          toolCalls: toolCallsJson,
          toolResults: toolResultsJson,
          // Only reached if the placeholder insert (PR 2's seam) never happened — the stream's
          // actual start, not reap time, so a recovered reply still sorts correctly against a
          // user's later follow-up message.
          createdAt: row.startedAt,
          isActive: true,
          userId: null,
          sourceAgentId: null,
          status: 'interrupted',
        })
        .onConflictDoUpdate({
          target: chatMessages.id,
          set: {
            content: structuredContent,
            toolCalls: toolCallsJson,
            toolResults: toolResultsJson,
            conversationId: row.conversationId,
            status: 'interrupted',
          },
          setWhere: eq(chatMessages.status, 'streaming'),
        });
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

  let settled = true;
  try {
    await db
      .update(aiStreamSessions)
      .set({ status: 'aborted', completedAt: now, parts: [], rawPartsCount: 0, abortRequestedAt: null })
      .where(and(
        eq(aiStreamSessions.messageId, row.messageId),
        // Conditional so a row that reached a terminal status by some other path between the
        // caller's read and here is not retroactively relabelled.
        eq(aiStreamSessions.status, 'streaming'),
      ));
  } catch (error) {
    settled = false;
    loggers.ai.warn('materializeInterruptedStream: could not settle session row', {
      messageId: row.messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }

  broadcastAiStreamComplete({
    messageId: row.messageId,
    pageId: row.channelId,
    conversationId: row.conversationId,
    aborted: true,
  }).catch((error) => {
    loggers.ai.warn('materializeInterruptedStream: broadcast failed', {
      messageId: row.messageId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  });

  return settled;
};
