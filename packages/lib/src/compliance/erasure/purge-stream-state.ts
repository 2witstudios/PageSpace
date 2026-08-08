/**
 * Art 17 erasure of the subject's AI STREAM STATE — the half the FK graph
 * cannot reach.
 *
 * Found while auditing the cascade paths that migrations 0249/0250 changed
 * (epic "Agent-Session Single Source of Truth", Phase 4 / D6, PR 13).
 *
 * `ai_stream_sessions` rows carry `parts` — a periodic checkpoint of the
 * generated `UIMessagePart[]` buffer, i.e. message CONTENT — plus the
 * streamer's `user_id`, display name and browser session id. Nothing in this
 * repository has ever deleted a row of that table: no retention sweep, no TTL,
 * no erasure step, and (before 0250) no foreign key of any kind.
 *
 * 0250 gave it `conversation_id → conversations ON DELETE CASCADE`, which
 * closed most of the hole: erasing a user deletes their `conversations` rows
 * (`conversations.userId` cascades from `users`), and those now take the
 * stream state with them. What it does NOT close is the CROSS-USER residue:
 *
 *   - a SHARED page conversation accepts messages, and therefore streams, from
 *     any member who can access it (`apps/web/src/app/api/ai/chat/route.ts` —
 *     "owner OR shared"). Those rows carry the MEMBER's `user_id` inside the
 *     OWNER's conversation, so erasing the member leaves them behind;
 *   - `ai_pending_abort_intents` has no foreign key at all — not to
 *     `conversations`, not to `users` — so every intent row survives erasure
 *     regardless of who owns the conversation;
 *   - 0250's FK is `NOT VALID`, so rows whose conversation was hard-deleted
 *     before it landed still dangle and are unreachable by any cascade.
 *
 * All three are keyed by `user_id`, which is exactly what this step deletes.
 * It is deliberately user-scoped and NOT conversation-scoped: the cascade
 * already covers the conversation-scoped case, and doing it twice is harmless
 * (both are idempotent DELETEs) while doing neither retains content forever.
 *
 * Ordering: runs BEFORE `delete-user`, so the evidence lands on the DSR row
 * while the subject still exists. Neither table references `users`, so the
 * order is a reporting choice, not a referential requirement.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { aiStreamSessions, aiPendingAbortIntents } from '@pagespace/db/schema/ai-streams';

export interface StreamStateErasureResult {
  /** `ai_stream_sessions` rows deleted (each may hold checkpointed content). */
  streamSessions: number;
  /** `ai_pending_abort_intents` rows deleted. */
  abortIntents: number;
}

/**
 * Delete every AI stream row the subject owns, in both stream tables.
 *
 * Sequential rather than concurrent: `ai_stream_sessions` is a cascade target
 * of `conversations`, and running user-scoped deletes alongside other erasure
 * statements over overlapping rows is the deadlock shape retention had to
 * avoid too. Erasure is not latency-sensitive.
 */
export async function deleteStreamStateForUser(userId: string): Promise<StreamStateErasureResult> {
  const streams = await db
    .delete(aiStreamSessions)
    .where(eq(aiStreamSessions.userId, userId))
    .returning({ messageId: aiStreamSessions.messageId });

  const intents = await db
    .delete(aiPendingAbortIntents)
    .where(eq(aiPendingAbortIntents.userId, userId))
    .returning({ conversationId: aiPendingAbortIntents.conversationId });

  return { streamSessions: streams.length, abortIntents: intents.length };
}
