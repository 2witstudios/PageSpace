/**
 * THE UNIFIED LEG — the one place that writes `messages` on behalf of a
 * page-chat row (epic "Agent-Session Single Source of Truth", Phase 4 / D6;
 * plan Phase 4 PR 10).
 *
 * `chat_messages` is being merged INTO `messages`. This is the expand-phase
 * dual-write: every durable page-chat write keeps landing in `chat_messages`
 * (the LEGACY leg — still the only leg any reader looks at; the reader
 * cutover is PRs 11/12) and additionally lands in `messages` (the UNIFIED
 * leg) inside the SAME transaction, so the two can never disagree about a
 * write that committed.
 *
 * Column mapping for a page row (migration 0248 supplied the target columns):
 *   chat_messages.pageId        → messages.pageId        (TRANSITIONAL — the
 *                                 authoritative link stays
 *                                 conversations.contextId; dropped at PR 15)
 *   chat_messages.sourceAgentId → messages.sourceAgentId
 *   chat_messages.userId (NULL) → messages.userId        (relaxed to nullable
 *                                 by 0248, so agent-authored rows copy as-is)
 * Everything else is column-identical.
 *
 * GLOBAL-assistant rows are not dual-written and never appear here: their
 * ONE leg has always been `messages` itself. They only had to start carrying
 * the new columns coherently — `pageId` stays NULL (see
 * `assertGlobalRowShape`'s doc in message-repository.ts).
 *
 * ── Two rules this module exists to enforce ───────────────────────────────
 *
 * 1. THE UNIFIED LEG MUST NEVER BREAK A WRITE THAT WORKS TODAY. The expand
 *    phase is additive: a page message that persists on master must persist
 *    here. The one way the unified leg can fail where the legacy leg cannot
 *    is `messages_conversationId_conversations_id_fk` — `messages` has a real
 *    (validated) FK to `conversations`, `chat_messages`'s equivalent FK is
 *    `NOT VALID` and its column was self-minting for its whole history. So an
 *    INSERT path checks for the conversation row first and, when it is
 *    genuinely absent, SKIPS the unified leg with an error-level log instead
 *    of aborting the transaction and losing the user's message. That case is
 *    supposed to be unreachable — the chat routes create/claim the row in the
 *    same transaction, and PR 10 also made the eager create fail-closed — so
 *    it is logged loudly and counted by the reconcile cron, never swallowed.
 *
 * 2. A MUTATION THAT MATCHES NOTHING IS NORMAL, NOT AN ERROR. Until
 *    `scripts/backfill-unify-messages.ts` has run, most historical rows exist
 *    only in the legacy leg, so an edit/soft-delete of an old message updates
 *    0 unified rows. That is the expected shape of the expand window and is
 *    silent; the backfill closes it.
 *
 * The kill switch (`UNIFIED_MESSAGES_DUAL_WRITE=off`) short-circuits every
 * function here and nothing else — the legacy leg is untouched by it.
 */

import { eq, and } from '@pagespace/db/operators';
import { messages, conversations } from '@pagespace/db/schema/conversations';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isUnifiedMessageDualWriteEnabled } from '@/lib/config/unified-messages-env';
import type { DbExecutor } from '@/lib/repositories/conversation-rev';

/** What the unified leg did, for the caller's logging/tests. */
export type UnifiedLegOutcome =
  /** Written (inserted or upserted). */
  | 'written'
  /** `UNIFIED_MESSAGES_DUAL_WRITE=off`. */
  | 'disabled'
  /** No `conversations` row — an INSERT would violate the FK. See rule 1. */
  | 'skipped_no_conversation'
  /** The statement matched no row (a scoped upsert's conflict gate declined). */
  | 'no_match';

export interface UnifiedPageMessageRow {
  messageId: string;
  pageId: string;
  conversationId: string;
  userId: string | null;
  role: string;
  /** Already structured/extracted by the caller — the legs must store the identical string. */
  content: string;
  /** Pre-serialized exactly as written to the legacy leg (JSON string or null). */
  toolCallsJson: string | null;
  toolResultsJson: string | null;
  sourceAgentId: string | null;
  status: 'streaming' | 'complete' | 'interrupted';
  /** Omit to let the column default to now() — matches the legacy leg's shape per call site. */
  createdAt?: Date;
}

/**
 * True when a `conversations` row exists for this id. A PK lookup, and it
 * runs inside the caller's transaction so the answer cannot go stale before
 * the insert it guards (rule 1).
 */
async function conversationRowExists(tx: DbExecutor, conversationId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return row !== undefined;
}

function logSkippedNoConversation(where: string, messageId: string, conversationId: string): void {
  // ERROR, not warn: after PR 10's fail-closed fix to the chat route this is
  // unreachable, so reaching it means a writer creates messages without a
  // conversation row and the unification will be permanently short those rows.
  loggers.ai.error(
    'unifiedMessageLeg: skipped unified write — no conversations row for this message',
    new Error('unified leg skipped: missing conversation'),
    { where, messageId, conversationId },
  );
}

/**
 * The unified twin of `message-repository`'s scoped upsert. Mirrors the
 * legacy statement exactly, INCLUDING the `WHERE conversationId = … AND role
 * = …` gate on the conflict action, so a client-supplied id colliding with a
 * row in another conversation is declined on both legs identically rather
 * than being re-parented on one of them.
 *
 * A declined conflict here (`no_match`) while the legacy leg accepted the
 * write means the id already belongs to a DIFFERENT conversation's row in
 * `messages` — historically only reachable via a global-assistant row, since
 * ids are cuid2 and globally unique. It is logged at error level and does NOT
 * abort: the legacy leg is authoritative for this whole phase, and refusing
 * the user's message because of a unified-leg-only collision would be exactly
 * the regression rule 1 forbids.
 */
export async function upsertUnifiedPageMessage(
  tx: DbExecutor,
  row: UnifiedPageMessageRow,
): Promise<UnifiedLegOutcome> {
  if (!isUnifiedMessageDualWriteEnabled()) return 'disabled';
  if (!(await conversationRowExists(tx, row.conversationId))) {
    logSkippedNoConversation('upsertUnifiedPageMessage', row.messageId, row.conversationId);
    return 'skipped_no_conversation';
  }

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
      pageId: row.pageId,
      sourceAgentId: row.sourceAgentId,
    })
    .onConflictDoUpdate({
      target: messages.id,
      set: {
        content: row.content,
        toolCalls: row.toolCallsJson,
        toolResults: row.toolResultsJson,
        sourceAgentId: row.sourceAgentId,
        status: row.status,
      },
      where: and(eq(messages.conversationId, row.conversationId), eq(messages.role, row.role)),
    })
    .returning({ id: messages.id });

  if (written.length === 0) {
    loggers.ai.error(
      'unifiedMessageLeg: unified upsert declined by its conflict gate while the legacy leg accepted the write',
      new Error('unified leg conflict-gate decline'),
      { messageId: row.messageId, conversationId: row.conversationId },
    );
    return 'no_match';
  }
  return 'written';
}

/**
 * The unified twin of the interrupted-stream materializer's CAS write: the
 * `setWhere status = 'streaming'` guard is mirrored so only a row still
 * streaming can be relabelled on either leg (#2022's invariant).
 */
export async function materializeUnifiedPageMessage(
  tx: DbExecutor,
  row: UnifiedPageMessageRow,
): Promise<UnifiedLegOutcome> {
  if (!isUnifiedMessageDualWriteEnabled()) return 'disabled';
  if (!(await conversationRowExists(tx, row.conversationId))) {
    logSkippedNoConversation('materializeUnifiedPageMessage', row.messageId, row.conversationId);
    return 'skipped_no_conversation';
  }

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
      pageId: row.pageId,
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
 * The unified twin of a plain INSERT (the 'streaming' placeholder). Separate
 * from the upsert because the legacy statement has no conflict clause either
 * — a duplicate placeholder id is a bug that must surface, not be absorbed.
 *
 * `conversationExists` lets a caller that has ALREADY locked/read the
 * conversation row in this transaction (the placeholder paths do a
 * `SELECT … FOR UPDATE`) pass the answer in instead of paying for a second
 * lookup — and, more importantly, keeps the guard consistent with the row
 * version the caller actually decided on.
 */
export async function insertUnifiedPageMessage(
  tx: DbExecutor,
  row: UnifiedPageMessageRow,
  conversationExists: boolean,
): Promise<UnifiedLegOutcome> {
  if (!isUnifiedMessageDualWriteEnabled()) return 'disabled';
  if (!conversationExists) {
    logSkippedNoConversation('insertUnifiedPageMessage', row.messageId, row.conversationId);
    return 'skipped_no_conversation';
  }

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
    pageId: row.pageId,
    sourceAgentId: row.sourceAgentId,
  });
  return 'written';
}

/**
 * Mirror a single-message mutation (edit, soft-delete, tool-result backfill)
 * onto the unified leg. No FK risk — an UPDATE that matches nothing is a
 * no-op — so no conversation probe and no error on zero rows: pre-backfill
 * that is the normal case (rule 2).
 */
export async function mutateUnifiedMessageById(
  tx: DbExecutor,
  messageId: string,
  set: Partial<{ content: string; editedAt: Date; isActive: boolean; toolResults: string }>,
  /** Extra scoping the legacy statement applies, so both legs match the same rows. */
  opts?: { conversationId?: string },
): Promise<UnifiedLegOutcome> {
  if (!isUnifiedMessageDualWriteEnabled()) return 'disabled';
  const scope = opts?.conversationId
    ? and(eq(messages.id, messageId), eq(messages.conversationId, opts.conversationId))
    : eq(messages.id, messageId);
  const updated = await tx.update(messages).set(set).where(scope).returning({ id: messages.id });
  return updated.length === 0 ? 'no_match' : 'written';
}

/**
 * Mirror a CONVERSATION-WIDE message mutation — the history soft-delete
 * cascade in conversation-repository.ts, which tombstones every message under
 * a deleted conversation. Without this leg a post-cutover reader would
 * resurrect messages the user deleted, which is the worst failure mode this
 * whole dual-write exists to prevent.
 *
 * Deliberately scoped by `conversationId` ALONE — never by `pageId`. The
 * legacy cascade has a `pageId` predicate because `chat_messages` has no
 * other page link; on the unified leg `pageId` is the transitional column
 * scheduled for deletion, and a conversation's page is already implied by its
 * id, so keying on it would make the cascade depend on a column PR 15 drops.
 */
export async function deactivateUnifiedMessagesForConversation(
  tx: DbExecutor,
  conversationId: string,
): Promise<UnifiedLegOutcome> {
  if (!isUnifiedMessageDualWriteEnabled()) return 'disabled';
  const updated = await tx
    .update(messages)
    .set({ isActive: false })
    .where(and(eq(messages.conversationId, conversationId), eq(messages.isActive, true)))
    .returning({ id: messages.id });
  return updated.length === 0 ? 'no_match' : 'written';
}

/**
 * Serialize tool calls/results the way both legs must store them. Exported so
 * a caller can hand the IDENTICAL string to each leg rather than stringifying
 * twice — two `JSON.stringify` calls on the same object are equal today, but
 * "the legs share one serialization" is the property worth pinning.
 */
export function serializeJsonColumn(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}
