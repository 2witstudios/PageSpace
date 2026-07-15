import { db } from '@pagespace/db/db';
import { and, eq, ne } from '@pagespace/db/operators';
import { aiStreamSessions } from '@pagespace/db/schema/ai-streams';
import { chatMessages } from '@pagespace/db/schema/core';
import { messages } from '@pagespace/db/schema/conversations';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { parseGlobalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { broadcastAiStreamComplete } from '@/lib/websocket';
import { buildAssistantPersistencePayload } from '@/lib/ai/core/persistAssistantParts';
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
}

/**
 * Turn a provably-dead stream into an honest, terminal assistant message instead of a
 * silent loss.
 *
 * Three things happen, in an order chosen so a failure at any step leaves the row eligible
 * for the NEXT sweep to retry rather than half-materialized:
 *
 *   1. Build the message payload from the parts snapshot (`buildAssistantPersistencePayload`
 *      — the same primitive execute-end and onFinish already use, so a materialized reply
 *      renders identically to one the model actually finished).
 *   2. Upsert the assistant message row as `status: 'interrupted'` — but ONLY if it is not
 *      already `'complete'`. That guard is the #2022 invariant: the old worker's own
 *      terminal write is fire-and-forget and can land in the gap between the caller's
 *      liveness read and this write. A `setWhere` on the conflict clause makes the guard
 *      atomic — there is no separate read to race.
 *   3. Only once the message write is confirmed: settle the `ai_stream_sessions` row
 *      terminal (`status: 'aborted'`, parts cleared) and broadcast `stream_complete`.
 *      Settling first would let a crashed sweep lose the row's only content — the session
 *      row would read terminal while no terminal message ever got written.
 *
 * Never throws. Every step logs and degrades — a reap that fails partway must not take
 * down the caller's loop over the rest of its batch (takeover, the abort-mark reconciler,
 * and the active-streams lazy sweep all call this per-row, in a loop).
 */
export const materializeInterruptedStream = async (row: MaterializableStreamRow): Promise<void> => {
  const payload = buildAssistantPersistencePayload(row.messageId, row.parts as UIMessagePart[]);
  const toolCallsJson = payload.toolCalls ? JSON.stringify(payload.toolCalls) : null;
  const toolResultsJson = payload.toolResults ? JSON.stringify(payload.toolResults) : null;
  const now = new Date();

  try {
    const globalOwnerId = parseGlobalChannelId(row.channelId);

    if (globalOwnerId !== null) {
      await db
        .insert(messages)
        .values({
          id: row.messageId,
          conversationId: row.conversationId,
          userId: row.userId,
          role: 'assistant',
          content: payload.content,
          toolCalls: toolCallsJson,
          toolResults: toolResultsJson,
          createdAt: now,
          isActive: true,
          status: 'interrupted',
        })
        .onConflictDoUpdate({
          target: messages.id,
          set: {
            content: payload.content,
            toolCalls: toolCallsJson,
            toolResults: toolResultsJson,
            status: 'interrupted',
          },
          // The #2022 invariant, enforced atomically: never relabel a row the normal
          // terminal path already finished.
          setWhere: ne(messages.status, 'complete'),
        });
    } else {
      await db
        .insert(chatMessages)
        .values({
          id: row.messageId,
          pageId: row.channelId,
          conversationId: row.conversationId,
          role: 'assistant',
          content: payload.content,
          toolCalls: toolCallsJson,
          toolResults: toolResultsJson,
          createdAt: now,
          isActive: true,
          userId: null,
          sourceAgentId: null,
          status: 'interrupted',
        })
        .onConflictDoUpdate({
          target: chatMessages.id,
          set: {
            content: payload.content,
            toolCalls: toolCallsJson,
            toolResults: toolResultsJson,
            status: 'interrupted',
          },
          setWhere: ne(chatMessages.status, 'complete'),
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
    return;
  }

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
  }).catch(() => {});
};
