/**
 * Unified history-preparation seam.
 *
 * Centralizes the three-step pipeline that every chat route must run before
 * passing messages to the model:
 *
 *   sanitizeMessagesForModel
 *     → prepareConversationContext   (sliding-window compaction, admin-gated)
 *     → elideStaleToolOutputs        (stale read-tool outputs → deterministic stub)
 *
 * Returns the elided UIMessage tail plus metadata needed by each route
 * (summaryText, stableBoundaryIndex for cache breakpoints, scheduleCompaction).
 * Each route still calls convertToModelMessages — kept separate because routes
 * differ in their pre-conversion steps (visual-content injection, tool set).
 */

import type { UIMessage } from 'ai';
import { sanitizeMessagesForModel } from '@/lib/ai/core/message-utils';
import {
  prepareConversationContext,
  type PrepareConversationContextParams,
  type PreparedContext,
} from '@/lib/ai/core/compaction/prepare-context';
import {
  isSyntheticSummaryMessage,
  type CompactionMessage,
} from '@pagespace/lib/ai/context-window';
import {
  computeElisionBoundary,
  elideStaleToolOutputs,
  DEFAULT_ELIDABLE_TOOLS,
  type ElisionMessage,
} from '@pagespace/lib/ai/tool-result-eliding';
import { WRITE_TOOLS } from '@/lib/ai/core/tool-filtering';

// ─── Elision config ────────────────────────────────────────────────────────────

const ELISION_KEEP_LAST_TURNS = 4;
const ELISION_CHUNK_SIZE = 8;
const ELISION_MIN_OUTPUT_CHARS = 1000;

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface PrepareHistoryParams extends Omit<PrepareConversationContextParams, 'messages'> {
  /** Full UIMessage history as loaded from the database. */
  history: UIMessage[];
}

export interface PrepareHistoryResult {
  /**
   * Sanitized, compacted, and elided UIMessages — the tail that each route
   * converts to ModelMessages via convertToModelMessages.
   */
  messages: UIMessage[];
  /**
   * Non-empty when sliding-window compaction added a synthetic summary.
   * Routes must prepend `{ role: 'user', content: summaryText }` before
   * the converted tail ModelMessages.
   */
  summaryText: string;
  /**
   * Index into the future ModelMessages array where the stable cross-request
   * cache region begins.
   *   1 — when a summary exists (summary is at index 0, first tail msg at 1)
   *   0 — no stable boundary (withCacheBreakpoints skips B when < 1)
   * Feed into withCacheBreakpoints(modelMessages, stableBoundaryIndex).
   */
  stableBoundaryIndex: number;
  /** Schedule compaction via after() — for top-level route handlers. */
  scheduleCompaction: () => void;
  /** Ready-to-use compaction params for tool-execution contexts where after() is unavailable. */
  pendingCompaction: PreparedContext['pendingCompaction'];
}

// ─── Seam ──────────────────────────────────────────────────────────────────────

/**
 * Prepare conversation history for model consumption.
 *
 * Composition order (all three steps must remain in this order):
 *  1. sanitizeMessagesForModel  — strips incomplete tool pairs, removes system role
 *  2. prepareConversationContext — sliding-window compaction (admin-gated passthrough for others)
 *  3. elideStaleToolOutputs     — chunk-aligned output elision on the retained tail
 *
 * The stableBoundaryIndex returned here and the elision boundary are designed to
 * coincide: when a compaction summary exists (stableBoundaryIndex=1) the elision
 * boundary is set to 0 (no additional tail elision on top of compaction); when
 * there is no summary the chunk-aligned elision boundary directly controls which
 * old tool outputs become deterministic stubs — stable bytes that survive the
 * prefix cache.
 */
export async function prepareHistoryForModel(
  params: PrepareHistoryParams,
): Promise<PrepareHistoryResult> {
  const { history, ...compactionParams } = params;

  // Step 1: sanitize
  const sanitized = sanitizeMessagesForModel(history);

  // Step 2: compaction (admin-gated; non-admin is a passthrough)
  // UIMessage and CompactionMessage are structurally compatible today; the explicit
  // cast (instead of `as never`) makes future shape drift a TypeScript error here
  // rather than a silent runtime mismatch.
  const { messages: compacted, scheduleCompaction, pendingCompaction } =
    await prepareConversationContext({
      messages: sanitized as CompactionMessage[],
      ...compactionParams,
    });

  // Detect whether compaction prepended a synthetic summary. The sentinel check
  // (no DB id + <conversation_summary> prefix) lives in isSyntheticSummaryMessage
  // so this seam and the v1 route cannot drift apart.
  const hasSummary = compacted.length > 0 && isSyntheticSummaryMessage(compacted[0]);
  const summaryText = hasSummary
    ? (compacted[0].parts?.find((p) => p.type === 'text')?.text ?? '')
    : '';
  const tailUIMessages = (hasSummary ? compacted.slice(1) : compacted) as UIMessage[];

  // Step 3: elide stale tool outputs from the tail
  //
  // Boundary coincidence rule:
  //  - If a summary exists, the early turns are already condensed; set compactionPointer=0
  //    so elision is a no-op on the tail (stableBoundaryIndex=1 serves as the B breakpoint).
  //  - Otherwise, compute a chunk-aligned boundary from the tail's assistant turn count.
  const assistantTurnCount = tailUIMessages.filter((m) => m.role === 'assistant').length;
  const compactionPointer: number | undefined = hasSummary ? 0 : undefined;

  const elisionBoundary = computeElisionBoundary(assistantTurnCount, {
    keepLastTurns: ELISION_KEEP_LAST_TURNS,
    chunkSize: ELISION_CHUNK_SIZE,
    compactionPointer,
  });

  const elidedMessages: UIMessage[] =
    elisionBoundary > 0
      ? (elideStaleToolOutputs(tailUIMessages as ElisionMessage[], {
          elisionBoundaryTurnIndex: elisionBoundary,
          minOutputChars: ELISION_MIN_OUTPUT_CHARS,
          elidableTools: new Set(DEFAULT_ELIDABLE_TOOLS),
          writeTools: WRITE_TOOLS,
        }) as UIMessage[])
      : tailUIMessages;

  // stableBoundaryIndex: 1 when summary exists (summary is at future ModelMessages[0],
  // first tail message is at [1] — the stable cross-request cache breakpoint B).
  // 0 → withCacheBreakpoints skips B.
  const stableBoundaryIndex = hasSummary ? 1 : 0;

  return {
    messages: elidedMessages,
    summaryText,
    stableBoundaryIndex,
    scheduleCompaction,
    pendingCompaction,
  };
}
