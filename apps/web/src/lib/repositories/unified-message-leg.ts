/**
 * THE PAGE-MESSAGE WRITER — the one place that writes `messages` on behalf of
 * a page-chat row (epic "Agent-Session Single Source of Truth", Phase 4 / D6).
 *
 * `chat_messages` was merged INTO `messages` across Phase 4 and DROPPED at
 * PR 15 (migration 0253). There is ONE message table and this module holds the
 * page-chat statements against it; global-assistant rows do not come through
 * here — their leg has always been `messages` itself, written directly by
 * message-repository.ts.
 *
 * The name still says "leg" because that is what these functions write — the
 * unified leg of a page message. Two rules this module used to enforce are
 * retired with the second leg, and the reasoning is worth keeping:
 *
 *   1. "THE UNIFIED LEG MUST NEVER BREAK A WRITE THAT WORKS TODAY" bought
 *      safety by SKIPPING the unified write when no `conversations` row
 *      existed, because the legacy leg would still carry the message. With one
 *      leg, skipping would mean silently losing the user's message — the
 *      failure mode that rule was written to prevent, inverted. The probe is
 *      gone and the FK (`messages_conversationId_conversations_id_fk`) refuses
 *      the write instead, aborting the transaction and surfacing the failure.
 *
 *   2. "A MUTATION THAT MATCHES NOTHING IS NORMAL" still holds, for a
 *      narrower reason: the historical corpus was carried across before the
 *      drop (`scripts/backfill-unify-messages.ts`, and migration 0253's own
 *      final sweep and completeness guard), so a zero-row edit/soft-delete now
 *      means the message id does not exist at all. It is still silent rather
 *      than fatal — the callers' own reads decide whether a missing message is
 *      an error, and they read this table.
 *
 * A page row carries no page column: PR 15 dropped `messages.pageId` with the
 * legacy table, and a row's page is now derived from its conversation
 * (`unified-message-scope.ts`). `sourceAgentId` names the AUTHORING agent, not
 * the thread's page, and `userId` is NULL for an agent-authored row.
 */

import { eq, and } from '@pagespace/db/operators';
import { messages } from '@pagespace/db/schema/conversations';
import type { DbExecutor } from '@/lib/repositories/conversation-rev';

/** What the write did, for the caller's control flow/logging/tests. */
export type UnifiedLegOutcome =
  /** Written (inserted or upserted). */
  | 'written'
  /** The statement matched no row (a scoped upsert's conflict gate declined, or a CAS lost). */
  | 'no_match';

export interface UnifiedPageMessageRow {
  messageId: string;
  conversationId: string;
  userId: string | null;
  role: string;
  /** Already structured/extracted by the caller. */
  content: string;
  /** Pre-serialized (JSON string or null). */
  toolCallsJson: string | null;
  toolResultsJson: string | null;
  sourceAgentId: string | null;
  status: 'streaming' | 'complete' | 'interrupted';
  /** Omit to let the column default to now(). */
  createdAt?: Date;
}

/**
 * The scoped upsert for a page message. The `WHERE conversationId = … AND
 * role = …` gate on the conflict action is the collision defence inherited
 * verbatim from the legacy statement: a client-supplied id that collides with
 * a row in ANOTHER conversation (ids are one global space) declines the
 * conflict action rather than re-parenting or overwriting it, and the role
 * half closes same-conversation role spoofing.
 *
 * `no_match` means the gate declined — which is now a REJECTED WRITE, not a
 * one-leg-of-two discrepancy. The caller throws
 * `MessageConversationConflictError` on it, exactly as it did when the legacy
 * statement was the one holding the gate.
 */
export async function upsertUnifiedPageMessage(
  tx: DbExecutor,
  row: UnifiedPageMessageRow,
): Promise<UnifiedLegOutcome> {
  const written = await tx
    .insert(messages)
    .values({
      id: row.messageId,
      conversationId: row.conversationId,
      userId: row.userId,
      role: row.role,
      content: row.content,
      toolCalls: row.toolCallsJson,
      toolResults: row.toolResultsJson,
      createdAt: row.createdAt ?? new Date(),
      isActive: true,
      status: row.status,
      sourceAgentId: row.sourceAgentId,
    })
    .onConflictDoUpdate({
      target: messages.id,
      set: {
        content: row.content,
        toolCalls: row.toolCallsJson,
        toolResults: row.toolResultsJson,
        sourceAgentId: row.sourceAgentId,
        // Terminal write: flips a 'streaming' placeholder to
        // 'complete'/'interrupted', never back to 'streaming'.
        status: row.status,
      },
      where: and(eq(messages.conversationId, row.conversationId), eq(messages.role, row.role)),
    })
    .returning({ id: messages.id });

  // Reported, not logged: the caller has the page id and the surrounding
  // context, and it is the caller that turns this into a thrown
  // `MessageConversationConflictError`. Logging here too would double every
  // collision in the ai logs.
  return written.length === 0 ? 'no_match' : 'written';
}

/**
 * The interrupted-stream materializer's CAS write: the
 * `setWhere status = 'streaming'` guard means only a row still streaming can
 * be relabelled (#2022's invariant). `no_match` — the row is already terminal
 * — is the caller's cue that the write did not land.
 */
export async function materializeUnifiedPageMessage(
  tx: DbExecutor,
  row: UnifiedPageMessageRow,
): Promise<UnifiedLegOutcome> {
  const written = await tx
    .insert(messages)
    .values({
      id: row.messageId,
      conversationId: row.conversationId,
      userId: row.userId,
      role: row.role,
      content: row.content,
      toolCalls: row.toolCallsJson,
      toolResults: row.toolResultsJson,
      createdAt: row.createdAt ?? new Date(),
      isActive: true,
      status: row.status,
      sourceAgentId: row.sourceAgentId,
    })
    .onConflictDoUpdate({
      target: messages.id,
      set: {
        content: row.content,
        toolCalls: row.toolCallsJson,
        toolResults: row.toolResultsJson,
        conversationId: row.conversationId,
        status: row.status,
      },
      setWhere: eq(messages.status, 'streaming'),
    })
    .returning({ id: messages.id });

  return written.length === 0 ? 'no_match' : 'written';
}

/**
 * A plain INSERT (the 'streaming' placeholder). Separate from the upsert
 * because there is no conflict clause: a duplicate placeholder id is a bug
 * that must surface, not be absorbed.
 */
export async function insertUnifiedPageMessage(
  tx: DbExecutor,
  row: UnifiedPageMessageRow,
): Promise<UnifiedLegOutcome> {
  await tx.insert(messages).values({
    id: row.messageId,
    conversationId: row.conversationId,
    userId: row.userId,
    role: row.role,
    content: row.content,
    toolCalls: row.toolCallsJson,
    toolResults: row.toolResultsJson,
    ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    isActive: true,
    status: row.status,
    sourceAgentId: row.sourceAgentId,
  });
  return 'written';
}

/**
 * A single-message mutation (edit, soft-delete, tool-result backfill). An
 * UPDATE that matches nothing is a no-op and stays silent — see rule 2 in the
 * header.
 */
export async function mutateUnifiedMessageById(
  tx: DbExecutor,
  messageId: string,
  set: Partial<{ content: string; editedAt: Date; isActive: boolean; toolResults: string }>,
  /** Extra scoping some callers apply, so the statement matches one thread only. */
  opts?: { conversationId?: string },
): Promise<UnifiedLegOutcome> {
  const scope = opts?.conversationId
    ? and(eq(messages.id, messageId), eq(messages.conversationId, opts.conversationId))
    : eq(messages.id, messageId);
  const updated = await tx.update(messages).set(set).where(scope).returning({ id: messages.id });
  return updated.length === 0 ? 'no_match' : 'written';
}

/**
 * A CONVERSATION-WIDE message mutation — the history soft-delete cascade in
 * conversation-repository.ts, which tombstones every message under a deleted
 * conversation.
 *
 * Scoped by `conversationId` ALONE: a conversation's page is already implied
 * by its id, and there is no page column left to scope by.
 */
export async function deactivateUnifiedMessagesForConversation(
  tx: DbExecutor,
  conversationId: string,
): Promise<UnifiedLegOutcome> {
  const updated = await tx
    .update(messages)
    .set({ isActive: false })
    .where(and(eq(messages.conversationId, conversationId), eq(messages.isActive, true)))
    .returning({ id: messages.id });
  return updated.length === 0 ? 'no_match' : 'written';
}

/**
 * Serialize tool calls/results the way the table stores them. Exported so a
 * caller can build the value once and hand the identical string to the write
 * and to anything that mirrors it.
 */
export function serializeJsonColumn(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}
